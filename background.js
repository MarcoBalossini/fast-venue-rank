// Background resolver: cache -> local tables -> Semantic Scholar -> Crossref.
// Every ranking comes from local tables (bundled, or newer ones from the weekly catalog check); the
// network is only used to identify the venue of a paper.
// Runs as a service worker in Chrome (importScripts) and as an event page in Firefox
// (libs are listed before this file in manifest background.scripts).

if (typeof importScripts === 'function') {
  importScripts('lib/compat.js', 'lib/normalize.js', 'lib/rankings.js', 'lib/catalog.js');
}

const DEFAULTS = { ext_on: true, SJR: true, CORE: true, hiddenLists: [], crossrefMailto: '', s2ApiKey: '', catalogAuto: true, catalogUrl: '' };
const FETCH_TIMEOUT_MS = 8000;
const MAX_RETRIES = 2;
const TTL_POSITIVE_MS = 60 * 24 * 3600 * 1000;
const TTL_NEGATIVE_MS = 7 * 24 * 3600 * 1000;
const MAX_CACHE_ENTRIES = 5000;
const CACHE_VERSION = 3;   // bump when the result shape / matching rules change so stale rows are ignored

const S2_API = 'https://api.semanticscholar.org/graph/v1/paper/search/match';
const S2_FIELDS = 'title,venue,publicationVenue,externalIds,year,publicationTypes,url';
const CROSSREF_API = 'https://api.crossref.org/works';

// ---------------------------------------------------------------- settings

let settingsCache = null;
async function getSettings() {
  if (!settingsCache) {
    const stored = await api.storage.sync.get(DEFAULTS);
    settingsCache = { ...DEFAULTS, ...stored };
  }
  return settingsCache;
}
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') settingsCache = null;
});

api.runtime.onInstalled.addListener(async (details) => {
  const stored = await api.storage.sync.get(DEFAULTS);
  const missing = {};
  for (const [k, v] of Object.entries(DEFAULTS)) if (stored[k] === undefined) missing[k] = v;
  if (Object.keys(missing).length) await api.storage.sync.set(missing);
  if (details.reason === 'install') api.runtime.openOptionsPage();
  scheduleCatalog();
});

api.action.onClicked.addListener(() => api.runtime.openOptionsPage());

// ---------------------------------------------------------------- data

const CUSTOM_KEY = 'customRanking';   // storage.local: { label, entries: [{title, issns, rank, desc}] }

async function ensureData() {
  const first = !Rankings.isLoaded();
  await Rankings.load(loadTable);
  if (first) await loadCustom();
}

async function fetchBundled(path) {
  const res = await fetch(api.runtime.getURL(path));
  if (!res.ok) throw new Error(`cannot load ${path} (${res.status})`);
  return res.json();
}

let bundledIndex = null;
const getBundledIndex = () => (bundledIndex ||= fetchBundled('data/index.json').catch(() => ({ files: {} })));

// A downloaded table is used when it is newer than the bundled one (an extension update may ship
// fresher data than an old download). A broken download falls back to the bundled table.
async function loadTable(name) {
  const stored = await Catalog.getStored(name);
  const bundled = (await getBundledIndex()).files[name];
  if (stored && (!bundled || stored.built > bundled.built)) {
    try {
      const json = JSON.parse(stored.text);
      Catalog.validate(name, json);
      return json;
    } catch {
      await Catalog.deleteStored(name);
    }
  }
  return fetchBundled(`data/${name}.json`);
}

// ---------------------------------------------------------------- catalog updates

const CATALOG_ALARM = 'catalog';
const CATALOG_STATE_KEY = 'catalogState';   // storage.local: { checkedAt, updatedAt, error, remote: {name: built} }
const CATALOG_PERIOD_MIN = 7 * 24 * 60;     // weekly check; the workflow publishes monthly
const CATALOG_MIN_GAP_MS = 6 * 24 * 3600 * 1000;
const CATALOG_TIMEOUT_MS = 60000;

async function catalogFetch(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CATALOG_TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split('/').pop().split('?')[0]}`);
    return new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `timeout for ${url.split('/').pop().split('?')[0]}` : e.message);
  } finally {
    clearTimeout(timer);
  }
}

// Downloads the tables whose hash differs from the copy in use. Returns the new catalog state.
async function updateCatalog(force = false) {
  const settings = await getSettings();
  const state = (await api.storage.local.get(CATALOG_STATE_KEY))[CATALOG_STATE_KEY] || {};
  if (!force && (!settings.catalogAuto || Date.now() - (state.checkedAt || 0) < CATALOG_MIN_GAP_MS)) return state;
  const base = (settings.catalogUrl || Catalog.DEFAULT_URL).replace(/\/?$/, '/');
  const next = { ...state, checkedAt: Date.now(), error: '' };
  const updated = [];
  try {
    const index = JSON.parse(new TextDecoder().decode(await catalogFetch(`${base}index.json?t=${Date.now()}`)));
    Catalog.validateIndex(index);
    const bundled = (await getBundledIndex()).files;
    next.remote = {};
    for (const name of Catalog.TABLES) {
      const f = index.files[name];
      next.remote[name] = f.built;
      const stored = await Catalog.getStored(name);
      if (bundled[name] && f.built <= bundled[name].built) {         // the extension ships this or newer
        if (stored) await Catalog.deleteStored(name);
        continue;
      }
      if (stored && stored.sha256 === f.sha256) continue;
      const bytes = await catalogFetch(`${base}${name}.json?h=${f.sha256.slice(0, 12)}`);
      if (bytes.length !== f.bytes) throw new Error(`${name}.json: size mismatch`);
      if (await Catalog.sha256Hex(bytes) !== f.sha256) throw new Error(`${name}.json: checksum mismatch`);
      const text = new TextDecoder().decode(bytes);
      Catalog.validate(name, JSON.parse(text));
      await Catalog.putStored({ name, built: f.built, sha256: f.sha256, text });
      updated.push(name);
    }
  } catch (e) {
    next.error = e && e.message ? e.message : String(e);
  }
  if (updated.length) {
    next.updatedAt = Date.now();
    Rankings.reset();
    await clearCache();   // cached results hold ranks from the previous tables
  }
  await api.storage.local.set({ [CATALOG_STATE_KEY]: next });
  return { ...next, updated };
}

async function catalogStatus() {
  const state = (await api.storage.local.get(CATALOG_STATE_KEY))[CATALOG_STATE_KEY] || {};
  const bundled = (await getBundledIndex()).files;
  const tables = {};
  for (const name of Catalog.TABLES) {
    const stored = await Catalog.getStored(name);
    const b = bundled[name] && bundled[name].built;
    tables[name] = stored && (!b || stored.built > b) ? { built: stored.built, from: 'downloaded' } : { built: b || '', from: 'bundled' };
  }
  return { ...state, tables };
}

// Alarms survive service-worker restarts; recreate after browser restarts (Firefox drops them).
async function scheduleCatalog() {
  try {
    if (!(await api.alarms.get(CATALOG_ALARM))) api.alarms.create(CATALOG_ALARM, { delayInMinutes: 3, periodInMinutes: CATALOG_PERIOD_MIN });
  } catch { /* alarms unavailable */ }
}
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CATALOG_ALARM) updateCatalog(false).catch(() => {});
});
api.runtime.onStartup.addListener(scheduleCatalog);
scheduleCatalog();

async function loadCustom() {
  try {
    Rankings.setCustom((await api.storage.local.get(CUSTOM_KEY))[CUSTOM_KEY] || null);
  } catch { Rankings.setCustom(null); }
}

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[CUSTOM_KEY] && Rankings.isLoaded()) Rankings.setCustom(changes[CUSTOM_KEY].newValue || null);
});

// ---------------------------------------------------------------- cache

const cacheKey = (k) => `r:${CACHE_VERSION}:${k}`;

async function cacheGet(key) {
  const row = (await api.storage.local.get(cacheKey(key)))[cacheKey(key)];
  if (!row) return null;
  const ttl = row.v && (row.v.sjr || row.v.core || row.v.workshop || row.v.ranked) ? TTL_POSITIVE_MS : TTL_NEGATIVE_MS;
  if (Date.now() - row.t > ttl) return null;
  return row.v;
}

let setsSinceTrim = 0;
async function cacheSet(key, value) {
  await api.storage.local.set({ [cacheKey(key)]: { v: value, t: Date.now() } });
  if (++setsSinceTrim >= 100) {
    setsSinceTrim = 0;
    trimCache().catch(() => {});
  }
}

async function trimCache() {
  const all = await api.storage.local.get(null);
  const rows = Object.entries(all).filter(([k]) => k.startsWith('r:'));
  if (rows.length <= MAX_CACHE_ENTRIES) return;
  rows.sort((a, b) => (a[1].t || 0) - (b[1].t || 0));
  const drop = rows.slice(0, rows.length - MAX_CACHE_ENTRIES).map(([k]) => k);
  await api.storage.local.remove(drop);
}

async function clearCache() {
  const all = await api.storage.local.get(null);
  await api.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('r:')));
}

async function cacheCount() {
  const all = await api.storage.local.get(null);
  return Object.keys(all).filter((k) => k.startsWith('r:')).length;
}

// ---------------------------------------------------------------- HTTP with per-host pacing

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HostQueue {
  constructor(gapMs) {
    this.gapMs = gapMs;
    this.chain = Promise.resolve();
    this.nextAt = 0;
  }
  // Serialises requests and keeps `gapMs` between them; `pause` pushes the whole queue back.
  // A task whose `token.cancelled` is set by the time its turn comes is skipped (resolves null).
  run(fn, token) {
    const p = this.chain.then(async () => {
      if (token && token.cancelled) return null;
      const wait = this.nextAt - Date.now();
      if (wait > 0) await sleep(wait);
      try { return await fn(); } finally { this.nextAt = Math.max(this.nextAt, Date.now() + this.gapMs); }
    });
    this.chain = p.catch(() => {});
    return p;
  }
  pause(ms) { this.nextAt = Math.max(this.nextAt, Date.now() + ms); }
}

const queues = {
  s2: new HostQueue(1000),      // unauthenticated pool is slow and 429-happy
  s2keyed: new HostQueue(1050), // 1 req/s with a key
  crossref: new HostQueue(350), // limit is 3 req/s
};

class Cancelled extends Error { constructor() { super('cancelled'); this.name = 'Cancelled'; } }

async function fetchWithTimeout(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: ctrl.signal, credentials: 'omit' });
  } finally {
    clearTimeout(timer);
  }
}

// Returns parsed JSON, `{ notFound: true }` on 404, throws on anything else after retries.
async function fetchJson(queue, url, headers = {}, token = null) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await queue.run(() => fetchWithTimeout(url, headers), token);
      if (res === null) throw new Cancelled();
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      if (attempt < MAX_RETRIES) { await sleep(1000 * (attempt + 1)); continue; }
      throw new Error(e.name === 'AbortError' ? 'timeout' : (e.message || 'network error'));
    }
    if (res.status === 404) return { notFound: true };
    if (res.status === 429 || res.status >= 500) {
      const ra = parseFloat(res.headers.get('retry-after'));
      const delay = Number.isFinite(ra) ? Math.min(ra * 1000, 15000) : 2000 * (attempt + 1);
      queue.pause(delay);
      if (attempt < MAX_RETRIES) { await sleep(delay); continue; }
      throw new Error(`HTTP ${res.status}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    try { return JSON.parse(text); } catch { throw new Error('non-JSON response'); }
  }
}

// ---------------------------------------------------------------- resolvers

function plainSjr(e) {
  return e ? { title: e.title, q: e.q, h: e.h, sjr: e.sjr, issn: e.issns[0] || '', type: e.type } : null;
}
function plainCore(e) {
  return e ? { title: e.title, acro: e.acro, rank: e.rank, raw: e.raw, partOf: e.partOf || '' } : null;
}
function plainWorkshop(w) {
  return w ? { host: plainCore(w.host) } : null;
}

// Identifiers used for the other lists (ABDC, VHB, CCF, custom, …), see Rankings.listsFor. Journal
// ISSNs / names are only collected for journal venues: a proceedings series ISSN (LNCS, PMLR) or name
// ranks the series, not the conference paper.
function collectIds({ sjr = null, core = null, issns = [], names = [], dblp = '', acros = [], confNames = [] }) {
  const ids = { issns: [...issns], names: [...names], dblp: dblp || '', acros: [...acros], confNames: [...confNames] };
  if (sjr) { ids.issns.push(...sjr.issns); ids.names.push(sjr.title); }
  if (core) { if (core.acro) ids.acros.unshift(core.acro); ids.confNames.unshift(core.title); }
  for (const k of Object.keys(ids)) if (Array.isArray(ids[k])) ids[k] = [...new Set(ids[k].filter(Boolean))];
  return ids;
}

const hasRanking = (r) => !!(r && (r.sjr || r.core || r.workshop || r.lists));

// Every lookup result carries { sjr, core, workshop, ids, lists }: `workshop` is set (host may be null) when the
// paper appeared in a workshop rather than the main track; `core` is then left null.
function localLookup(msg) {
  const venue = (msg.venue || '').trim();
  const out = { sjr: null, core: null, workshop: null, ids: null, lists: null };
  if (venue && !Norm.isPreprintVenue(venue)) {
    out.workshop = Rankings.workshopOf(venue);
    if (out.workshop) return out;
    if (!msg.truncated) {
      out.sjr = Rankings.sjrByName(venue);
      out.core = Rankings.coreByEmbeddedAcronym(venue) || Rankings.coreByName(venue);
    } else {
      const ts = !!msg.truncStart, te = msg.truncEnd !== undefined ? !!msg.truncEnd : !ts;
      out.sjr = Rankings.sjrByPrefix(venue, ts, te);
      out.core = Rankings.coreByEmbeddedAcronym(venue) || Rankings.coreByPrefix(venue, ts, te);
    }
  }
  // Link host such as proceedings.neurips.cc pins the series even when Scholar prints "arXiv preprint".
  if (!out.core && !out.sjr && msg.domain) out.core = Rankings.coreByDomain(msg.domain);
  out.core = Rankings.refineMulticonference(out.core, [venue]);
  const usable = venue && !Norm.isPreprintVenue(venue);
  out.ids = collectIds({
    sjr: out.sjr, core: out.core,
    names: usable && !msg.truncated && !Norm.hasConfSignal(venue) ? [venue] : [],
    acros: usable ? Norm.embeddedAcronyms(venue) : [],
    confNames: usable && !msg.truncated ? [venue] : [],
  });
  out.lists = Rankings.listsFor(out.ids);
  return out;
}

// Semantic Scholar title match -> { paper, venueName, isPreprint, sjr, core, workshop } | null
async function viaSemanticScholar(title, settings, token) {
  const headers = { Accept: 'application/json' };
  const keyed = !!settings.s2ApiKey;
  if (keyed) headers['x-api-key'] = settings.s2ApiKey;
  const url = `${S2_API}?query=${encodeURIComponent(title)}&fields=${S2_FIELDS}`;
  const json = await fetchJson(keyed ? queues.s2keyed : queues.s2, url, headers, token);
  if (json.notFound || !Array.isArray(json.data) || !json.data.length) return null;
  const paper = json.data[0];
  if (!Norm.sameTitle(title, paper.title || '')) return null;

  const pv = paper.publicationVenue || null;
  const venueName = (pv && pv.name) || paper.venue || '';
  const isPreprint = !venueName || Norm.isPreprintVenue(venueName) || Norm.isPreprintVenue(paper.venue || '');
  const out = { paper, venueName, isPreprint, sjr: null, core: null, workshop: null, ids: null, lists: null };
  if (isPreprint) return out;

  const isConf = (pv && pv.type === 'conference')
    || (Array.isArray(paper.publicationTypes) && paper.publicationTypes.includes('Conference'))
    || Norm.hasConfSignal(venueName);
  const acros = [];
  if (pv && Array.isArray(pv.alternate_names)) acros.push(...pv.alternate_names.filter((n) => n.length <= 16));
  const dblp = paper.externalIds && paper.externalIds.DBLP;
  const dm = typeof dblp === 'string' && dblp.match(/^conf\/([^/]+)\//);
  if (dm) acros.push(dm[1]);

  // Workshop track: S2 keeps the workshop name in `venue` even when publicationVenue / the dblp key
  // point at the main conference ("… Workshops (CVPRW)" with conf/cvpr/…), so the strings win.
  let ws = Rankings.workshopOf(paper.venue || '', isConf) || (venueName !== paper.venue ? Rankings.workshopOf(venueName, isConf) : null);
  if (!ws && dm && /w$/i.test(dm[1]) && !Rankings.coreByAcro(dm[1]) && Rankings.workshopHostByAcro(dm[1])) {
    ws = { host: Rankings.workshopHostByAcro(dm[1]) };   // conf/iccvw/…
  }
  if (ws) {
    if (!ws.host) for (const a of acros) { ws.host = Rankings.coreByAcro(a, venueName); if (ws.host) break; }
    out.workshop = ws;
    return out;
  }

  const issns = [];
  if (pv && pv.issn) issns.push(pv.issn);
  if (pv && Array.isArray(pv.alternate_issns)) issns.push(...pv.alternate_issns);
  for (const i of issns) { out.sjr = Rankings.sjrByIssn(i); if (out.sjr) break; }
  if (!out.sjr) out.sjr = Rankings.sjrByName(venueName) || (paper.venue ? Rankings.sjrByName(paper.venue) : null);
  if (!out.sjr && pv && Array.isArray(pv.alternate_names)) {
    for (const n of pv.alternate_names) { out.sjr = Rankings.sjrByName(n); if (out.sjr) break; }
  }

  for (const a of acros) { out.core = Rankings.coreByAcro(a, venueName); if (out.core) break; }
  if (!out.core) out.core = Rankings.coreByEmbeddedAcronym(venueName);
  if (!out.core && isConf) {
    out.core = Rankings.coreByName(venueName, true) || (paper.venue ? Rankings.coreByName(paper.venue, true) : null);
  }
  out.core = Rankings.refineMulticonference(out.core, [venueName, paper.venue]);
  const journalLike = !isConf || (pv && pv.type === 'journal');
  out.ids = collectIds({
    sjr: out.sjr, core: out.core, dblp: typeof dblp === 'string' ? dblp : '',
    issns: journalLike ? issns : [],
    names: journalLike ? [venueName, paper.venue, ...((pv && pv.alternate_names) || [])] : [],
    acros, confNames: [venueName, paper.venue],
  });
  out.lists = Rankings.listsFor(out.ids);
  return out;
}

// Crossref bibliographic query -> { item, venueName, sjr, core, workshop, final } | null
// `final` = a verified journal article with an ISSN: nothing else will rank it, no need to wait for S2.
async function viaCrossref(title, firstAuthor, settings, token) {
  const params = new URLSearchParams({
    'query.bibliographic': title,
    rows: '4',
    select: 'DOI,title,container-title,short-container-title,ISSN,type,event',
  });
  if (firstAuthor) params.set('query.author', firstAuthor);
  if (settings.crossrefMailto) params.set('mailto', settings.crossrefMailto);
  const json = await fetchJson(queues.crossref, `${CROSSREF_API}?${params}`, { Accept: 'application/json' }, token);
  if (json.notFound || !json.message || !Array.isArray(json.message.items)) return null;

  const candidates = [];
  for (const it of json.message.items) {
    if (it.type === 'posted-content') continue;                 // preprints
    const t = Array.isArray(it.title) ? it.title[0] : it.title;
    const score = t ? Norm.titleScore(title, t) : 0;
    if (score >= 0.8) candidates.push({ it, score });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);

  const evaluate = (item) => {
    // Springer chapters list the series first: ["Lecture Notes in Computer Science", "Computer Vision – ECCV 2018 Workshops"]
    const containers = (Array.isArray(item['container-title']) ? item['container-title'] : [item['container-title']]).filter(Boolean);
    const container = containers[0] || '';
    const out = { item, venueName: container, sjr: null, core: null, workshop: null, ids: null, lists: null, final: false };
    for (const i of item.ISSN || []) { out.sjr = Rankings.sjrByIssn(i); if (out.sjr) break; }
    if (!out.sjr && container) out.sjr = Rankings.sjrByName(container);

    const ev = item.event || null;
    const isProc = item.type === 'proceedings-article' || !!ev;
    const evName = (ev && ev.name) || '';
    const evAcro = (ev && ev.acronym) || '';
    const strings = [evName, ...containers].filter(Boolean);

    for (const str of strings) { out.workshop = Rankings.workshopOf(str, isProc); if (out.workshop) break; }
    if (out.workshop) {
      if (!out.workshop.host && evAcro) out.workshop.host = Rankings.workshopHostByAcro(evAcro, evName || container);
      out.venueName = containers.find(Norm.hasWorkshopSignal) || evName || container;
    } else {
      if (evAcro) out.core = Rankings.coreByAcro(evAcro, evName || container);
      if (!out.core && evName) out.core = Rankings.coreByEmbeddedAcronym(evName) || Rankings.coreByName(evName, true);
      for (const c of containers) {
        if (out.core) break;
        out.core = Rankings.coreByEmbeddedAcronym(c) || Rankings.coreByName(c, isProc);
      }
      out.core = Rankings.refineMulticonference(out.core, [evName, ...containers]);
      if (!out.venueName && evName) out.venueName = evName;
    }
    // A book-series quartile (LNCS is Q2) says nothing about the conference paper printed in it.
    const confPaper = out.core || out.workshop || strings.some(Norm.hasConfSignal);
    if (out.sjr && out.sjr.type === 'book series' && confPaper) out.sjr = null;
    if (!out.workshop) {
      const journalLike = !isProc && !confPaper;
      out.ids = collectIds({
        sjr: out.sjr, core: out.core,
        issns: journalLike ? item.ISSN || [] : [],
        names: journalLike ? [...containers, ...(item['short-container-title'] || [])] : [],
        acros: [evAcro, ...strings.flatMap(Norm.embeddedAcronyms)],
        confNames: isProc || confPaper ? strings : [],
      });
      out.lists = Rankings.listsFor(out.ids);
    }
    out.final = item.type === 'journal-article' && Array.isArray(item.ISSN) && item.ISSN.length > 0;
    return out;
  };

  // Among equally good title matches prefer the one that actually yields a ranking
  // ("Deep learning" matches a book and a Nature article alike).
  const evaluated = candidates.map((c) => ({ ...c, r: evaluate(c.it) }));
  const top = evaluated[0].score;
  const ranked = evaluated.find((c) => c.score >= top - 0.05 && hasRanking(c.r));
  return (ranked || evaluated[0]).r;
}

// Resolves the settled promises in `entries` ({name, promise}) one by one and returns as soon as
// one yields a ranking. Returns { winner, results } where results holds every settled outcome so far.
async function firstRanked(entries) {
  const results = {};
  let pending = entries.map((e) => e.promise.then((v) => ({ name: e.name, ok: v }), (err) => ({ name: e.name, err })));
  const tagged = pending.map((p, i) => p.then((r) => ({ ...r, i })));
  const done = new Set();
  while (done.size < tagged.length) {
    const r = await Promise.race(tagged.filter((_, i) => !done.has(i)));
    done.add(r.i);
    results[r.name] = r;
    if (r.ok && (hasRanking(r.ok) || r.ok.final)) return { winner: r, results };
  }
  return { winner: null, results };
}

async function resolveUncached(msg, settings) {
  const title = (msg.title || '').trim();
  const venue = (msg.venue || '').trim();
  const out = { status: 'ok', sjr: null, core: null, workshop: null, ids: null, via: null, venue, matchedVenue: '', url: '', note: '' };

  // 1. local tables. A workshop venue printed by Scholar is final even without a host: an API hit on the
  // same title is as likely to be the later main-track version of the paper as the workshop one.
  const local = localLookup(msg);
  if (hasRanking(local)) {
    out.sjr = plainSjr(local.sjr); out.core = plainCore(local.core); out.workshop = plainWorkshop(local.workshop);
    out.ids = local.ids;
    out.via = 'local'; out.matchedVenue = venue;
    return out;
  }
  out.ids = local.ids;   // kept for a custom list imported later
  if (!title) { out.note = venue ? 'venue not ranked' : 'no title'; return out; }

  // 2. Crossref and Semantic Scholar in parallel; first ranking wins, the other lookup is dropped.
  const token = { cancelled: false };
  const { winner, results } = await firstRanked([
    { name: 'crossref', promise: viaCrossref(title, msg.firstAuthor || '', settings, token) },
    { name: 's2', promise: viaSemanticScholar(title, settings, token) },
  ]);
  token.cancelled = true;

  const cr = results.crossref && results.crossref.ok;
  const s2 = results.s2 && results.s2.ok;
  if (cr && cr.item.DOI) out.url = `https://doi.org/${cr.item.DOI}`;
  else if (s2 && s2.paper.url) out.url = s2.paper.url;

  if (winner) {
    const w = winner.ok;
    out.sjr = plainSjr(w.sjr); out.core = plainCore(Rankings.refineMulticonference(w.core, [venue]));
    out.workshop = plainWorkshop(w.workshop);
    out.ids = w.ids;
    out.via = winner.name; out.matchedVenue = w.venueName || '';
    if (!hasRanking(w)) out.note = 'venue not ranked';
    return out;
  }

  // Nothing ranked: explain why, using whichever lookup found the paper.
  if (s2 && !s2.isPreprint) { out.via = 's2'; out.ids = s2.ids; out.matchedVenue = s2.venueName; out.note = 'venue not ranked'; return out; }
  if (cr) { out.ids = cr.ids || out.ids; out.via = 'crossref'; out.matchedVenue = cr.venueName; out.note = cr.venueName ? 'venue not ranked' : 'no venue'; return out; }
  if (s2) { out.via = 's2'; out.matchedVenue = s2.venueName; out.note = 'preprint'; return out; }

  const errors = Object.values(results).filter((r) => r.err && !(r.err instanceof Cancelled)).map((r) => `${r.name}: ${r.err.message}`);
  const attempted = Object.values(results).filter((r) => !(r.err instanceof Cancelled)).length;
  if (errors.length && errors.length === attempted) return { status: 'error', reason: errors.join('; '), retryable: true };
  out.note = 'no match';
  return out;
}

async function resolve(msg) {
  const settings = await getSettings();
  await ensureData();
  const key = msg.key || Norm.hash(`${Norm.titleKey(msg.title || '')}|${Norm.nameKey(msg.venue || '')}`);
  if (!msg.force) {
    const cached = await cacheGet(key);
    if (cached) return withLists({ ...cached, cached: true });
  }
  const result = withLists(await resolveUncached(msg, settings));
  if (result.status === 'ok') {
    const { lists, ...row } = result;
    await cacheSet(key, { ...row, ranked: !!lists });
  }
  return result;
}

// Lists are looked up from the stored identifiers on every call, so a rebuilt table or a newly
// imported custom list applies to cached rows too. Workshop papers get none: the lists rank main tracks.
function withLists(result) {
  if (result.status !== 'ok') return result;
  return { ...result, lists: result.workshop ? null : Rankings.listsFor(result.ids) };
}

// ---------------------------------------------------------------- messaging

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  const reply = (p) => p.then(sendResponse, (e) => sendResponse({ status: 'error', reason: e && e.message ? e.message : String(e), retryable: true }));
  switch (msg.type) {
    case 'resolve': reply(resolve(msg)); return true;
    case 'meta': reply(ensureData().then(async () => ({ ...Rankings.meta(), cacheEntries: msg.light ? undefined : await cacheCount() }))); return true;
    case 'clearCache': reply(clearCache().then(() => ({ ok: true }))); return true;
    case 'catalogStatus': reply(catalogStatus()); return true;
    case 'updateCatalog': reply(updateCatalog(true).then(async (r) => ({ ...(await catalogStatus()), updated: r.updated || [] }))); return true;
    default: return false;
  }
});

// Ranking tables (SJR journals, CORE conferences, the other journal lists, CCF, a user-imported custom list)
// with lookup by ISSN, name, acronym, dblp key and fuzzy title.
// Classic script: exposes a global `Rankings`; CommonJS-exported for node tests.
// Depends on lib/normalize.js (global `Norm`).

const Rankings = (() => {
  const N = typeof Norm !== 'undefined' ? Norm : require('./normalize.js');

  const RANK_ORDER = { 'A*': 0, A: 1, B: 2, C: 3, other: 4 };

  // dblp conference keys (conf/<key>/...) whose spelling differs from the ICORE acronym.
  const DBLP_ALIASES = {
    NIPS: 'NEURIPS', USS: 'USENIXSECURITY', MM: 'ACMMM',
    PKDD: 'ECMLPKDD', ECML: 'ECMLPKDD', VISUALIZATION: 'IEEEVIS', IEEEVAST: 'IEEEVIS',
    INFOVIS: 'IEEEVIS', VIS: 'IEEEVIS', PVLDB: 'VLDB', HUC: 'UBICOMP', EUROSP: 'EUROSP',
    SIGGRAPHA: 'SIGGRAPHA', ATAL: 'AAMAS', KR: 'KR', ICLP: 'ICLP', ISWC: 'ISWC', SEMWEB: 'ISWC',
  };
  // Workshop keys such as conf/iccvw or CVPRW are handled by workshopOf(), never aliased to the main conference.

  // Hosts that unambiguously identify a conference series (Scholar prints the link host after the venue).
  const DOMAIN_ACRONYMS = {
    'proceedings.neurips.cc': 'NEURIPS', 'papers.nips.cc': 'NEURIPS', 'papers.neurips.cc': 'NEURIPS',
    'proceedings.iclr.cc': 'ICLR', 'iclr.cc': 'ICLR',
    'ijcai.org': 'IJCAI', 'ndss-symposium.org': 'NDSS', 'proceedings.kr.org': 'KR',
    'auai.org': 'UAI', 'proceedings.aaai.org': 'AAAI', 'iscaconf.org': 'ISCA',
  };

  const state = {
    loaded: false,
    meta: {},
    sjr: [],            // [{title, issns, q, h, sjr, type, key}]
    sjrByIssn: new Map(),
    sjrByName: new Map(), // nameKey -> [entry]
    sjrKeys: [],          // sorted nameKeys for prefix search
    core: [],           // [{title, acro, rank, raw, key, signal, ws}]
    coreByAcro: new Map(),
    coreByKey: new Map(), // confKey -> [entry]
    coreKeys: [],
    lists: {},            // list id -> {label, name, edition, scale, url, source}
    listByIssn: new Map(), // issn -> [journal entry]
    listByName: new Map(), // nameKey -> [journal entry]
    ccfByDb: new Map(),    // dblp prefix "conf/cvpr" -> entry
    ccfByAcro: new Map(),  // acroKey -> [entry]
    ccfByKey: new Map(),   // confKey -> [entry]
    custom: null,          // {label, byIssn, byName, byAcro}
  };

  function betterRank(a, b) {
    return (RANK_ORDER[a.rank] ?? 9) - (RANK_ORDER[b.rank] ?? 9);
  }

  function pushMap(map, k, v) {
    if (!k) return;
    const arr = map.get(k);
    if (arr) arr.push(v); else map.set(k, [v]);
  }

  function build(sjrJson, coreJson, listsJson = null) {
    state.meta = {
      sjrEdition: sjrJson.edition, sjrBuilt: sjrJson.built, sjrSource: sjrJson.source,
      coreSource: coreJson.source, coreBuilt: coreJson.built,
    };

    state.sjr = sjrJson.journals.map(([title, issns, q, h, sjr, type]) => ({
      title, issns: issns || [], q: q || null, h: h ?? null, sjr: sjr ?? null, type: type || '',
      key: N.nameKey(title),
    }));
    state.sjrByIssn = new Map();
    state.sjrByName = new Map();
    for (const e of state.sjr) {
      for (const i of e.issns) if (!state.sjrByIssn.has(i)) state.sjrByIssn.set(i, e);
      pushMap(state.sjrByName, e.key, e);
    }
    state.sjrKeys = [...state.sjrByName.keys()].sort();

    state.core = coreJson.confs.map(([title, acro, rank, raw]) => {
      const key = N.confKey(title);
      // ws: the ranked series is itself a workshop (WACV, ITW, DAS): "workshop" in the title outside "(was …)".
      return { title, acro, rank, raw, key, signal: N.hasConfSignal(title), ws: key.split(' ').includes('workshop') };
    });
    state.coreByAcro = new Map();
    state.coreByKey = new Map();
    for (const e of state.core) {
      pushMap(state.coreByAcro, N.acroKey(e.acro), e);
      // "(was NIPS)", "(previously MIR)" -> alias acronyms
      for (const m of e.title.matchAll(/\((?:was|formerly|previously)\s+([A-Za-z0-9&\-\/ ]{2,20})\)/g)) {
        for (const part of m[1].split(/[\/]/)) {
          const k = N.acroKey(part.trim());
          if (k && k.length <= 14 && !/\s/.test(part.trim()) ) pushMap(state.coreByAcro, k, e);
        }
      }
      pushMap(state.coreByKey, e.key, e);
    }
    state.coreKeys = [...state.coreByKey.keys()].sort();
    buildLists(listsJson || { lists: {}, journals: [], ccf: [] });
    state.loaded = true;
  }

  // lists.json: journals = [[title, issns, {list: rank}, {list: note}?]], ccf = [[rank, abbr, title, dblp]]
  function buildLists(json) {
    state.meta.listsBuilt = json.built || '';
    state.lists = json.lists || {};
    state.listByIssn = new Map();
    state.listByName = new Map();
    for (const [title, issns, ranks, notes] of json.journals || []) {
      const e = { title, issns: issns || [], ranks: ranks || {}, notes: notes || {} };
      for (const i of e.issns) pushMap(state.listByIssn, i, e);
      pushMap(state.listByName, N.nameKey(title), e);
    }
    state.ccfByDb = new Map();
    state.ccfByAcro = new Map();
    state.ccfByKey = new Map();
    for (const [rank, abbr, title, db] of json.ccf || []) {
      const e = { rank, abbr, title, db, key: N.confKey(title) };
      if (!state.ccfByDb.has(db)) state.ccfByDb.set(db, e);
      if (abbr) pushMap(state.ccfByAcro, N.acroKey(abbr), e);
      pushMap(state.ccfByKey, e.key, e);
    }
  }

  // Loader for 'sjr', 'core' and 'lists' (optional: a missing lists.json leaves only SJR + CORE).
  let loading = null;
  function load(loader) {
    if (state.loaded) return Promise.resolve();
    if (!loading) {
      loading = Promise.all([loader('sjr'), loader('core'), loader('lists').catch(() => null)])
        .then(([s, c, l]) => build(s, c, l))
        .catch((e) => { loading = null; throw e; });
    }
    return loading;
  }

  // ------------------------------------------------------------ SJR

  function sjrByIssn(issn) {
    const k = N.issnKey(issn);
    const e = k && state.sjrByIssn.get(k);
    return e && e.q ? e : null;
  }

  // Exact name match. Sources without a quartile are ignored; several Scopus sources can share
  // a title, accepted only when they agree on the quartile.
  function pickSjr(list) {
    list = (list || []).filter((e) => e.q);
    if (!list.length) return null;
    if (list.length === 1) return list[0];
    if (new Set(list.map((e) => e.q)).size > 1) return null;
    return list.slice().sort((a, b) => (b.h ?? -1) - (a.h ?? -1))[0];
  }

  // Exact SJR title, else the ISSNs of a journal list entry with that exact title ("MIS Quarterly" is
  // "MIS Quarterly: Management Information Systems" in SJR). Refused when the list entries disagree.
  function sjrByName(name) {
    const k = N.nameKey(name);
    if (!k) return null;
    const direct = pickSjr(state.sjrByName.get(k));
    if (direct) return direct;
    const hits = new Set();
    for (const e of state.listByName.get(k) || []) {
      for (const i of e.issns) { const h = sjrByIssn(i); if (h) { hits.add(h); break; } }
    }
    return hits.size === 1 ? [...hits][0] : null;
  }

  function lowerBound(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  }

  // Keys starting with `prefix`, capped.
  function prefixKeys(sortedKeys, prefix, cap = 3) {
    const out = [];
    for (let i = lowerBound(sortedKeys, prefix); i < sortedKeys.length && out.length < cap; i++) {
      if (!sortedKeys[i].startsWith(prefix)) break;
      out.push(sortedKeys[i]);
    }
    return out;
  }

  // Keys matching a truncated fragment: prefix (trailing "…"), suffix (leading "…") or infix (both).
  function fragmentKeys(sortedKeys, frag, mode, cap = 2) {
    if (mode === 'prefix') return prefixKeys(sortedKeys, frag, cap);
    const out = [];
    for (const k of sortedKeys) {
      const ok = mode === 'suffix' ? k.endsWith(frag) : k.includes(frag);
      if (ok && (k === frag || k.length > frag.length)) { out.push(k); if (out.length >= cap) break; }
    }
    return out;
  }

  function fragMode(truncStart, truncEnd) {
    if (truncStart && truncEnd) return 'infix';
    return truncStart ? 'suffix' : 'prefix';
  }

  // Truncated venue ("Journal of machine learning …", "… image analysis"): only a unique match is trusted.
  function sjrByPrefix(name, truncStart = false, truncEnd = true) {
    const k = N.nameKey(name);
    if (k.length < 8) return null;
    const keys = fragmentKeys(state.sjrKeys, k, fragMode(truncStart, truncEnd), 2);
    if (keys.length !== 1) return null;
    return pickSjr(state.sjrByName.get(keys[0]));
  }

  // ------------------------------------------------------------ CORE

  const isRanked = (e) => e && e.rank !== 'other';
  const isMulticonference = (e) => !!e && /multiconference/i.test(e.raw || '');

  // Candidates sharing an acronym or a normalised title ("SAC" = Applied Computing vs Selected Areas in
  // Cryptography): pick by similarity of the full venue string to each title; refuse when unclear.
  function pickCore(list, context = '') {
    if (!list || !list.length) return null;
    if (list.length === 1) return list[0];
    const ranks = new Set(list.map((e) => e.rank));
    if (ranks.size === 1) return list.slice().sort(betterRank)[0];
    const ctx = N.nameKey(context).split(' ').filter(Boolean);
    if (ctx.length < 2) return null;
    const scored = list.map((e) => ({ e, s: N.dice(ctx, N.nameKey(e.title).split(' ')) })).sort((a, b) => b.s - a.s);
    if (scored[0].s >= 0.6 && scored[0].s - scored[1].s >= 0.15) return scored[0].e;
    return null;
  }

  function coreByAcro(acro, context = '') {
    let k = N.acroKey(acro);
    if (!k) return null;
    let hit = pickCore(state.coreByAcro.get(k), context);
    if (!hit && DBLP_ALIASES[k]) hit = pickCore(state.coreByAcro.get(DBLP_ALIASES[k]), context);
    if (!hit) {
      // "ICML2023", "CVPR23" -> strip trailing digits
      const stripped = k.replace(/\d+$/, '');
      if (stripped !== k && stripped.length >= 3) hit = pickCore(state.coreByAcro.get(stripped), context);
    }
    return hit;
  }

  function coreExact(venue, signal) {
    const key = N.confKey(venue);
    if (!key) return null;
    return pickCore((state.coreByKey.get(key) || []).filter((e) => signal || !e.signal), venue);
  }

  // Exact conference-title match, then fuzzy. `venueTyped` = caller already knows it is a conference
  // (from an API); otherwise the venue string must carry a conference signal word, except when the
  // CORE title itself has none (e.g. "Advances in Neural Information Processing Systems").
  function coreByName(venue, venueTyped = false) {
    const key = N.confKey(venue);
    if (!key) return null;
    const signal = venueTyped || N.hasConfSignal(venue);

    const exact = coreExact(venue, signal);
    if (exact) return exact;
    if (!signal) return null;

    const toks = key.split(' ');
    if (toks.length < 2) return null;
    const isWorkshop = toks.includes('workshop');
    let best = null, bestScore = 0, tie = false;
    for (const e of state.core) {
      const etoks = e.key.split(' ');
      if (etoks.length < 2) continue;
      if (etoks.includes('workshop') !== isWorkshop) continue;   // workshops never collapse onto the main conference
      const d = N.dice(toks, etoks);
      if (d > bestScore) { best = e; bestScore = d; tie = false; }
      else if (d === bestScore && best && e.rank !== best.rank) tie = true;
    }
    if (!best || tie || bestScore < 0.85) return null;
    return best;
  }

  function coreByPrefix(venue, truncStart = false, truncEnd = true) {
    const k = N.confKey(venue);
    if (k.length < 8) return null;
    const keys = fragmentKeys(state.coreKeys, k, fragMode(truncStart, truncEnd), 2);
    if (keys.length !== 1) return null;
    const list = state.coreByKey.get(keys[0]);
    const signal = N.hasConfSignal(venue);
    return pickCore(list.filter((e) => signal || !e.signal), venue);
  }

  // Acronyms embedded in the venue string ("... CHI Conference ...", "Computer Vision – ECCV 2020").
  // A ranked entry beats an unranked one so "TACAS ... part of ETAPS" yields TACAS, not the multiconference.
  function coreByEmbeddedAcronym(venue) {
    let fallback = null;
    for (const a of N.embeddedAcronyms(venue)) {
      const hit = pickCore(state.coreByAcro.get(a), venue);
      if (!hit) continue;
      if (isRanked(hit)) return hit;
      fallback = fallback || hit;
    }
    return fallback;
  }

  // For a multiconference match, look for a ranked member conference named in any of the strings.
  function refineMulticonference(core, strings) {
    if (!isMulticonference(core)) return core;
    for (const str of strings) {
      if (!str) continue;
      const hit = coreByEmbeddedAcronym(str);
      if (isRanked(hit) && hit !== core) return { ...hit, partOf: core.acro || core.title };
    }
    return core;
  }

  // ------------------------------------------------------------ workshops

  // Host conference behind a workshop acronym: "CVPRW" / dblp "iccvw" -> CVPR / ICCV; "NeurIPS" -> NeurIPS.
  function workshopHostByAcro(acro, context = '') {
    const k = N.acroKey(acro);
    if (!k) return null;
    const direct = coreByAcro(k, context);
    if (direct) return direct;
    if (k.length >= 4 && k.endsWith('W')) return coreByAcro(k.slice(0, -1), context);
    return null;
  }

  // Workshop detection. Returns null when `venue` is not a workshop venue — including CORE-ranked
  // series that happen to be called workshops (WACV, ITW, DAS…), which the normal lookup ranks —
  // otherwise { host } where host is the CORE entry of the conference the workshop was held at, or null.
  // `typed` = caller knows from an API that the venue is a conference.
  function workshopOf(venue, typed = false) {
    if (!N.hasWorkshopSignal(venue)) return null;
    if (coreExact(venue, true) && (state.coreByKey.get(N.confKey(venue)) || []).some((e) => e.ws)) return null;
    const acros = N.embeddedAcronyms(venue);
    if (acros.some((a) => (state.coreByAcro.get(a) || []).some((e) => e.ws))) return null;

    // "<conference> Workshops": the base names the host; only exact title / acronym matches are trusted
    // so "Workshop on Machine Learning" never becomes ICML. Plural "Workshops" (or a conference word in
    // the base) is enough to accept a bare conference title such as "… computer vision and pattern recognition".
    const base = N.stripTrailingWorkshops(venue);
    let host = null;
    if (base) {
      const plural = /\bworkshops\b/i.test(venue);
      host = coreByEmbeddedAcronym(base) || coreExact(base, typed || plural || N.hasConfSignal(base));
    } else if (coreByName(venue, typed)) {
      return null;   // fuzzy hit on a CORE workshop series ("Proc. of the 2019 SIGPLAN Workshop on Partial Evaluation …")
    }
    if (!host) {
      // "NeurIPS 2023 Workshop on …", "… co-located with IJCAI 2021", "(CVPRW)"
      for (const a of acros) {
        const h = workshopHostByAcro(a, venue);
        if (!h) continue;
        if (isRanked(h)) { host = h; break; }
        host = host || h;
      }
    }
    return { host: host || null };
  }

  function coreByDomain(domain) {
    const k = DOMAIN_ACRONYMS[String(domain || '').toLowerCase().replace(/^www\./, '')];
    return k ? pickCore(state.coreByAcro.get(k)) : null;
  }

  // ------------------------------------------------------------ other lists (ABDC, VHB, AJG, …, CCF, custom)

  // Identifiers collected while resolving a paper, all optional:
  //   { issns: [], names: [], dblp: 'conf/cvpr/HeZRS16', acros: [], confNames: [] }
  // `names` are journal / venue names (exact name match); `acros` + `confNames` identify a conference for CCF.
  // Returns { LIST: { rank, title, note } } or null.
  function listsFor(ids) {
    if (!ids) return null;
    const out = {};
    const put = (list, rank, title, note) => {
      if (rank && !out[list]) out[list] = { rank: String(rank), title: title || '', note: note || '' };
    };
    const issns = [...new Set((ids.issns || []).map(N.issnKey).filter(Boolean))];
    const names = [...new Set((ids.names || []).map(N.nameKey).filter(Boolean))];

    const journals = [];
    for (const i of issns) for (const e of state.listByIssn.get(i) || []) if (!journals.includes(e)) journals.push(e);
    // By name only when the ISSNs found nothing: two journals may share a title, their ISSNs never.
    if (!journals.length) for (const k of names) for (const e of state.listByName.get(k) || []) if (!journals.includes(e)) journals.push(e);
    for (const e of journals) for (const [list, rank] of Object.entries(e.ranks)) put(list, rank, e.title, e.notes[list]);

    if (!out.CCF) {
      const c = ccfFor(ids);
      if (c) put('CCF', c.rank, c.title, c.abbr);
    }
    const cu = customFor(issns, names, ids.acros || []);
    if (cu) put('CUSTOM', cu.rank, cu.title, cu.desc);
    return Object.keys(out).length ? out : null;
  }

  // CCF by dblp stream ("conf/cvpr/HeZRS16" -> "conf/cvpr"), then acronym confirmed by title similarity,
  // then exact conference title.
  function ccfFor(ids) {
    const m = String(ids.dblp || '').match(/^((?:conf|journals)\/[^/]+)/);
    if (m && state.ccfByDb.has(m[1])) return state.ccfByDb.get(m[1]);
    const ctx = (ids.confNames || []).map((n) => N.confKey(n).split(' ')).filter((t) => t.length >= 2);
    for (const a of ids.acros || []) {
      for (const e of state.ccfByAcro.get(N.acroKey(a)) || []) {
        if (ctx.some((t) => N.dice(t, e.key.split(' ')) >= 0.5)) return e;
      }
    }
    for (const n of ids.confNames || []) {
      const list = state.ccfByKey.get(N.confKey(n)) || [];
      if (list.length && new Set(list.map((e) => e.rank)).size === 1) return list[0];
    }
    return null;
  }

  // Custom list imported in the options page: entries [{title, issns, rank, desc}].
  function setCustom(custom) {
    if (!custom || !Array.isArray(custom.entries) || !custom.entries.length) { state.custom = null; return; }
    const c = { label: custom.label || 'Custom', byIssn: new Map(), byName: new Map(), byAcro: new Map() };
    for (const e of custom.entries) {
      for (const i of e.issns || []) { const k = N.issnKey(i); if (k && !c.byIssn.has(k)) c.byIssn.set(k, e); }
      const nk = N.nameKey(e.title);
      if (nk && !c.byName.has(nk)) c.byName.set(nk, e);
      // Short single-token titles ("CVPR", "NeurIPS") double as conference acronyms.
      if (/^[A-Za-z][A-Za-z0-9&+\-]{1,11}$/.test(String(e.title || '').trim())) c.byAcro.set(N.acroKey(e.title), e);
    }
    state.custom = c;
  }

  function customFor(issns, names, acros) {
    const c = state.custom;
    if (!c) return null;
    for (const i of issns) if (c.byIssn.has(i)) return c.byIssn.get(i);
    for (const k of names) if (c.byName.has(k)) return c.byName.get(k);
    for (const a of acros) { const k = N.acroKey(a); if (c.byAcro.has(k)) return c.byAcro.get(k); }
    return null;
  }

  function listMeta() {
    const lists = { ...state.lists };
    if (state.custom) lists.CUSTOM = { label: state.custom.label, name: `${state.custom.label} (imported)`, scale: [] };
    return lists;
  }

  function meta() { return { ...state.meta, lists: listMeta() }; }

  // Drop the tables so the next load() reads them again (after a catalog update). The custom list is
  // kept; lookups running meanwhile finish on the old tables.
  function reset() {
    state.loaded = false;
    loading = null;
  }
  function isLoaded() { return state.loaded; }

  return {
    load, build, reset, isLoaded, meta,
    sjrByIssn, sjrByName, sjrByPrefix,
    coreByAcro, coreByName, coreByPrefix, coreByEmbeddedAcronym, coreByDomain, refineMulticonference,
    workshopOf, workshopHostByAcro, isRanked, isMulticonference,
    listsFor, ccfFor, setCustom,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Rankings;

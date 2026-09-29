// Google Scholar content script: parse result rows, ask the background for rankings, render badges.
// Every row ends in a badge, an "N/A", or a retryable "!" — never a stuck spinner.

(() => {
  const RESULT_TIMEOUT_MS = 60000;
  const DEFAULTS = { ext_on: true, SJR: true, CORE: true, hiddenLists: [] };
  let settings = { ...DEFAULTS };
  let dataMeta = null;

  const cleanText = (s) => String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

  function titleFrom(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.gs_ctg2, .gs_ctc, .jq-badges').forEach((n) => n.remove());
    return cleanText(clone.textContent).replace(/^\[(pdf|html|book|citation|doc|ps)\]\s*/i, '');
  }

  // ---------------------------------------------------------------- rendering

  const CORE_CLASS = { 'A*': 'jq-astar', A: 'jq-a', B: 'jq-b', C: 'jq-c', other: 'jq-other' };
  const SJR_CLASS = { Q1: 'jq-q1', Q2: 'jq-q2', Q3: 'jq-q3', Q4: 'jq-q4' };
  const TIER_CLASS = ['jq-t0', 'jq-t1', 'jq-t2', 'jq-t3', 'jq-t4'];

  // Colour from the rank's position on the list's scale (best -> worst); "1eg" (CNRS) counts as "1".
  function tierClass({ scale, tiers }, rank) {
    if (!Array.isArray(scale) || !scale.length) return 'jq-other';
    let i = scale.indexOf(rank);
    if (i < 0) i = scale.indexOf(String(rank).replace(/[a-z]+$/, ''));
    if (i < 0) return 'jq-other';
    if (Array.isArray(tiers) && tiers[i] != null) return TIER_CLASS[tiers[i]] || 'jq-other';
    return scale.length === 1 ? TIER_CLASS[0] : TIER_CLASS[Math.round((i / (scale.length - 1)) * 4)];
  }

  function badge(cls, text, title, href) {
    const el = document.createElement(href ? 'a' : 'span');
    el.className = `jq-badge ${cls}`;
    el.textContent = text;
    if (title) el.title = title;
    if (href) { el.href = href; el.target = '_blank'; el.rel = 'noopener noreferrer'; }
    return el;
  }

  // Compact label for CORE entries outside A*/A/B/C ("National: USA", "Multiconference", ...).
  function shortRank(raw) {
    const r = String(raw || 'other');
    if (/^national/i.test(r)) return 'National';
    if (/^regional/i.test(r)) return 'Regional';
    if (/^australasian\s*([abc])/i.test(r)) return `Aus. ${r.match(/([abc])\s*$/i)[1].toUpperCase()}`;
    if (/^journal/i.test(r)) return 'Journal';
    if (/^unranked/i.test(r)) return 'Unranked';
    if (/^multiconf/i.test(r)) return 'Multiconf.';
    return r.length > 12 ? `${r.slice(0, 11)}…` : r;
  }

  function sourceLabel(via) {
    return { local: 'local table', s2: 'Semantic Scholar', crossref: 'Crossref' }[via] || via || '';
  }

  function render(container, item, res) {
    container.replaceChildren();
    if (!res || res.status !== 'ok') {
      const reason = (res && res.reason) || 'no response';
      const b = badge('jq-err', '!', `Lookup failed: ${reason}\nClick to retry.`);
      b.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); resolveItem(container, item, true); });
      container.append(b);
      return;
    }
    const via = sourceLabel(res.via);
    const matched = res.matchedVenue ? `Venue: ${res.matchedVenue}` : '';
    const url = res.url || '';
    let any = false;

    if (settings.SJR && res.sjr) {
      any = true;
      const q = res.sjr.q || '–';
      const ed = dataMeta && dataMeta.sjrEdition ? ` ${dataMeta.sjrEdition}` : '';
      const tip = [
        `SJR${ed}: ${q}${res.sjr.h != null ? ` · H-index ${res.sjr.h}` : ''}${res.sjr.sjr != null ? ` · SJR ${res.sjr.sjr}` : ''}`,
        `Journal: ${res.sjr.title}${res.sjr.issn ? ` (ISSN ${res.sjr.issn})` : ''}`,
        via ? `Matched via ${via}` : '',
      ].filter(Boolean).join('\n');
      container.append(badge(`jq-sjr ${SJR_CLASS[q] || 'jq-qna'}`, `SJR ${q}`, tip, url));
    }
    if (settings.CORE && res.core) {
      any = true;
      const r = res.core.rank;
      const src = dataMeta && dataMeta.coreSource ? dataMeta.coreSource : 'CORE';
      const label = r === 'other' ? shortRank(res.core.raw) : r;
      const tip = [
        `${src}: ${res.core.raw || r}`,
        `Conference: ${res.core.title}${res.core.acro ? ` (${res.core.acro})` : ''}`,
        res.core.partOf ? `Member conference of ${res.core.partOf} (multiconference)` : '',
        /multiconference/i.test(res.core.raw || '') ? 'CORE does not rank the individual tracks of this multiconference.' : '',
        via ? `Matched via ${via}` : '',
      ].filter(Boolean).join('\n');
      container.append(badge(`jq-core ${CORE_CLASS[r] || 'jq-other'}`, `CORE ${label}`, tip, url));
    }
    if (settings.CORE && res.workshop) {
      any = true;
      const h = res.workshop.host;
      const src = dataMeta && dataMeta.coreSource ? dataMeta.coreSource : 'CORE';
      const hostRank = h ? (h.rank === 'other' ? shortRank(h.raw) : h.rank) : '';
      const text = h ? `Workshop @ ${h.acro || h.title} ${hostRank}` : 'Workshop';
      const tip = [
        'Workshop paper: CORE ranks the main track only, not workshops.',
        h ? `Held at ${h.title}${h.acro ? ` (${h.acro})` : ''} — ${src} ${h.raw || h.rank}` : 'Host conference not identified.',
        matched,
        via ? `Matched via ${via}` : '',
      ].filter(Boolean).join('\n');
      container.append(badge(`jq-ws ${h ? CORE_CLASS[h.rank] || 'jq-other' : 'jq-other'}`, text, tip, url));
    }
    if (res.lists) {
      const lists = (dataMeta && dataMeta.lists) || {};
      const order = [...Object.keys(lists), ...Object.keys(res.lists)];
      for (const id of new Set(order)) {
        const v = res.lists[id];
        if (!v || (settings.hiddenLists || []).includes(id)) continue;
        any = true;
        const m = lists[id] || { label: id, name: id, scale: [] };
        const text = v.rank === m.label ? m.label : `${m.label} ${v.rank}`;
        const tip = [
          `${m.name}${m.edition ? ` ${m.edition}` : ''}: ${v.rank}`,
          v.title ? `Venue: ${v.title}` : '',
          v.note,
          m.source ? `Source: ${m.source}` : '',
          via ? `Matched via ${via}` : '',
        ].filter(Boolean).join('\n');
        container.append(badge(`jq-list ${tierClass(m, v.rank)}`, text, tip, url));
      }
    }
    if (!any) {
      const why = {
        preprint: 'Preprint / no published venue found',
        'venue not ranked': 'Venue found but not in any ranking table',
        'no match': 'Paper not found in Semantic Scholar or Crossref',
        'no title': 'No title to search',
        'no venue': 'No venue information',
      }[res.note] || (res.note || 'No ranking found');
      const tip = [why, matched, via ? `via ${via}` : '', 'Click to retry (bypasses cache).'].filter(Boolean).join('\n');
      const b = badge('jq-na', 'N/A', tip, url);
      if (!url) b.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); resolveItem(container, item, true); });
      container.append(b);
    }
  }

  function renderWaiting(container) {
    container.replaceChildren(badge('jq-wait', '…', 'Looking up ranking…'));
  }

  // ---------------------------------------------------------------- resolution

  function withTimeout(promise, ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ status: 'error', reason: 'timed out', retryable: true }), ms);
      promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); resolve({ status: 'error', reason: e && e.message ? e.message : String(e), retryable: true }); });
    });
  }

  async function resolveItem(container, item, force = false) {
    renderWaiting(container);
    let res;
    try {
      res = await withTimeout(api.runtime.sendMessage({ type: 'resolve', ...item, force }), RESULT_TIMEOUT_MS);
    } catch (e) {
      res = { status: 'error', reason: e && e.message ? e.message : String(e) };
    }
    if (!res) res = { status: 'error', reason: 'empty response from background' };
    render(container, item, res);
  }

  function mount(after, item, appendInside = false) {
    const container = document.createElement('span');
    container.className = 'jq-badges';
    if (appendInside) after.append(container); else after.insertAdjacentElement('afterend', container);
    resolveItem(container, item);
  }

  // ---------------------------------------------------------------- pages

  function processSearchResults() {
    const rows = document.querySelectorAll('#gs_res_ccl_mid .gs_r.gs_or.gs_scl, #gs_res_ccl_mid .gs_r.gs_or');
    rows.forEach((row) => {
      if (row.dataset.jqDone) return;
      const h3 = row.querySelector('h3.gs_rt');
      const metaEl = row.querySelector('.gs_a');
      if (!h3 || !metaEl) return;
      row.dataset.jqDone = '1';
      const title = titleFrom(h3);
      const meta = Norm.parseScholarMeta(metaEl.textContent);
      const key = row.dataset.cid || Norm.hash(`${Norm.titleKey(title)}|${Norm.nameKey(meta.venue)}`);
      const anchor = h3.querySelector('a') || h3.lastElementChild;
      const item = { key, title, venue: meta.venue, truncated: meta.truncated, truncStart: meta.truncStart, truncEnd: meta.truncEnd, year: meta.year, firstAuthor: meta.firstAuthor, domain: meta.domain };
      if (anchor) mount(anchor, item); else mount(h3, item, true);
    });
  }

  function processProfileRows() {
    document.querySelectorAll('#gsc_a_b tr.gsc_a_tr').forEach((row) => {
      if (row.dataset.jqDone) return;
      const link = row.querySelector('td.gsc_a_t a.gsc_a_at, td.gsc_a_t a');
      if (!link) return;
      row.dataset.jqDone = '1';
      const grays = row.querySelectorAll('td.gsc_a_t .gs_gray');
      const authors = grays[0] ? cleanText(grays[0].textContent) : '';
      let venue = '';
      if (grays[1]) {
        const clone = grays[1].cloneNode(true);
        clone.querySelectorAll('.gs_oph').forEach((n) => n.remove());
        venue = cleanText(clone.textContent).replace(/[,\s]+$/, '');
      }
      const truncStart = /^…/.test(venue), truncEnd = /…$/.test(venue), truncated = /…/.test(venue);
      venue = Norm.stripVolumePages(venue.replace(/…/g, ' ').replace(/\s+/g, ' ').trim());
      const year = cleanText(row.querySelector('td.gsc_a_y')?.textContent || '');
      const title = titleFrom(link);
      const firstAuthor = (authors.split(',')[0] || '').trim().split(' ').pop() || '';
      const key = Norm.hash(`${Norm.titleKey(title)}|${Norm.nameKey(venue)}`);
      mount(link, { key, title, venue, truncated, truncStart, truncEnd, year, firstAuthor });
    });
  }

  function observe(target, fn) {
    if (!target) return;
    let pending = false;
    const obs = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; fn(); }, 150);
    });
    obs.observe(target, { childList: true, subtree: true });
  }

  async function main() {
    try {
      settings = { ...DEFAULTS, ...(await api.storage.sync.get(DEFAULTS)) };
    } catch { /* keep defaults */ }
    if (!settings.ext_on) return;
    // List labels / scales are needed for the first badges; the background loads the tables anyway.
    dataMeta = await withTimeout(api.runtime.sendMessage({ type: 'meta', light: true }), 10000).catch(() => null);
    if (dataMeta && dataMeta.status === 'error') dataMeta = null;

    const path = location.pathname;
    if (path === '/scholar') {
      processSearchResults();
      observe(document.querySelector('#gs_res_ccl_mid'), processSearchResults);
    } else if (path.startsWith('/citations')) {
      processProfileRows();
      observe(document.querySelector('#gsc_a_b') || document.body, processProfileRows);
    }
  }

  main();
})();

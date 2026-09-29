// Parser for user-imported ranking lists (options page). Accepts the formats of Rapid-Journal-Quality-Check:
//   CSV / TSV / ;-separated with a header: ISSN, Name|Journal|Title, Rank|Rating, Description
//   JSON: {"1234-5678": "A*", "Journal": "B"} | [{issn, name, rank, description}] | {"key": {name, rank, description}}
// Returns [{ title, issns, rank, desc }]; throws Error with a readable message.
// Classic script: exposes a global `CustomList`; CommonJS-exported for node tests.

const CustomList = (() => {
  const MAX_ENTRIES = 50000;
  const ISSN_RE = /^\s*\d{4}-?\d{3}[\dXx]\s*$/;

  const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

  function splitIssns(v) {
    return clean(v).split(/[,;/ ]+/).filter((x) => ISSN_RE.test(x)).map((x) => x.toUpperCase().replace('-', '').replace(/^(\d{4})/, '$1-'));
  }

  function entry(title, issns, rank, desc) {
    rank = clean(rank);
    title = clean(title);
    issns = [...new Set(issns)];
    if (!rank || (!title && !issns.length)) return null;
    return { title, issns, rank, desc: clean(desc) };
  }

  // Minimal RFC 4180 reader: quoted fields, doubled quotes, newlines inside quotes.
  function readDelimited(text, delim) {
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
        } else field += c;
      } else if (c === '"' && field === '') quoted = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((f) => f.trim() !== ''));
  }

  function parseCsv(text) {
    const firstLine = text.split(/\r?\n/, 1)[0];
    const delim = ['\t', ';', ','].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = readDelimited(text, delim);
    if (rows.length < 2) throw new Error('CSV needs a header row and at least one data row');
    const header = rows[0].map((h) => clean(h).toLowerCase());
    const col = (...names) => header.findIndex((h) => names.includes(h));
    const iIssn = header.findIndex((h) => /^(e-?)?issn/.test(h));
    const iIssns = header.map((h, i) => (/issn/.test(h) ? i : -1)).filter((i) => i >= 0);
    const iName = col('name', 'journal', 'title', 'journal title', 'journal name', 'venue', 'source', 'acronym');
    const iRank = col('rank', 'rating', 'ranking', 'grade', 'score', 'class', 'category');
    const iDesc = col('description', 'desc', 'note', 'notes', 'comment');
    if (iIssn < 0 && iName < 0) throw new Error('CSV must contain an ISSN or a journal name column');
    if (iRank < 0) throw new Error('CSV must contain a rank / rating column');
    return rows.slice(1).map((r) => entry(
      iName >= 0 ? r[iName] : '', iIssns.flatMap((i) => splitIssns(r[i])), r[iRank], iDesc >= 0 ? r[iDesc] : '',
    ));
  }

  function fromObject(key, v) {
    if (v && typeof v === 'object') {
      const name = v.name ?? v.journal ?? v.title ?? '';
      const issns = splitIssns([v.issn, v.eissn, v.ISSN].filter(Boolean).join(','));
      if (ISSN_RE.test(key)) issns.push(...splitIssns(key));
      return entry(name || (ISSN_RE.test(key) ? '' : key), issns, v.rank ?? v.rating, v.description ?? v.desc);
    }
    return ISSN_RE.test(key) ? entry('', splitIssns(key), v, '') : entry(key, [], v, '');
  }

  function parseJson(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error(`invalid JSON: ${e.message}`); }
    if (Array.isArray(data)) return data.map((v) => fromObject('', v));
    if (data && typeof data === 'object') return Object.entries(data).map(([k, v]) => fromObject(k, v));
    throw new Error('JSON must be an object or an array');
  }

  function parse(text, filename = '') {
    text = String(text || '').replace(/^﻿/, '').trim();
    if (!text) throw new Error('nothing to import');
    const json = /\.json$/i.test(filename) || /^[[{]/.test(text);
    const entries = (json ? parseJson(text) : parseCsv(text)).filter(Boolean);
    if (!entries.length) throw new Error('no usable rows (each needs a rank and an ISSN or a name)');
    if (entries.length > MAX_ENTRIES) throw new Error(`too many rows (${entries.length}, max ${MAX_ENTRIES})`);
    return entries;
  }

  return { parse };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CustomList;

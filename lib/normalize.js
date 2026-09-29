// Text normalization and similarity helpers shared by background, content script and tests.
// Classic script: exposes a global `Norm`; also CommonJS-exported for node tests.

const Norm = (() => {
  // Function words dropped from every key.
  const STOP = new Set([
    'the', 'of', 'on', 'and', 'for', 'in', 'a', 'an', 'to', 'at', 'with', 'its',
    'de', 'la', 'le', 'les', 'des', 'du', 'et', 'el', 'y', 'und', 'der', 'die', 'das', 'fur',
  ]);

  // Extra words dropped only when building conference keys. "workshop" is kept on purpose so
  // "X Workshops" does not collapse onto the main conference "X".
  const CONF_NOISE = new Set([
    'proceedings', 'proc', 'annual', 'international', 'intl', 'ieee', 'acm', 'cvf', 'rsj',
    'conference', 'conf', 'symposium', 'symp', 'meeting', 'congress', 'colloquium',
    'part', 'vol', 'volume', 'pp', 'pages', 'th', 'st', 'nd', 'rd', 'eds', 'ed',
    'ieeeacm', 'acmieee', 'usenix', 'joint', 'sig',
  ]);

  const CONF_SIGNAL = /\b(conference|conf\.?|symposium|symp\.?|proceedings|proc\.?|workshop|meeting|congress|colloquium|forum|summit)\b/i;

  const PREPRINT = /^(arxiv|biorxiv|medrxiv|ssrn|preprint|research square|chemrxiv|techrxiv|osf preprints|hal|zenodo|corr)\b/i;

  function stripDiacritics(s) {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  // Lowercase ASCII words only.
  function normalize(s) {
    return stripDiacritics(String(s || ''))
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function tokens(s) {
    const n = normalize(s);
    return n ? n.split(' ').map((t) => (t === 'workshops' ? 'workshop' : t)) : [];
  }

  function isOrdinalOrNumber(t) {
    return /^\d+(st|nd|rd|th)?$/.test(t) || /^(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|fortieth|fiftieth)$/.test(t);
  }

  // Key used for journal-name lookup: stop words removed.
  function nameKey(s) {
    return tokens(s).filter((t) => !STOP.has(t)).join(' ');
  }

  // Key used for conference lookup: parentheticals, years, ordinals and boilerplate removed.
  function confKey(s) {
    const noParens = String(s || '').replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
    return tokens(noParens)
      .filter((t) => !STOP.has(t) && !CONF_NOISE.has(t) && !isOrdinalOrNumber(t) && !/^sig[a-z]{2,}$/.test(t))
      .join(' ');
  }

  // Key used to compare paper titles.
  function titleKey(s) {
    return tokens(s).filter((t) => !STOP.has(t)).join(' ');
  }

  function hasConfSignal(s) {
    return CONF_SIGNAL.test(String(s || ''));
  }

  function hasWorkshopSignal(s) {
    return tokens(s).includes('workshop');
  }

  // "<conference> Workshops [(ACRO)] [year]" -> "<conference>"; '' when "workshop(s)" is not the last word.
  // Parentheticals and years after it are ignored: "… Pattern Recognition Workshops (CVPRW)" -> "… Pattern Recognition".
  function stripTrailingWorkshops(s) {
    const noParens = String(s || '').replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
    const m = noParens.match(/^(.*?\S)[\s\-–—:,]+workshops?(?:[\s\-–—:,]+(?:\d{4}|'\d{2}|proceedings))*[\s.,]*$/i);
    return m ? m[1].trim() : '';
  }

  function isPreprintVenue(s) {
    return PREPRINT.test(String(s || '').trim());
  }

  function acroKey(s) {
    return stripDiacritics(String(s || '')).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function issnKey(s) {
    const k = String(s || '').toUpperCase().replace(/[^0-9X]/g, '');
    return k.length === 8 ? k : '';
  }

  // Candidate acronyms appearing verbatim in a venue string ("... CHI Conference ...", "Computer Vision – ECCV 2020").
  const ACRO_BLOCKLIST = new Set(['IEEE', 'ACM', 'USA', 'UK', 'EU', 'USENIX', 'SIAM', 'AAAS', 'CVF', 'RSJ', 'PDF', 'HTML', 'DOI', 'ISBN', 'ISSN', 'LNCS', 'CEUR', 'AIP', 'SPIE', 'ASME', 'SAE', 'ICPS']);
  function embeddedAcronyms(s) {
    const out = [];
    for (const raw of String(s || '').split(/[^A-Za-z0-9]+/)) {
      if (raw.length < 3 || raw.length > 10) continue;
      const upper = (raw.match(/[A-Z]/g) || []).length;
      if (upper < 2) continue;                 // needs at least two capitals: CHI, NeurIPS, SIGIR
      if (!/^[A-Z]/.test(raw)) continue;
      if (/^\d/.test(raw)) continue;
      const k = acroKey(raw);
      if (ACRO_BLOCKLIST.has(k)) continue;
      if (!out.includes(k)) out.push(k);
    }
    return out;
  }

  // Sørensen–Dice over token sets.
  function dice(a, b) {
    const A = new Set(a), B = new Set(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    return (2 * inter) / (A.size + B.size);
  }

  // Similarity of two paper titles in [0, 1]; 1 when one is the other plus a subtitle.
  function titleScore(a, b) {
    const ka = titleKey(a), kb = titleKey(b);
    if (!ka || !kb) return 0;
    if (ka === kb) return 1;
    const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
    if (short.split(' ').length >= 3 && long.startsWith(short + ' ')) return 0.95;
    return dice(ka.split(' '), kb.split(' '));
  }

  // True when two paper titles refer to the same work.
  function sameTitle(a, b) {
    return titleScore(a, b) >= 0.8;
  }

  // Parse the Google Scholar "gs_a" line: "A Author, B Author - Venue, 2019 - domain.org"
  function parseScholarMeta(text) {
    const clean = String(text || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
    const parts = clean.split(/ - /);
    const authorsPart = parts[0] || '';
    let venuePart = '';
    if (parts.length >= 3) venuePart = parts.slice(1, -1).join(' - ');
    else if (parts.length === 2) venuePart = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(parts[1]) ? '' : parts[1];
    let year = '';
    const ym = venuePart.match(/(?:^|,\s*)(\d{4})\s*$/);
    if (ym) {
      year = ym[1];
      venuePart = venuePart.slice(0, ym.index).replace(/[,\s]+$/, '');
    }
    const truncStart = /^(…|\.\.\.)/.test(venuePart);
    const truncEnd = /(…|\.\.\.)$/.test(venuePart);
    const truncated = truncStart || truncEnd || /…/.test(venuePart);
    const venue = venuePart.replace(/…|\.\.\./g, ' ').replace(/\s+/g, ' ').trim();
    const firstAuthor = (authorsPart.split(',')[0] || '').replace(/…/g, '').trim();
    // "A Vaswani" -> "Vaswani"
    const surname = firstAuthor.split(' ').filter(Boolean).pop() || '';
    const last = parts.length >= 2 ? parts[parts.length - 1].trim() : '';
    const domain = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(last) ? last.toLowerCase() : '';
    return { venue, truncated, truncStart, truncEnd, year, firstAuthor: surname, domain };
  }

  // Profile pages print "Nature 521 (7553), 436-444" / "Advances in neural information processing systems 25":
  // drop the trailing volume / issue / pages block.
  function stripVolumePages(s) {
    return String(s || '')
      // " 521 (7553), 436-444", " 9 (Nov), 2579-2605", " 25", ", 807-814", " 10 (3), e0118432"
      .replace(/[\s,]+\d+[\s,]*(?:\([^)]{0,24}\))?(?:[\d\s,.:\-–—]|e\d)*$/, '')
      .replace(/[,\s]+$/, '')
      .trim();
  }

  // 32-bit FNV-1a, hex.
  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  return {
    normalize, tokens, nameKey, confKey, titleKey, acroKey, issnKey,
    hasConfSignal, hasWorkshopSignal, stripTrailingWorkshops, isPreprintVenue, embeddedAcronyms, dice, titleScore, sameTitle, parseScholarMeta, stripVolumePages, hash,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Norm;

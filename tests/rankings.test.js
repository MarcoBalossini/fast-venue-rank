const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Norm = require('../lib/normalize.js');
const Rankings = require('../lib/rankings.js');

const read = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', `${n}.json`), 'utf8'));
Rankings.build(read('sjr'), read('core'), read('lists'));
const CustomList = require('../lib/customlist.js');

test('parseScholarMeta', () => {
  const m = Norm.parseScholarMeta('A Vaswani, N Shazeer, N Parmar… - Advances in neural …, 2017 - proceedings.neurips.cc');
  assert.equal(m.venue, 'Advances in neural');
  assert.equal(m.truncated, true);
  assert.equal(m.year, '2017');
  assert.equal(m.firstAuthor, 'Vaswani');
  assert.equal(m.domain, 'proceedings.neurips.cc');

  const j = Norm.parseScholarMeta('K He, X Zhang, S Ren, J Sun - Proceedings of the IEEE conference on computer vision and pattern recognition, 2016 - openaccess.thecvf.com');
  assert.equal(j.venue, 'Proceedings of the IEEE conference on computer vision and pattern recognition');
  assert.equal(j.truncated, false);

  const noVenue = Norm.parseScholarMeta('J Doe - 2020 - books.google.com');
  assert.equal(noVenue.venue, '');
  assert.equal(noVenue.year, '2020');

  const twoParts = Norm.parseScholarMeta('J Doe - Some Journal, 2019');
  assert.equal(twoParts.venue, 'Some Journal');
  assert.equal(twoParts.year, '2019');
});

test('title similarity', () => {
  assert.ok(Norm.sameTitle('Attention is all you need', 'Attention is All you Need'));
  assert.ok(Norm.sameTitle('BERT: Pre-training of deep bidirectional transformers', 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding'));
  assert.ok(!Norm.sameTitle('Deep residual learning for image recognition', 'Identity mappings in deep residual networks'));
  assert.ok(!Norm.sameTitle('TinyOS: An operating system for sensor networks', 'TinyOS: An Open Operating System for Wireless Sensor Networks (Invited Seminar)'));
  assert.ok(Norm.sameTitle('Attention is all you need', 'Attention Is All You Need: Transformers Revisited'));
});

test('CORE local matches from Scholar venue strings', () => {
  const cases = [
    ['Proceedings of the IEEE/CVF conference on computer vision and pattern recognition', 'CVPR', 'A*'],
    ['Proceedings of the IEEE conference on computer vision and pattern recognition', 'CVPR', 'A*'],
    ['Proceedings of the IEEE/CVF international conference on computer vision', 'ICCV', 'A*'],
    ['Advances in neural information processing systems', 'NeurIPS', 'A*'],
    ['International conference on machine learning', 'ICML', 'A*'],
    ['International Conference on Learning Representations', 'ICLR', 'A*'],
    ['Proceedings of the 2019 CHI Conference on Human Factors in Computing Systems', 'CHI', 'A*'],
    ['Proceedings of the 26th ACM SIGKDD International Conference on Knowledge Discovery & Data Mining', 'KDD', 'A*'],
    ['Proceedings of the 2020 ACM SIGSAC Conference on Computer and Communications Security', 'CCS', 'A*'],
    ['European conference on computer vision', 'ECCV', 'A*'],
    ['Computer Vision–ECCV 2020: 16th European Conference, Glasgow, UK, August 23–28, 2020, Proceedings, Part I', 'ECCV', 'A*'],
    ['Proceedings of the AAAI conference on artificial intelligence', 'AAAI', 'A*'],
    ['Proceedings of the IEEE international conference on robotics and automation', 'ICRA', 'A*'],
    ['2020 IEEE/RSJ International Conference on Intelligent Robots and Systems (IROS)', 'IROS', 'A'],
    ['Proceedings of the 2021 Conference on Empirical Methods in Natural Language Processing', 'EMNLP', 'A*'],
  ];
  for (const [venue, acro, rank] of cases) {
    const hit = Rankings.coreByEmbeddedAcronym(venue) || Rankings.coreByName(venue);
    assert.ok(hit, `no CORE match for "${venue}"`);
    assert.equal(hit.acro, acro, `"${venue}" -> ${hit.acro}`);
    assert.equal(hit.rank, rank);
  }
});

test('CORE must not match journals or workshops', () => {
  assert.equal(Rankings.coreByName('Machine learning'), null);                          // Springer journal, not ICML
  assert.equal(Rankings.coreByName('Transactions of the Association for Computational Linguistics'), null);
  const w = Rankings.coreByName('Proceedings of the IEEE/CVF conference on computer vision and pattern recognition workshops');
  assert.ok(!w || w.acro !== 'CVPR', 'CVPR Workshops must not resolve to CVPR');
  assert.equal(Rankings.coreByName('Nature'), null);
});

test('workshop papers: detected, host conference resolved, CORE-ranked workshop series untouched', () => {
  const ws = (v, typed = false) => Rankings.workshopOf(v, typed);
  const host = (v, typed = false) => { const w = ws(v, typed); return w && w.host ? `${w.host.acro} ${w.host.rank}` : (w ? 'WS/-' : null); };
  // "<conference> Workshops" (Scholar, IEEE Crossref/S2 strings, Springer volumes)
  assert.equal(host('Proceedings of the IEEE/CVF conference on computer vision and pattern recognition workshops'), 'CVPR A*');
  assert.equal(host('2017 IEEE Conference on Computer Vision and Pattern Recognition Workshops (CVPRW)'), 'CVPR A*');
  assert.equal(host('2019 IEEE/CVF International Conference on Computer Vision Workshop (ICCVW)'), 'ICCV A*');
  assert.equal(host('Computer Vision – ECCV 2018 Workshops'), 'ECCV A*');
  assert.equal(host('European conference on computer vision workshops'), 'ECCV A*');
  assert.equal(host('2016 IEEE International Conference on Data Mining Workshops (ICDMW)'), 'ICDM A*');
  assert.equal(host('IEEE Winter Conference on Applications of Computer Vision Workshops (WACVW)'), 'WACV A');
  assert.equal(host('on computer vision and pattern recognition workshops'), 'CVPR A*');   // "… " truncated by Scholar
  // "<ACRO> Workshop on …", "… at <ACRO>", "co-located with …"
  assert.equal(host('NeurIPS 2023 Workshop on Distribution Shifts'), 'NeurIPS A*');
  assert.equal(host('ICLR 2024 Workshop on Large Language Model Agents'), 'ICLR A*');
  assert.equal(host('Workshop on Machine Learning for Healthcare at ICML 2022'), 'ICML A*');
  assert.equal(host('Proceedings of the 1st Workshop on Trustworthy NLP co-located with the 30th International Joint Conference on Artificial Intelligence (IJCAI 2021)'), 'IJCAI A*');
  // workshop, host unknown
  assert.equal(host('Proceedings of the 2nd Clinical Natural Language Processing Workshop'), 'WS/-');
  assert.equal(host('CEUR Workshop Proceedings'), 'WS/-');
  assert.equal(host('Workshop on Machine Learning'), 'WS/-');     // must not become ICML
  assert.equal(host('Machine Learning Workshop'), 'WS/-');
  // CORE-ranked series that are called workshops are conferences, not workshop papers
  for (const v of ['IEEE Workshop on Applications of Computer Vision (WACV)', 'IEEE Information Theory Workshop', '2019 IEEE Information Theory Workshop (ITW)',
    'Proceedings of the 2019 ACM SIGPLAN Workshop on Partial Evaluation and Program Manipulation', 'International Conference and Workshops on Algorithms and Computation', 'Haskell Workshop']) {
    assert.equal(ws(v), null, `"${v}" wrongly flagged as workshop paper`);
    assert.ok(Rankings.coreByEmbeddedAcronym(v) || Rankings.coreByName(v), `"${v}" not ranked`);
  }
  // not workshops at all
  assert.equal(ws('Advances in neural information processing systems'), null);
  assert.equal(ws('International conference on machine learning'), null);
  // acronyms / dblp keys of workshop tracks resolve to the host but never to a main-track ranking
  assert.equal(Rankings.workshopHostByAcro('CVPRW').acro, 'CVPR');
  assert.equal(Rankings.workshopHostByAcro('iccvw').acro, 'ICCV');
  assert.equal(Rankings.workshopHostByAcro('NeurIPS').acro, 'NeurIPS');
  assert.equal(Rankings.workshopHostByAcro('XYZW'), null);
  assert.equal(Rankings.coreByAcro('CVPRW'), null);
  assert.equal(Rankings.coreByAcro('iccvw'), null);
});

test('CORE acronym / dblp aliases', () => {
  assert.equal(Rankings.coreByAcro('NeurIPS').acro, 'NeurIPS');
  assert.equal(Rankings.coreByAcro('nips').acro, 'NeurIPS');
  assert.equal(Rankings.coreByAcro('S&P').acro, 'SP');
  assert.equal(Rankings.coreByAcro('uss').acro, 'USENIX-Security');
  assert.equal(Rankings.coreByAcro('FSE'), null);   // ambiguous: Foundations of Software Eng. vs Fast Software Encryption
  assert.equal(Rankings.coreByAcro('ICML2023').acro, 'ICML');
  assert.equal(Rankings.coreByAcro('XYZNOPE'), null);
});

test('ambiguous acronyms / names are disambiguated by the full venue string', () => {
  assert.equal(Rankings.coreByAcro('SAC'), null);                                             // no context: ambiguous
  const sac = Rankings.coreByAcro("SAC '23", "SAC '23: 38th ACM/SIGAPP Symposium on Applied Computing");
  assert.ok(sac && /Applied Computing/.test(sac.title) && sac.rank === 'other' && /multiconference/i.test(sac.raw));
  const crypto = Rankings.coreByAcro('SAC', 'Selected Areas in Cryptography – SAC 2019');
  assert.ok(crypto && crypto.rank === 'B');
  const byName = Rankings.coreByName('Proceedings of the 38th ACM/SIGAPP Symposium on Applied Computing');
  assert.ok(byName && /ACM Symposium on Applied Computing/.test(byName.title), `got ${byName && byName.title}`);
  const s2name = Rankings.coreByName('ACM Symposium on Applied Computing', true);
  assert.ok(s2name && /ACM Symposium on Applied Computing/.test(s2name.title));
});

test('multiconference: prefer a ranked member conference when one is named', () => {
  const v = 'Tools and Algorithms for the Construction and Analysis of Systems: 26th International Conference, TACAS 2020, Held as Part of the European Joint Conferences on Theory and Practice of Software, ETAPS 2020';
  const hit = Rankings.coreByEmbeddedAcronym(v);
  assert.ok(hit && hit.acro === 'TACAS', `got ${hit && hit.acro}`);
  const sac = Rankings.coreByName('Proceedings of the 38th ACM/SIGAPP Symposium on Applied Computing');
  const refined = Rankings.refineMulticonference(sac, ['Proceedings of the 38th ACM/SIGAPP Symposium on Applied Computing']);
  assert.ok(Rankings.isMulticonference(refined) && !refined.partOf);   // SAC tracks are not in ICORE: stays multiconference
});

test('SJR local matches', () => {
  const jmlr = Rankings.sjrByName('Journal of machine learning research');
  assert.ok(jmlr && jmlr.q === 'Q1', 'JMLR should be Q1');
  const tpami = Rankings.sjrByName('IEEE transactions on pattern analysis and machine intelligence');
  assert.ok(tpami && tpami.q === 'Q1');
  assert.ok(Rankings.sjrByName('Nature').q === 'Q1');
  assert.ok(Rankings.sjrByName('The Lancet').q === 'Q1');
  assert.ok(Rankings.sjrByIssn('0028-0836'));   // Nature
  assert.ok(Rankings.sjrByIssn('00280836'));
  assert.equal(Rankings.sjrByIssn('0000-0000'), null);
});

test('truncated venues only accept unique prefixes', () => {
  assert.equal(Rankings.coreByPrefix('International conference on'), null);
  assert.equal(Rankings.sjrByPrefix('Journal of'), null);
  const c = Rankings.coreByPrefix('Proceedings of the IEEE/CVF conference on computer vision and');
  assert.ok(!c || c.acro !== 'ICCV', 'ambiguous CVPR/ICCV prefix must not resolve to ICCV');
  const j = Rankings.sjrByPrefix('IEEE transactions on pattern analysis and machine');
  assert.ok(j && j.q === 'Q1');
  // leading ellipsis: "… image analysis" must not prefix-match "Image Analysis & Stereology"
  const lead = Norm.parseScholarMeta('G Litjens, T Kooi… - … image analysis, 2017 - Elsevier');
  assert.equal(lead.truncStart, true); assert.equal(lead.truncEnd, false); assert.equal(lead.venue, 'image analysis');
  const s = Rankings.sjrByPrefix(lead.venue, lead.truncStart, lead.truncEnd);
  assert.ok(!s || /medical image analysis/i.test(s.title), `unexpected suffix match: ${s && s.title}`);
  const uniqueSuffix = Rankings.sjrByPrefix('transactions on pattern analysis and machine intelligence', true, false);
  assert.ok(uniqueSuffix && uniqueSuffix.q === 'Q1');
});

test('profile venue strings drop volume/pages', () => {
  assert.equal(Norm.stripVolumePages('Nature 521 (7553), 436-444'), 'Nature');
  assert.equal(Norm.stripVolumePages('Advances in neural information processing systems 25'), 'Advances in neural information processing systems');
  assert.equal(Norm.stripVolumePages('Journal of machine learning research 15 (1), 1929-1958'), 'Journal of machine learning research');
  assert.equal(Norm.stripVolumePages('Proceedings of the 27th international conference on machine learning (ICML-10), 807-814'), 'Proceedings of the 27th international conference on machine learning (ICML-10)');
  assert.equal(Norm.stripVolumePages('arXiv preprint arXiv:1207.0580'), 'arXiv preprint arXiv:1207.0580');
  assert.equal(Norm.stripVolumePages('Science 313 (5786), 504-507'), 'Science');
  assert.equal(Norm.stripVolumePages('Journal of Machine Learning Research 9 (Nov), 2579-2605'), 'Journal of Machine Learning Research');
  assert.equal(Norm.stripVolumePages('PLoS one 10 (3), e0118432'), 'PLoS one');
  assert.equal(Norm.stripVolumePages('Physical Review D 100 (2), 023001'), 'Physical Review D');
  assert.equal(Norm.stripVolumePages('Computer Vision–ECCV 2020: 16th European Conference, Proceedings, Part I'), 'Computer Vision–ECCV 2020: 16th European Conference, Proceedings, Part I');
  assert.equal(Rankings.sjrByName(Norm.stripVolumePages('Nature 521 (7553), 436-444')).q, 'Q1');
  assert.equal((Rankings.coreByEmbeddedAcronym(Norm.stripVolumePages('Proceedings of the 27th international conference on machine learning (ICML-10), 807-814')) || {}).acro, 'ICML');
});

test('domain hints', () => {
  assert.equal(Rankings.coreByDomain('proceedings.neurips.cc').acro, 'NeurIPS');
  assert.equal(Rankings.coreByDomain('proceedings.iclr.cc').acro, 'ICLR');
  assert.equal(Rankings.coreByDomain('arxiv.org'), null);
});

test('preprint detection', () => {
  assert.ok(Norm.isPreprintVenue('arXiv preprint arXiv:1706.03762'));
  assert.ok(Norm.isPreprintVenue('bioRxiv'));
  assert.ok(!Norm.isPreprintVenue('Nature'));
});

test('other lists by ISSN, name and dblp key', () => {
  const ms = Rankings.listsFor({ issns: ['0025-1909'] });
  assert.equal(ms.ABDC.rank, 'A*');
  assert.equal(ms.VHB.rank, 'A+');
  assert.equal(ms.AJG.rank, '4*');
  assert.equal(ms.FT50.rank, 'FT50');
  assert.ok(ms.FNEGE && ms.HCERES && ms.CNRS && ms.BFI);

  // print-only and online-only ISSN rows are merged through SJR
  const jfe = Rankings.listsFor({ issns: Rankings.sjrByName('Journal of financial economics').issns });
  assert.equal(jfe.VHB.rank, 'A+');
  assert.equal(jfe.ABDC.rank, 'A*');

  // name only (no ISSN known)
  assert.equal(Rankings.listsFor({ names: ['Journal of Financial Economics'] }).FT50.rank, 'FT50');
  assert.equal(Rankings.listsFor({ names: ['Journal of Nothing Whatsoever'] }), null);

  // CCF: dblp stream, acronym confirmed by title, never by a bare acronym
  assert.equal(Rankings.listsFor({ dblp: 'conf/cvpr/HeZRS16' }).CCF.rank, 'A');
  assert.equal(Rankings.listsFor({ dblp: 'journals/pami/X20' }).CCF.rank, 'A');
  assert.equal(Rankings.listsFor({ acros: ['ICSE'], confNames: ['International Conference on Software Engineering'] }).CCF.rank, 'A');
  assert.equal(Rankings.listsFor({ acros: ['ICSE'], confNames: ['Irish Conference on Sheep Economics'] }), null);
});

test('SJR by name falls back to list ISSNs', () => {
  const s = Rankings.sjrByName('MIS quarterly');
  assert.ok(s);
  assert.equal(s.title, 'MIS Quarterly: Management Information Systems');
});

test('custom list parsing and matching', () => {
  const csv = CustomList.parse('ISSN,Name,Rank,Description\n0025-1909,Management Science,A*,"top, really"\n,CVPR,1,\n,No rank,,\n');
  assert.equal(csv.length, 2);
  assert.deepEqual(csv[0], { title: 'Management Science', issns: ['0025-1909'], rank: 'A*', desc: 'top, really' });

  const semi = CustomList.parse('Journal;Rating\nNature;A+\n');
  assert.deepEqual(semi, [{ title: 'Nature', issns: [], rank: 'A+', desc: '' }]);

  assert.equal(CustomList.parse('{"1234-5678": "A*", "Some Journal": "B"}').length, 2);
  assert.equal(CustomList.parse('[{"issn": "1234-5678", "name": "X", "rank": "A"}]')[0].issns[0], '1234-5678');
  assert.equal(CustomList.parse('{"Y Journal": {"rank": "B", "description": "d"}}')[0].desc, 'd');
  assert.throws(() => CustomList.parse('Name,Foo\nX,1\n'), /rank/);
  assert.throws(() => CustomList.parse('{bad'), /invalid JSON/);

  Rankings.setCustom({ label: 'Uni', entries: csv });
  assert.equal(Rankings.listsFor({ issns: ['00251909'] }).CUSTOM.rank, 'A*');
  assert.equal(Rankings.listsFor({ acros: ['CVPR'] }).CUSTOM.rank, '1');
  assert.equal(Rankings.meta().lists.CUSTOM.label, 'Uni');
  Rankings.setCustom(null);
  assert.equal(Rankings.listsFor({ acros: ['CVPR'] }), null);
});

test('catalog validation', async () => {
  const Catalog = require('../lib/catalog.js');
  for (const name of Catalog.TABLES) assert.ok(Catalog.validate(name, read(name)));
  assert.throws(() => Catalog.validate('sjr', { journals: [] }), /too short/);
  assert.throws(() => Catalog.validate('lists', { lists: {}, journals: read('lists').journals, ccf: null }), /ccf/);
  assert.throws(() => Catalog.validate('core', null), /not an object/);

  const index = read('index');
  assert.ok(Catalog.validateIndex(index));
  assert.throws(() => Catalog.validateIndex({ ...index, schema: 99 }), /schema/);
  assert.throws(() => Catalog.validateIndex({ ...index, files: { ...index.files, sjr: { sha256: 'x' } } }), /sjr/);

  const bytes = fs.readFileSync(path.join(__dirname, '..', 'data', 'core.json'));
  assert.equal(await Catalog.sha256Hex(bytes), index.files.core.sha256);
});

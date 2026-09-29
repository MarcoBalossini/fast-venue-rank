#!/usr/bin/env node
// Runs the real background resolver in node (stubbed extension API, real network) on sample
// Scholar-like inputs. Usage: node scripts/smoke_resolve.js [--s2-key KEY] [--mailto EMAIL]
//                             [--title "Paper title" --meta "A Author - Venue, 2023 - domain.org"]  (single custom item)
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };

const mem = { sync: { s2ApiKey: opt('--s2-key'), crossrefMailto: opt('--mailto') }, local: {} };
const storageArea = (store) => ({
  async get(keys) {
    if (keys === null || keys === undefined) return { ...store };
    if (typeof keys === 'string') return { [keys]: store[keys] };
    if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, store[k]]));
    return { ...keys, ...Object.fromEntries(Object.keys(keys).filter((k) => k in store).map((k) => [k, store[k]])) };
  },
  async set(obj) { Object.assign(store, obj); },
  async remove(keys) { for (const k of [].concat(keys)) delete store[k]; },
});
let onMessage = null;
globalThis.api = {
  storage: { sync: storageArea(mem.sync), local: storageArea(mem.local), onChanged: { addListener() {} } },
  runtime: {
    getURL: (p) => path.join(__dirname, '..', p),
    onInstalled: { addListener() {} },
    onMessage: { addListener(fn) { onMessage = fn; } },
    openOptionsPage() {},
  },
  action: { onClicked: { addListener() {} } },
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (typeof url === 'string' && !/^https?:/.test(url)) {
    return new Response(fs.readFileSync(url), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
};
globalThis.Norm = require('../lib/normalize.js');
globalThis.Rankings = require('../lib/rankings.js');
require('../background.js');

const send = (msg) => new Promise((resolve) => onMessage(msg, {}, resolve));

const SAMPLES = [
  { title: 'Attention is all you need', meta: 'A Vaswani, N Shazeer, N Parmar… - Advances in neural …, 2017 - proceedings.neurips.cc' },
  { title: 'Deep residual learning for image recognition', meta: 'K He, X Zhang, S Ren, J Sun - Proceedings of the IEEE conference on computer vision and pattern recognition, 2016 - openaccess.thecvf.com' },
  { title: 'BERT: Pre-training of deep bidirectional transformers for language understanding', meta: 'J Devlin, MW Chang, K Lee… - arXiv preprint arXiv …, 2018 - arxiv.org' },
  { title: 'Language models are few-shot learners', meta: 'T Brown, B Mann, N Ryder… - Advances in neural …, 2020 - proceedings.neurips.cc' },
  { title: 'A survey on deep learning in medical image analysis', meta: 'G Litjens, T Kooi, BE Bejnordi… - Medical image analysis, 2017 - Elsevier' },
  { title: 'Scikit-learn: Machine learning in Python', meta: 'F Pedregosa, G Varoquaux… - Journal of machine learning research, 2011 - jmlr.org' },
  { title: 'Adam: A method for stochastic optimization', meta: 'DP Kingma, J Ba - arXiv preprint arXiv:1412.6980, 2014 - arxiv.org' },
  { title: 'The PageRank citation ranking: Bringing order to the web', meta: 'L Page, S Brin, R Motwani, T Winograd - 1999 - ilpubs.stanford.edu' },
  { title: 'A decentralized peer-to-peer electronic cash system', meta: 'S Nakamoto - 2008 - bitcoin.org' },
  { title: 'Spectre attacks: Exploiting speculative execution', meta: 'P Kocher, J Horn, A Fogh… - 2019 IEEE Symposium on Security and Privacy (SP), 2019 - ieeexplore.ieee.org' },
  { title: 'TinyOS: An operating system for sensor networks', meta: 'P Levis, S Madden, J Polastre… - Ambient intelligence, 2005 - Springer' },
  { title: 'Dynamo: Amazon\'s highly available key-value store', meta: 'G DeCandia, D Hastorun, M Jampani… - ACM SIGOPS operating …, 2007 - dl.acm.org' },
  // workshop papers: local venue string / Crossref (IEEE, Springer LNCS volume) / host unknown
  { title: 'NTIRE 2017 challenge on single image super-resolution: Methods and results', meta: 'R Timofte, E Agustsson… - Proceedings of the IEEE conference on computer vision and pattern recognition workshops, 2017 - openaccess.thecvf.com' },
  { title: 'NTIRE 2017 challenge on single image super-resolution: Methods and results', meta: 'R Timofte, E Agustsson… - 2017 - openaccess.thecvf.com' },
  { title: 'ESRGAN: Enhanced super-resolution generative adversarial networks', meta: 'X Wang, K Yu, S Wu, J Gu, Y Liu… - Proceedings of the …, 2018 - openaccess.thecvf.com' },
  { title: 'AIM 2019 challenge on video extreme super-resolution: Methods and results', meta: 'D Fuoli, S Gu, R Timofte… - 2019 - ieeexplore.ieee.org' },
  { title: 'Publicly available clinical BERT embeddings', meta: 'E Alsentzer, JR Murphy, W Boag… - arXiv preprint arXiv …, 2019 - arxiv.org' },
  // business / management journals: ABDC, VHB, AJG, FNEGE, HCERES, CNRS, BFI, FT50
  { title: 'Common risk factors in the returns on stocks and bonds', meta: 'EF Fama, KR French - Journal of financial economics, 1993 - Elsevier' },
  { title: 'User acceptance of information technology: Toward a unified view', meta: 'V Venkatesh, MG Morris, GB Davis… - MIS quarterly, 2003 - JSTOR' },
  { title: 'Dynamic capabilities and strategic management', meta: 'DJ Teece, G Pisano, A Shuen - Strategic management …, 1997 - Wiley Online Library' },
  { title: 'Why don\'t we practice what we preach? A meta-analytic review of the interplay between CSR and firm performance', meta: 'J Doe - 2020 - Elsevier' },
];

(async () => {
  const t0 = Date.now();
  const samples = opt('--title') ? [{ title: opt('--title'), meta: opt('--meta') || '' }] : SAMPLES;
  const results = await Promise.all(samples.map(async (s, i) => {
    const m = Norm.parseScholarMeta(s.meta);
    const started = Date.now();
    const r = await send({ type: 'resolve', key: `smoke${i}`, title: s.title, venue: m.venue, truncated: m.truncated, truncStart: m.truncStart, truncEnd: m.truncEnd, firstAuthor: m.firstAuthor, year: m.year, domain: m.domain });
    return { s, m, r, ms: Date.now() - started };
  }));
  for (const { s, m, r, ms } of results) {
    const sjr = r.sjr ? `SJR ${r.sjr.q} (${r.sjr.title})` : '';
    const core = r.core ? `CORE ${r.core.rank} (${r.core.acro})` : '';
    const ws = r.workshop ? `WORKSHOP${r.workshop.host ? ` @ ${r.workshop.host.acro} ${r.workshop.host.rank}` : ' (host unknown)'}` : '';
    const lists = r.lists ? Object.entries(r.lists).map(([k, v]) => `${k} ${v.rank}`).join(', ') : '';
    const tail = r.status === 'ok' ? [sjr, core, ws, lists].filter(Boolean).join(' | ') || `N/A [${r.note}]` : `ERROR ${r.reason}`;
    console.log(`${String(ms).padStart(6)} ms  ${(r.via || '-').padEnd(8)} ${s.title.slice(0, 48).padEnd(50)} venue="${m.venue}${m.truncated ? '…' : ''}"\n           -> ${tail}${r.matchedVenue ? `  [matched: ${r.matchedVenue}]` : ''}`);
  }
  console.log(`total ${Date.now() - t0} ms`);
  if (samples === SAMPLES) {
    const again = await send({ type: 'resolve', key: 'smoke0', title: SAMPLES[0].title, venue: 'Advances in neural', truncated: true });
    console.log('cache hit:', again.cached === true);
  }
})();

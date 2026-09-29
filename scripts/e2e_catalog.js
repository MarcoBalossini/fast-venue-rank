// Usage: node scripts/e2e_catalog.js      (needs chromium-browser)
// Catalog updater end to end: serves fake catalogs on 127.0.0.1, loads the extension in headless
// Chromium and drives updateCatalog() in the service worker. Checks that a newer table is downloaded
// and used, that a corrupted file is rejected, and that a catalog older than the bundled data is ignored.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const EXT = path.resolve(__dirname, '..');
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------- fake catalogs
const bundledIndex = JSON.parse(fs.readFileSync(path.join(EXT, 'data/index.json')));
const files = {};   // url path -> Buffer
function catalog(prefix, { built, tamper = false, edition }) {
  const index = { schema: 1, generated: new Date().toISOString(), files: {}, warnings: [] };
  for (const name of ['sjr', 'core', 'lists']) {
    let buf = fs.readFileSync(path.join(EXT, `data/${name}.json`));
    let b = bundledIndex.files[name].built;
    if (name === 'lists') {
      const json = JSON.parse(buf);
      json.built = built;
      json.lists.ABDC.edition = edition;
      buf = Buffer.from(JSON.stringify(json));
      b = built;
    }
    index.files[name] = { sha256: sha(buf), bytes: buf.length, built: b };
    if (tamper && name === 'lists') buf = Buffer.concat([buf.subarray(0, buf.length - 3), Buffer.from(' ]}')]);
    files[`/${prefix}/${name}.json`] = buf;
  }
  files[`/${prefix}/index.json`] = Buffer.from(JSON.stringify(index));
}
catalog('newer', { built: '2099-01-01', edition: 'NEWER' });
catalog('tampered', { built: '2099-02-01', tamper: true, edition: 'TAMPERED' });
catalog('older', { built: '2000-01-01', edition: 'OLDER' });

const server = http.createServer((req, res) => {
  const buf = files[req.url.split('?')[0]];
  if (!buf) { res.writeHead(404, { 'access-control-allow-origin': '*' }); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(buf);
});
const listening = new Promise((ok) => server.listen(0, '127.0.0.1', ok));

// ---------------------------------------------------------------- browser
const profile = path.join(os.tmpdir(), 'fast-venue-rank-e2e-catalog');
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn('chromium-browser', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  `--user-data-dir=${profile}`, `--load-extension=${EXT}`, `--remote-debugging-port=${PORT}`, 'about:blank',
], { stdio: 'ignore' });

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id); this.pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error))); else res(msg.result);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params, sessionId })); });
  }
}

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`); if (!ok) failures++; };

(async () => {
  try {
    await listening;
    const base = `http://127.0.0.1:${server.address().port}`;
    let version = null;
    for (let i = 0; i < 40 && !version; i++) { try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
    const browser = new CDP(version.webSocketDebuggerUrl); await browser.ready;
    let sw = null;
    for (let i = 0; i < 40 && !sw; i++) {
      const { targetInfos } = await browser.send('Target.getTargets');
      sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
      if (!sw) await sleep(250);
    }
    if (!sw) throw new Error('extension service worker not found');
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
    // The first evaluate can stall while the worker is still starting: warm up with a short timeout.
    for (let i = 0; i < 20; i++) {
      const probe = browser.send('Runtime.evaluate', { expression: 'typeof updateCatalog', returnByValue: true }, sessionId);
      const v = await Promise.race([probe, sleep(1000).then(() => null)]);
      if (v && v.result && v.result.value === 'function') break;
    }
    const run = async (expr) => {
      const r = await browser.send('Runtime.evaluate', { expression: `(async () => JSON.stringify(await (${expr})) ?? "null")()`, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return JSON.parse(r.result.value);
    };
    const update = async (prefix) => {
      await run(`api.storage.sync.set({ catalogUrl: '${base}/${prefix}/' })`);
      await sleep(100);
      return run('updateCatalog(true)');
    };
    const abdcEdition = () => run('ensureData().then(() => Rankings.meta().lists.ABDC.edition)');

    const bundledEdition = await abdcEdition();
    check('bundled tables load', !!bundledEdition, `ABDC edition ${bundledEdition}`);

    await run(`api.storage.local.set({ 'r:3:probe': { v: { status: 'ok' }, t: Date.now() } })`);
    let r = await update('newer');
    check('newer catalog downloaded', JSON.stringify(r.updated) === '["lists"]' && !r.error, `updated ${JSON.stringify(r.updated)} ${r.error || ''}`);
    check('newer table in use', (await abdcEdition()) === 'NEWER');
    check('lookup cache cleared', !(await run(`api.storage.local.get('r:3:probe')`))['r:3:probe']);
    const st = await run('catalogStatus()');
    check('status reports download', st.tables.lists.from === 'downloaded' && st.tables.sjr.from === 'bundled', JSON.stringify(st.tables));
    r = await update('newer');
    check('unchanged catalog not downloaded again', r.updated.length === 0 && !r.error);

    r = await update('tampered');
    check('corrupted file rejected', /checksum|size/.test(r.error || ''), r.error);
    check('previous table kept after rejection', (await abdcEdition()) === 'NEWER');

    r = await update('older');
    check('catalog older than bundled ignored', r.updated.length === 0 && !r.error, r.error);
    await run('(Rankings.reset(), true)');
    check('bundled table back in use', (await abdcEdition()) === bundledEdition);

    r = await run(`(api.storage.sync.set({ catalogUrl: '${base}/missing/' }), new Promise((ok) => setTimeout(ok, 100))).then(() => updateCatalog(true))`);
    check('unreachable catalog reports error, keeps data', /HTTP 404/.test(r.error || '') && (await abdcEdition()) === bundledEdition, r.error);

    const res = await run(`resolve({ type: 'resolve', key: 'x', title: 'Common risk factors', venue: 'Journal of financial economics' })`);
    check('resolver still works', res.lists && res.lists.ABDC && res.sjr, res.lists && Object.keys(res.lists).join(','));
  } catch (e) {
    console.log('ERROR', e.message);
    failures++;
  } finally {
    chrome.kill();
    server.close();
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  }
})();

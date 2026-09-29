// Usage: node scripts/e2e_chromium.js [query or Scholar URL]   (needs chromium-browser; branded Chrome >= 137 refuses --load-extension)
// Drive headless Chrome over CDP: verify extension loads, options page renders, Scholar badges settle.
const EXT = require('node:path').resolve(__dirname, '..');
const PORT = 9333;
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = require('node:path').join(require('node:os').tmpdir(), 'fast-venue-rank-e2e-profile');
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn('chromium-browser', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--window-size=1400,1000',
  `--user-data-dir=${profile}`, `--load-extension=${EXT}`, `--remote-debugging-port=${PORT}`,
  '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
chrome.stderr.on('data', (d) => { stderr += d; });

class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.events = [];
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && this.pending.has(msg.id)) { const {res, rej} = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); } else this.events.push(msg); };
  }
  send(method, params = {}, sessionId) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, {res, rej}); this.ws.send(JSON.stringify({ id, method, params, sessionId })); }); }
}

(async () => {
  try {
    let targets = [];
    for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(250); } }
    const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const browser = new CDP(version.webSocketDebuggerUrl); await browser.ready;
    // wait for the service worker target
    let sw = null;
    for (let i = 0; i < 40 && !sw; i++) {
      const { targetInfos } = await browser.send('Target.getTargets');
      sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
      if (!sw) await sleep(250);
    }
    console.log('service worker:', sw ? sw.url : 'NOT FOUND');
    if (!sw) throw new Error('extension service worker not found');
    const extId = new URL(sw.url).host;

    // attach to SW to collect console errors
    const { sessionId: swSession } = await browser.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
    await browser.send('Runtime.enable', {}, swSession);
    await browser.send('Log.enable', {}, swSession);

    async function openPage(url, waitMs, expr) {
      const { targetId } = await browser.send('Target.createTarget', { url });
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
      await browser.send('Runtime.enable', {}, sessionId);
      await browser.send('Log.enable', {}, sessionId);
      await browser.send('Page.enable', {}, sessionId);
      await sleep(waitMs);
      const r = await browser.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
      const shot = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      return { value: r.result.value, png: Buffer.from(shot.data, 'base64'), sessionId, targetId };
    }

    // 1. options page
    const opt = await openPage(`chrome-extension://${extId}/options.html`, 2500,
      `JSON.stringify({sjr: document.getElementById('sjrEdition').textContent, core: document.getElementById('coreSource').textContent, cache: document.getElementById('cacheEntries').textContent, perm: document.getElementById('permBox').hidden})`);
    console.log('options:', opt.value);
    fs.writeFileSync(`${require('node:os').tmpdir()}/fast-venue-rank-options.png`, opt.png);

    // 2. Scholar search
    const q = process.argv[2] || 'attention is all you need';
    const url = /^https?:/.test(q) ? q : `https://scholar.google.com/scholar?hl=en&q=${encodeURIComponent(q)}`;
    const sch = await openPage(url, 4000,
      `JSON.stringify({title: document.title, results: document.querySelectorAll('#gs_res_ccl_mid .gs_r.gs_or, tr.gsc_a_tr').length, badges: document.querySelectorAll('.jq-badges').length})`);
    console.log('scholar initial:', sch.value);
    // poll until no waiting badges or 45 s
    let final = null;
    for (let i = 0; i < 45; i++) {
      const r = await browser.send('Runtime.evaluate', { returnByValue: true, expression: `JSON.stringify({waiting: document.querySelectorAll('.jq-wait').length, rows: [...document.querySelectorAll('#gs_res_ccl_mid .gs_r.gs_or, tr.gsc_a_tr')].map(r => ({t: (r.querySelector('h3.gs_rt a, h3.gs_rt, a.gsc_a_at')?.textContent||'').slice(0,60), v: ([...r.querySelectorAll('.gs_a, td.gsc_a_t .gs_gray')].pop()?.textContent||'').replace(/\\u00a0/g,' ').split(' - ').slice(1).join(' - ').slice(0,60), b: [...r.querySelectorAll('.jq-badge')].map(b => b.tagName.toLowerCase() + ':' + b.textContent + ' [' + getComputedStyle(b).backgroundColor + ']' + (b.title ? ' {' + b.title.split('\\n')[0] + '}' : ''))}))})` }, sch.sessionId);
      final = JSON.parse(r.result.value);
      if (final.waiting === 0 && i > 2) break;
      await sleep(1000);
    }
    console.log('scholar final: waiting =', final.waiting);
    for (const row of final.rows) console.log(`  ${row.b.join(' ').padEnd(48)} | ${row.t} | ${row.v}`);
    const shot = await browser.send('Page.captureScreenshot', { format: 'png' }, sch.sessionId);
    fs.writeFileSync(`${require('node:os').tmpdir()}/fast-venue-rank-scholar.png`, Buffer.from(shot.data, 'base64'));

    const errs = browser.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
    console.log('console errors:', errs.length);
    for (const e of errs.slice(0, 10)) console.log('  ', JSON.stringify(e.params).slice(0, 300));
  } catch (e) {
    console.error('FAILED:', e.message);
    console.error(stderr.slice(-2000));
  } finally {
    chrome.kill('SIGKILL');
    process.exit(0);
  }
})();

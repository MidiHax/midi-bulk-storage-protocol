// Builds ../MBSP-Specification-v1.0-Draft2.pdf from mbsp-spec.html with headless Chrome.
//
//   node build-pdf.js
//
// Needs Chrome (or set CHROME to its path), Node 22+, and Python 3 with pypdf.
// Two passes: the first print finds the page of every heading (via hidden @@id@@ markers),
// the second fills those page numbers into the table of contents.
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const SRC = path.join(__dirname, 'mbsp-spec.html');
const OUT = path.join(__dirname, '..', 'MBSP-Specification-v1.0-Draft2.pdf');
const PORT = 9411;
const PY = process.env.PYTHON || 'python';
const CHROME = process.env.CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find(p => fs.existsSync(p));

const FOOTER = `<div style="width:100%;font:8px 'Segoe UI',Arial,sans-serif;color:#666;padding:0 0.9in;display:flex;justify-content:space-between">
  <span>MIDI Bulk Storage Protocol (MBSP) &middot; Version 1.0 Draft 2</span>
  <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
const HEADER = `<div style="width:100%;font:8px 'Segoe UI',Arial,sans-serif;color:#8a6a00;padding:0 0.9in;text-align:right;letter-spacing:.08em">
  DRAFT PROPOSAL &middot; NOT AN ADOPTED MMA/AMEI SPECIFICATION</div>`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  if (!CHROME) throw new Error('Chrome not found. Set the CHROME environment variable to its path.');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mbsp-pdf-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  try {
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      try { target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json(); } catch (_) { await sleep(200); }
    }
    if (!target) throw new Error('Could not connect to Chrome');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const pending = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    const send = (method, params = {}) => new Promise((res, rej) => {
      const i = ++id; pending.set(i, m => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;

    await send('Page.enable');
    await send('Page.navigate', { url: pathToFileURL(SRC).href });
    for (let i = 0; i < 100 && !(await evaluate('window.__ready === true && document.readyState === "complete"')); i++) await sleep(100);
    await evaluate('document.fonts.ready.then(() => true)');

    const print = async file => {
      const { data } = await send('Page.printToPDF', {
        preferCSSPageSize: true, printBackground: true, displayHeaderFooter: true,
        headerTemplate: HEADER, footerTemplate: FOOTER,
        generateTaggedPDF: true, generateDocumentOutline: true,
      });
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
    };
    const findPages = file => JSON.parse(execFileSync(PY, [path.join(__dirname, 'find_pages.py'), 'pages', file], { encoding: 'utf8' }));

    // Pass 1 (and repeat until stable): print with markers, read heading pages, fill the TOC.
    const tmp = path.join(profile, 'pass.pdf');
    let previous = '';
    for (let pass = 1; pass <= 4; pass++) {
      await evaluate('document.body.classList.add("markers"), true');
      await print(tmp);
      const { pages, count } = findPages(tmp);
      const ids = await evaluate('[...document.querySelectorAll(".toc .pg")].map(e => e.dataset.for)');
      const missing = ids.filter(i => !pages[i]);
      if (missing.length) throw new Error(`No page found for: ${missing.join(', ')}`);
      const key = JSON.stringify(pages);
      await evaluate(`(() => { const p = ${key}; document.querySelectorAll('.toc .pg').forEach(e => { e.textContent = p[e.dataset.for]; }); return true; })()`);
      console.log(`pass ${pass}: ${count} pages, ${ids.length} headings`);
      if (key === previous) break;
      previous = key;
    }

    // Final print without markers.
    await evaluate('document.body.classList.remove("markers"), true');
    await print(OUT);
    execFileSync(PY, [path.join(__dirname, 'find_pages.py'), 'meta', OUT, JSON.stringify({
      Title: 'MIDI Bulk Storage Protocol (MBSP) Specification, Version 1.0 Draft 2',
      Author: 'Derek Jeter',
      Subject: 'Draft proposal to the MIDI Manufacturers Association: a protocol for MIDI devices to store and recall bulk data on a storage server over System Exclusive',
      Keywords: 'MIDI, MBSP, System Exclusive, bulk dump, librarian, storage, MMA, AMEI',
      Creator: 'mbsp-spec.html via headless Chrome',
    })], { encoding: 'utf8' });
    ws.close();
    console.log(`Wrote ${OUT}`);
  } finally {
    chrome.kill();
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* Chrome may still hold files */ }
  }
}

main().catch(err => { console.error(err.message); process.exitCode = 1; });

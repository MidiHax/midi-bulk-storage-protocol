/* app.js: page wiring for the MBSP sample server (Web MIDI, IndexedDB, GUI). */
(function () {
  'use strict';
  const MBSP = window.MBSP;
  const $ = id => document.getElementById(id);

  // ---------- Preferences (per browser) ----------
  // index.html?instance=B runs a separate server (own database, settings, name and MUID), so several
  // copies of the page in one browser act as different servers instead of sharing one database.
  const INSTANCE = (new URLSearchParams(location.search).get('instance') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16);
  const PREFS_KEY = 'mbsp-sample-server:prefs' + (INSTANCE ? ':' + INSTANCE : '');
  if (INSTANCE) document.title += ` [${INSTANCE}]`;
  const defaultPrefs = {
    online: true, hue: 190, midiAuto: false,
    enabledInputs: null, enabledOutputs: null, // MIDIPort ids; null = not chosen yet
    logDebug: false, logHex: false, server: {},
  };
  let prefs = { ...defaultPrefs };
  let hadStoredPrefs = false;
  try {
    const stored = localStorage.getItem(PREFS_KEY);
    hadStoredPrefs = !!stored;
    prefs = { ...defaultPrefs, ...JSON.parse(stored || '{}') };
  } catch (_) { /* storage blocked */ }
  function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) { /* ignore */ } }

  // ---------- Log ----------
  const LOG_MAX = 1000;
  const logEntries = [];
  const logEl = $('log');
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  function stamp(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; }

  function logLine(entry) {
    if (entry.level === 'debug' && !prefs.logDebug) return null;
    const div = document.createElement('div');
    const t = document.createElement('span'); t.className = 't'; t.textContent = stamp(entry.time) + ' ';
    const m = document.createElement('span'); m.className = entry.level; m.textContent = entry.text;
    div.append(t, m);
    if (prefs.logHex && entry.bytes) {
      const h = document.createElement('span'); h.className = 'hex';
      const b = entry.bytes;
      h.textContent = MBSP.hexBytes(b.length > 96 ? b.subarray(0, 96) : b) + (b.length > 96 ? ` ... (${b.length} bytes)` : '');
      div.append(h);
    }
    return div;
  }
  function log(level, text, bytes) {
    const entry = { level, text, bytes: bytes ? Uint8Array.from(bytes) : null, time: new Date() };
    logEntries.push(entry);
    if (logEntries.length > LOG_MAX) logEntries.shift();
    const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 4;
    const line = logLine(entry);
    if (line) {
      logEl.append(line);
      while (logEl.childElementCount > LOG_MAX) logEl.firstElementChild.remove();
      if (atBottom) logEl.scrollTop = logEl.scrollHeight;
    }
  }
  function rerenderLog() {
    logEl.replaceChildren(...logEntries.map(logLine).filter(Boolean));
    logEl.scrollTop = logEl.scrollHeight;
  }

  function flash(id) {
    const el = $(id);
    el.classList.remove('off');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('off'), 90);
  }

  // ---------- MIDI ----------
  let midi = null;
  // Ports are remembered by MIDIPort.id, not name: two ports can share a name (Windows often
  // lists the same device twice), and enabling both makes every message arrive twice.
  const enabledKey = port => (port.type === 'input' ? 'enabledInputs' : 'enabledOutputs');
  function portEnabled(port) { return (prefs[enabledKey(port)] || []).includes(port.id); }

  /** First run: nothing enabled. Older prefs (disabled port names): keep the same choices,
   *  but enable only the first port of each name. */
  function initPortPrefs() {
    for (const [kind, ports] of [['Inputs', midi.inputs], ['Outputs', midi.outputs]]) {
      const key = 'enabled' + kind, oldKey = 'disabled' + kind;
      if (Array.isArray(prefs[key])) continue;
      const ids = [];
      if (hadStoredPrefs && Array.isArray(prefs[oldKey])) {
        const seen = new Set();
        for (const p of ports.values()) {
          if (!prefs[oldKey].includes(p.name) && !seen.has(p.name)) ids.push(p.id);
          seen.add(p.name);
        }
      }
      prefs[key] = ids;
      delete prefs[oldKey];
    }
    savePrefs();
  }

  function sendMidi(bytes) {
    flash('ledTx');
    if (!midi) return;
    let sent = 0;
    for (const out of midi.outputs.values()) {
      if (out.state !== 'connected' || !portEnabled(out)) continue;
      try { out.send(bytes); sent++; } catch (err) { log('error', `Send to "${out.name}" failed: ${err.message}`); }
    }
    if (!sent) log('debug', 'No MIDI output enabled, reply not sent');
  }

  function onMidiMessage(e) {
    const data = e.data;
    if (!data || data[0] !== 0xF0) return;
    flash('ledRx');
    if (!prefs.online) return;
    server.handleMessage(data).catch(err => log('error', `Handler error: ${err.message}`));
  }

  function bindInputs() {
    if (!midi) return;
    for (const input of midi.inputs.values()) {
      input.onmidimessage = portEnabled(input) ? onMidiMessage : null;
    }
  }

  function renderPortList(el, ports, kind) {
    el.replaceChildren();
    const list = [...ports.values()];
    if (!list.length) {
      const d = document.createElement('div'); d.className = 'empty'; d.textContent = 'No ports found';
      el.append(d); return;
    }
    const nameCount = new Map();
    for (const p of list) nameCount.set(p.name, (nameCount.get(p.name) || 0) + 1);
    const nameSeen = new Map();
    let duplicates = false;
    for (const port of list) {
      const label = document.createElement('label'); label.className = 'crt-switch';
      label.title = `Port ID ${port.id}${port.manufacturer ? ', ' + port.manufacturer : ''}`;
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = portEnabled(port);
      cb.disabled = port.state !== 'connected';
      const track = document.createElement('span'); track.className = 'crt-switch-track';
      let text = port.name;
      if (nameCount.get(port.name) > 1) {
        duplicates = true;
        const n = (nameSeen.get(port.name) || 0) + 1;
        nameSeen.set(port.name, n);
        text += ` [#${n}${port.manufacturer ? ', ' + port.manufacturer : ''}]`;
      }
      if (port.state !== 'connected') text += ' (disconnected)';
      label.append(cb, track, document.createTextNode(' ' + text));
      cb.addEventListener('change', () => {
        const key = enabledKey(port);
        prefs[key] = (prefs[key] || []).filter(id => id !== port.id);
        if (cb.checked) prefs[key].push(port.id);
        savePrefs();
        bindInputs();
        updateIndicators();
      });
      el.append(label);
    }
    if (duplicates) {
      const warn = document.createElement('div'); warn.className = 'hint';
      warn.textContent = `Ports marked [#n] share a name and usually lead to the same device. Enable only one of them, or every message is ${kind === 'input' ? 'handled' : 'sent'} twice.`;
      el.append(warn);
    }
  }

  function renderPorts() {
    renderPortList($('inputs'), midi.inputs, 'input');
    renderPortList($('outputs'), midi.outputs, 'output');
    updateIndicators();
  }

  // Auto-connect on load and the Connect button share one request, so Chrome only ever
  // shows one permission prompt at a time.
  let midiRequest = null;
  function connectMidi() {
    if (midi) return Promise.resolve();
    if (!midiRequest) midiRequest = doConnectMidi().finally(() => { midiRequest = null; });
    return midiRequest;
  }

  async function doConnectMidi() {
    const notice = $('midiNotice');
    const btn = $('btnMidi');
    if (!navigator.requestMIDIAccess) {
      notice.className = 'notice err';
      notice.textContent = 'This browser has no Web MIDI. Use Chrome or Edge (or Firefox with its Web MIDI site permission).';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Waiting for permission...';
    try {
      midi = await navigator.requestMIDIAccess({ sysex: true });
    } catch (err) {
      notice.className = 'notice err';
      notice.textContent = `MIDI access was refused (${err.name || err.message}). SysEx permission is required. ` +
        'Serve the page from localhost or https, then allow MIDI access.';
      log('error', `MIDI access refused: ${err.message || err.name}`);
      return;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Connect MIDI';
    }
    prefs.midiAuto = true; savePrefs();
    notice.hidden = true;
    $('btnMidi').hidden = true;
    initPortPrefs();
    midi.onstatechange = () => { renderPorts(); bindInputs(); };
    renderPorts();
    bindInputs();
    log('info', `MIDI connected: ${midi.inputs.size} input(s), ${midi.outputs.size} output(s)`);
    if (!enabledCount(midi.inputs) || !enabledCount(midi.outputs)) {
      log('warn', 'Choose the MIDI input to listen on and the output to reply on under MIDI Ports. New ports start switched off.');
    }
  }

  function enabledCount(ports) {
    let n = 0;
    for (const p of ports.values()) if (p.state === 'connected' && portEnabled(p)) n++;
    return n;
  }

  function updateIndicators() {
    $('indName').textContent = server ? server.settings.serverName : '-';
    $('indMuid').textContent = server ? MBSP.hexMuid(server.muid) : '-';
    const ins = midi ? enabledCount(midi.inputs) : 0;
    const outs = midi ? enabledCount(midi.outputs) : 0;
    $('indMidi').textContent = midi ? `${ins} in / ${outs} out` : 'off';
    $('ledMidi').className = 'crt-led ' + (!midi ? 'off' : ins && outs ? '' : 'amber');
    $('ledOnline').className = 'crt-led ' + (!prefs.online ? 'off' : midi && ins && outs ? '' : 'amber');
  }

  // ---------- Server settings UI ----------
  const S = {
    name: $('setName'), key: $('setKey'), online: $('setOnline'), readOnly: $('setReadOnly'),
    allowDelete: $('setAllowDelete'), owner: $('setOwner'), firmware: $('setFirmware'), beacon: $('setBeacon'),
    beaconInt: $('setBeaconInt'), timeout: $('setTimeout'), block: $('setBlock'), delay: $('setDelay'), hue: $('setHue'),
  };

  function fillSettings() {
    const s = server.settings;
    S.name.value = s.serverName; S.key.value = s.accessKey;
    S.online.checked = prefs.online; S.readOnly.checked = s.readOnly; S.allowDelete.checked = s.allowDelete;
    S.owner.checked = s.enforceOwnerOnDelete; S.firmware.checked = s.allowFirmware; S.beacon.checked = !!prefs.server.beaconEnabled;
    S.beaconInt.value = s.beaconIntervalMs / 1000; S.timeout.value = s.transactionTimeoutMs / 1000;
    S.block.value = s.blockSize; S.delay.value = s.blockDelayMs; S.hue.value = prefs.hue;
  }

  function readSettings() {
    return {
      serverName: S.name.value, accessKey: S.key.value,
      readOnly: S.readOnly.checked, allowDelete: S.allowDelete.checked, enforceOwnerOnDelete: S.owner.checked, allowFirmware: S.firmware.checked,
      beaconEnabled: S.beacon.checked,
      beaconIntervalMs: Number(S.beaconInt.value) * 1000, transactionTimeoutMs: Number(S.timeout.value) * 1000,
      blockSize: Number(S.block.value), blockDelayMs: Number(S.delay.value),
    };
  }

  function applySettings() {
    const wanted = readSettings();
    const nameOk = MBSP.validateServerName(wanted.serverName);
    const keyOk = wanted.accessKey.length <= 16 && MBSP.isPrintableAscii(wanted.accessKey);
    S.name.classList.toggle('bad', !nameOk);
    S.key.classList.toggle('bad', !keyOk);
    if (!nameOk || !keyOk) return;
    const before = server.settings.serverName;
    prefs.online = S.online.checked;
    prefs.server = wanted;
    // Beacon only runs while the server is online.
    server.applySettings({ ...wanted, beaconEnabled: wanted.beaconEnabled && prefs.online });
    savePrefs();
    fillSettings(); // show clamped values
    if (before !== server.settings.serverName) log('info', `Server name is now "${server.settings.serverName}"`);
    updateIndicators();
  }

  // ---------- Records ----------
  let records = [];
  let selectedId = null;
  let selectedPayload = null;

  const fmtBytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
  const fmtDate = ms => { if (!ms) return '-'; const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const typeName = t => MBSP.payloadTypeName(t);
  const deviceKey = r => `${r.identity.join(',')}|${r.sysexId}`;
  const deviceLabel = r => (r.deviceName || MBSP.formatIdentity(r.identity)) + (r.sysexId !== 0x7F ? ` #${MBSP.hex2(r.sysexId)}` : '');

  function setOptions(sel, options, keep) {
    sel.replaceChildren(...options.map(([value, label]) => { const o = document.createElement('option'); o.value = value; o.textContent = label; return o; }));
    sel.value = options.some(([v]) => v === keep) ? keep : options[0][0];
  }

  function renderFilters() {
    const types = [...new Set(records.map(r => r.type))].sort((a, b) => a - b);
    setOptions($('fType'), [['', 'All types'], ...types.map(t => [String(t), typeName(t)])], $('fType').value);
    const devices = new Map();
    for (const r of records) if (!devices.has(deviceKey(r))) devices.set(deviceKey(r), deviceLabel(r));
    setOptions($('fDevice'), [['', 'All devices'], ...[...devices].sort((a, b) => a[1].localeCompare(b[1]))], $('fDevice').value);
    const tags = new Map();
    for (const r of records) for (const t of r.tags) if (!tags.has(t.toLowerCase())) tags.set(t.toLowerCase(), t);
    setOptions($('fTag'), [['', 'All tags'], ...[...tags].sort((a, b) => a[1].localeCompare(b[1]))], $('fTag').value);
  }

  function filtered() {
    const text = $('fText').value.trim().toLowerCase();
    const type = $('fType').value;
    const dev = $('fDevice').value;
    const tag = $('fTag').value;
    return records.filter(r => {
      if (type !== '' && String(r.type) !== type) return false;
      if (dev && deviceKey(r) !== dev) return false;
      if (tag && !r.tags.some(t => t.toLowerCase() === tag)) return false;
      if (text) {
        const hay = [r.name, r.number, r.deviceName, MBSP.formatIdentity(r.identity), String(r.id), ...r.tags].join('\n').toLowerCase();
        if (!hay.includes(text)) return false;
      }
      return true;
    });
  }

  function td(text, cls) { const c = document.createElement('td'); c.textContent = text; if (cls) c.className = cls; return c; }

  function renderTable() {
    const rows = filtered();
    const body = $('recordRows');
    body.replaceChildren();
    const MAX_ROWS = 2000;
    for (const r of rows.slice(0, MAX_ROWS)) {
      const tr = document.createElement('tr');
      tr.dataset.id = r.id;
      if (r.id === selectedId) tr.setAttribute('aria-selected', 'true');
      const tagCell = document.createElement('td');
      for (const t of r.tags) { const s = document.createElement('span'); s.className = 'tag'; s.textContent = t; tagCell.append(s); }
      const dev = td(r.deviceName || MBSP.formatIdentity(r.identity), 'clip');
      dev.title = `Identity ${MBSP.formatIdentity(r.identity)}`;
      tr.append(td(r.id, 'num'), td(r.number), td(r.name || '(no name)', r.name ? 'clip' : 'clip dim'), td(typeName(r.type)), dev,
        td(r.sysexId === 0x7F ? '-' : MBSP.hex2(r.sysexId)), tagCell, td(fmtBytes(r.size), 'num'), td(fmtDate(r.storedAt)));
      body.append(tr);
    }
    $('recordsEmpty').hidden = records.length > 0;
    $('recordCount').textContent = records.length
      ? `Showing ${Math.min(rows.length, MAX_ROWS)} of ${records.length} record(s)${rows.length > MAX_ROWS ? ' (narrow the search to see more)' : ''}`
      : '';
  }

  let refreshQueued = false;
  async function refreshRecords() {
    if (refreshQueued) return;
    refreshQueued = true;
    await Promise.resolve();
    refreshQueued = false;
    records = await store.list();
    const bytes = records.reduce((n, r) => n + r.size, 0);
    $('statRecords').textContent = records.length;
    $('statBytes').textContent = fmtBytes(bytes);
    $('statNext').textContent = await store.getNextId();
    $('indRecords').textContent = records.length;
    renderFilters();
    renderTable();
    if (selectedId !== null && !records.some(r => r.id === selectedId)) closeDetail();
  }

  // ---------- Record detail ----------
  function hexdump(bytes, limit) {
    const n = Math.min(bytes.length, limit);
    const pre = $('hexdump');
    pre.replaceChildren();
    if (!bytes.length) { pre.textContent = '(empty payload)'; return; }
    const frag = document.createDocumentFragment();
    for (let off = 0; off < n; off += 16) {
      const chunk = bytes.subarray(off, Math.min(off + 16, n));
      const o = document.createElement('span'); o.className = 'off'; o.textContent = off.toString(16).toUpperCase().padStart(6, '0') + '  ';
      const h = document.createTextNode(MBSP.hexBytes(chunk).padEnd(48, ' ') + ' ');
      const a = document.createElement('span'); a.className = 'asc';
      a.textContent = Array.from(chunk, c => (c >= 0x20 && c < 0x7F ? String.fromCharCode(c) : '.')).join('');
      frag.append(o, h, a, document.createTextNode('\n'));
    }
    if (n < bytes.length) frag.append(document.createTextNode(`... ${bytes.length - n} more byte(s)`));
    pre.append(frag);
    $('btnHexAll').hidden = n >= bytes.length;
  }

  async function openDetail(id) {
    const meta = await store.get(id);
    if (!meta) return;
    selectedId = id;
    selectedPayload = (await store.getPayload(id)) || new Uint8Array(0);
    $('detailTitle').textContent = `Record ${id}`;
    const dl = $('detailMeta');
    dl.replaceChildren();
    const add = (k, v) => { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); };
    add('Number', meta.number);
    add('Name', meta.name || '(not provided)');
    add('Type', `${typeName(meta.type)} (${MBSP.hex2(meta.type)})`);
    add('Device name', meta.deviceName || '(not provided)');
    add('Device identity', `${MBSP.formatIdentity(meta.identity)}   [${MBSP.hexBytes(meta.identity)}]`);
    add('SysEx ID', meta.sysexId === 0x7F ? '(not provided)' : MBSP.hex2(meta.sysexId));
    add('Tags', meta.tags.length ? meta.tags.join(', ') : '(none)');
    add('Size', `${meta.size} byte(s)`);
    add('CRC-32', meta.crc32 !== undefined ? MBSP.hex8(meta.crc32) : '(not stored, older record)');
    add('Stored', meta.storedAt ? new Date(meta.storedAt).toLocaleString() : '-');
    hexdump(selectedPayload, 4096);
    $('detailPanel').hidden = false;
    renderTable();
  }

  function closeDetail() {
    selectedId = null; selectedPayload = null;
    $('detailPanel').hidden = true;
    renderTable();
  }

  function download(bytes, filename) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const safeName = s => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'record';

  // ---------- Transfers ----------
  function renderTransfers(list) {
    const el = $('transfers');
    el.replaceChildren();
    if (!list.length) { const s = document.createElement('span'); s.className = 'hint'; s.textContent = 'Idle'; el.append(s); return; }
    for (const t of list) {
      const box = document.createElement('div'); box.className = 'transfer';
      const label = document.createElement('div');
      label.textContent = `${t.kind === 'store' ? 'Receiving' : 'Sending'} ${t.number}${t.name ? ' "' + t.name + '"' : ''}  ${t.done}/${t.total} blocks  (MUID ${MBSP.hexMuid(t.muid)})`;
      const meter = document.createElement('div'); meter.className = 'crt-meter';
      const segs = 24, on = t.total ? Math.round((t.done / t.total) * segs) : 0;
      for (let i = 0; i < segs; i++) { const s = document.createElement('i'); if (i < on) s.className = 'on'; meter.append(s); }
      box.append(label, meter);
      el.append(box);
    }
  }

  // ---------- Startup ----------
  let store;
  let server;

  async function init() {
    document.documentElement.style.setProperty('--crt-h', prefs.hue);
    try {
      store = await new MBSP.IndexedDbStore('mbsp-sample-server' + (INSTANCE ? '-' + INSTANCE : '')).open();
    } catch (err) {
      store = new MBSP.MemoryStore();
      log('error', `IndexedDB is unavailable (${err && err.message}). Using a temporary in-memory database: records will be lost when the page closes.`);
    }

    // A unique default name, so two copies of this page on one network don't clash.
    if (!prefs.server.serverName) { prefs.server.serverName = MBSP.uniqueServerName(); savePrefs(); }
    try {
      server = new MBSP.MbspServer({ store, send: sendMidi, settings: { ...prefs.server, beaconEnabled: !!prefs.server.beaconEnabled && prefs.online } });
    } catch (err) {
      log('warn', `Saved settings were invalid (${err.message}), using defaults`);
      prefs.server = { serverName: MBSP.uniqueServerName() };
      savePrefs();
      server = new MBSP.MbspServer({ store, send: sendMidi, settings: prefs.server });
    }
    server.onLog = e => log(e.level, e.text, e.bytes);
    server.onRecordsChanged = () => refreshRecords();
    server.onMuidChanged = () => updateIndicators();
    server.onTransfersChanged = renderTransfers;

    fillSettings();
    for (const el of [S.online, S.readOnly, S.allowDelete, S.owner, S.firmware, S.beacon, S.beaconInt, S.timeout, S.block, S.delay]) {
      el.addEventListener('change', applySettings);
    }
    S.name.addEventListener('input', () => S.name.classList.toggle('bad', !MBSP.validateServerName(S.name.value)));
    S.name.addEventListener('change', applySettings);
    S.key.addEventListener('change', applySettings);
    S.hue.addEventListener('input', () => {
      prefs.hue = Number(S.hue.value);
      document.documentElement.style.setProperty('--crt-h', prefs.hue);
      savePrefs();
    });
    $('btnAnnounce').addEventListener('click', () => server.announce());

    $('logDebug').checked = prefs.logDebug;
    $('logHex').checked = prefs.logHex;
    $('logDebug').addEventListener('change', e => { prefs.logDebug = e.target.checked; savePrefs(); rerenderLog(); });
    $('logHex').addEventListener('change', e => { prefs.logHex = e.target.checked; savePrefs(); rerenderLog(); });
    $('btnClearLog').addEventListener('click', () => { logEntries.length = 0; logEl.replaceChildren(); });

    $('btnMidi').addEventListener('click', connectMidi);

    for (const id of ['fType', 'fDevice', 'fTag']) $(id).addEventListener('change', renderTable);
    $('fText').addEventListener('input', renderTable);
    $('btnRefresh').addEventListener('click', refreshRecords);
    $('recordRows').addEventListener('click', e => {
      const tr = e.target.closest('tr');
      if (tr) openDetail(Number(tr.dataset.id));
    });
    $('btnCloseDetail').addEventListener('click', closeDetail);
    $('btnHexAll').addEventListener('click', () => selectedPayload && hexdump(selectedPayload, Infinity));
    $('btnDownload').addEventListener('click', async () => {
      const meta = records.find(r => r.id === selectedId);
      if (meta && selectedPayload) download(selectedPayload, `${meta.id}-${safeName(meta.number)}-${safeName(meta.name)}.bin`);
    });
    $('btnDelete').addEventListener('click', async () => {
      const meta = records.find(r => r.id === selectedId);
      if (!meta || !confirm(`Delete record ${meta.id} (${meta.number}${meta.name ? ' "' + meta.name + '"' : ''})? This can't be undone.`)) return;
      await store.remove(meta.id);
      log('info', `Deleted record ${meta.id} from the GUI`);
      closeDetail();
      refreshRecords();
    });

    // Export / import / clear
    $('btnExport').addEventListener('click', async () => {
      const entries = await MBSP.readAll(store);
      const file = MBSP.encodeDatabaseFile({ serverName: server.settings.serverName, nextRecordId: await store.getNextId(), entries });
      const d = new Date();
      download(file, `${safeName(server.settings.serverName)}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.mbsp`);
      log('info', `Exported ${entries.length} record(s), ${fmtBytes(file.length)}`);
    });
    let importMode = 'merge';
    $('btnImportMerge').addEventListener('click', () => { importMode = 'merge'; $('fileImport').click(); });
    $('btnImportReplace').addEventListener('click', () => { importMode = 'replace'; $('fileImport').click(); });
    $('fileImport').addEventListener('change', async e => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const db = MBSP.decodeDatabaseFile(new Uint8Array(await file.arrayBuffer()));
        if (importMode === 'replace' && records.length &&
            !confirm(`Replace all ${records.length} record(s) with the ${db.entries.length} record(s) in "${file.name}"?`)) return;
        const n = await MBSP.importEntries(store, db.entries, db.nextRecordId, importMode);
        log('info', `Imported ${n} record(s) from "${file.name}" (${importMode}${db.serverName ? ', exported by ' + db.serverName : ''})`);
        await refreshRecords();
      } catch (err) {
        log('error', `Import failed: ${err.message}`);
        alert(`Import failed: ${err.message}`);
      }
    });
    $('btnClear').addEventListener('click', async () => {
      if (!confirm(`Delete all ${records.length} record(s)? New Records keep counting up from the current Record ID, so Clients holding old IDs get Not Found. Export first if you want a backup.`)) return;
      await store.clear();
      log('info', 'Database cleared');
      refreshRecords();
    });

    $('btnSelfTest').addEventListener('click', async () => {
      const btn = $('btnSelfTest');
      btn.disabled = true;
      log('info', 'Self-test started (in-memory server, your database is not touched)');
      try { await MBSP.runSelfTest({ log: e => log(e.level, '[self-test] ' + e.text) }); } finally { btn.disabled = false; }
    });

    await refreshRecords();
    updateIndicators();
    log('info', `Server "${server.settings.serverName}" (MUID ${MBSP.hexMuid(server.muid)}) ready. ${records.length} record(s) in the database.`);
    if (prefs.midiAuto) connectMidi();
  }

  init().catch(err => log('error', `Startup failed: ${err.message}`));
})();

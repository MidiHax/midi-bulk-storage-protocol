// Runs the panel's Lua script (mbsp-panel.lua) under fengari, a Lua VM for JavaScript, with a
// mock of the TouchOSC scripting API, against two in-process MBSP servers on one simulated
// MIDI bus. Checks discovery, Save, Load, paging, restore, a lost ack, and that every control
// the script uses exists in the generated layout.
//
//   npm install && npm test        (from touchosc-panel/)
'use strict';
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring } = require('fengari');

const ROOT = path.join(__dirname, '..', '..');
for (const f of ['mbsp-protocol.js', 'mbsp-store.js', 'mbsp-file.js', 'mbsp-server.js']) require(path.join(ROOT, 'sample-server', 'js', f));
const MBSP = globalThis.MBSP;
const { layout } = require(path.join(__dirname, '..', 'build-panel.js'));

// ---------- Lua VM with a mock TouchOSC API ----------
const L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);
function run(code, name = 'chunk') {
  if (lauxlib.luaL_loadbuffer(L, to_luastring(code), null, to_luastring(name)) !== lua.LUA_OK ||
      lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) {
    const msg = lua.lua_tojsstring(L, -1); lua.lua_pop(L, 1);
    throw new Error(`Lua error: ${msg}`);
  }
  const v = lua.lua_isnil(L, -1) ? null : lua.lua_tojsstring(L, -1);
  lua.lua_pop(L, 1);
  return v;
}

const names = layout().map(n => n.name);
run(`
  __now = 1000
  function getMillis() return __now end
  os = nil -- TouchOSC's sandbox has no os library
  setmetatable, getmetatable = nil, nil -- nor these
  __log = {}
  function print(...) local t = {} for i = 1, select("#", ...) do t[i] = tostring(select(i, ...)) end __log[#__log + 1] = table.concat(t, " ") end
  function __takeLog() local s = table.concat(__log, string.char(10)); __log = {}; return s end
  __out, __missing = {}, {}
  function sendMIDI(m)
    local t = {}
    for i = 1, #m do t[i] = string.format("%d", m[i]) end -- errors on a non-integer byte
    __out[#__out + 1] = table.concat(t, ",")
  end
  function Color(r, g, b, a) return { r = r, g = g, b = b, a = a } end
  local controls = {}
  root = { name = "root", values = {}, properties = {} }
  function root:notify(key, value) onReceiveNotify(key, value) end
  function root:findByName(name, recursive)
    local c = controls[name]
    if not c then __missing[name] = true end
    return c
  end
  function __add(name) controls[name] = { name = name, values = { x = 0, y = 0, text = "" }, properties = {} } end
  function __set(name, key, v) controls[name].values[key] = v end
  function __get(name, key) return tostring(controls[name].values[key]) end
  function __takeOut() local s = table.concat(__out, ";"); __out = {}; return s end
  function __deliver(s, unframed)
    local t = {}
    for v in string.gmatch(s, "%d+") do t[#t + 1] = tonumber(v) end
    if unframed then table.remove(t, 1); table.remove(t) end -- a host that strips F0 / F7
    onReceiveMIDI(t, { true })
  end
  function __missingNames() local t = {} for k in pairs(__missing) do t[#t + 1] = k end return table.concat(t, ",") end
`, 'mock');
for (const n of names) run(`__add(${JSON.stringify(n)})`);
run(fs.readFileSync(path.join(__dirname, '..', 'mbsp-panel.lua'), 'utf8'), 'mbsp-panel.lua');

const text = name => run(`return __get(${JSON.stringify(name)}, "text")`);
const get = (name, key = 'x') => Number(run(`return __get(${JSON.stringify(name)}, ${JSON.stringify(key)})`));
const set = (name, key, v) => run(`__set(${JSON.stringify(name)}, ${JSON.stringify(key)}, ${v})`);
const tap = (action, index) => run(`root:notify(${JSON.stringify(action)}${index ? ', ' + index : ''})`);

// ---------- two servers on one bus ----------
const inbox = [];
const servers = ['Vault-A', 'Vault-B'].map(serverName => new MBSP.MbspServer({
  store: new MBSP.MemoryStore(), send: b => inbox.push(b), settings: { serverName, blockDelayMs: 0 },
}));
let now = 1000;
let drop = null; // (decoded message) => true to lose it on the way to the panel
let echo = true;  // a MIDI loop sends every message the panel sends straight back to it (as on a second connection)
let unframed = false;

async function pump() {
  for (let guard = 0; guard < 10000; guard++) {
    const out = run('return __takeOut()');
    const msgs = out ? out.split(';') : [];
    for (const m of msgs) {
      if (echo) run(`__deliver("${m}")`);
      const bytes = Uint8Array.from(m.split(',').map(Number));
      for (const s of servers) await s.handleMessage(bytes);
    }
    const replies = inbox.splice(0);
    for (const b of replies) {
      if (drop && drop(MBSP.decodeMessage(b))) { drop = null; continue; }
      run(`__deliver("${Array.from(b).join(',')}", ${unframed})`);
    }
    if (!msgs.length && !replies.length) return;
  }
  throw new Error('pump did not settle');
}
async function advance(ms) { now += ms; run(`__now = ${now}; update()`); await pump(); }

// ---------- checks ----------
let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}: ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const near = (a, b) => Math.abs(a - b) < 1 / 16000;
const SNAP1 = { fader1: 0.25, fader2: 0.5, fader3: 0.75, fader4: 1, knob1: 0.1, knob2: 0.2, knob3: 0.3, knob4: 0.4, toggle1: 1, toggle3: 1 };

(async () => {
  await check('init draws a MUID and discovers both servers, ignoring its own echoed messages', async () => {
    run('init()');
    const muid = text('muidLabel');
    await pump();
    assert(text('server1Label').startsWith('Vault-A') && text('server2Label').startsWith('Vault-B'), 'servers not shown as they answered');
    assert(text('muidLabel') === muid, `the echo was taken for a MUID collision (${muid} -> ${text('muidLabel')})`);
    await advance(1100);
    assert(/^MUID [0-9A-F]{7}$/.test(text('muidLabel')), `muid label "${text('muidLabel')}"`);
    assert(text('server1Label').startsWith('Vault-A') && text('server2Label').startsWith('Vault-B'), `servers: "${text('server1Label')}", "${text('server2Label')}"`);
    assert(/2 server\(s\) found\. Tap one/.test(text('status')), `status "${text('status')}"`);
  });

  await check('Save to server B stores a snapshot there and nowhere else', async () => {
    tap('server', 2);
    for (const [k, v] of Object.entries(SNAP1)) set(k, 'x', v);
    set('xy', 'x', 0.6); set('xy', 'y', 0.9); set('mode', 'x', 2);
    tap('save');
    await pump();
    assert(/Snapshot 1 saved as #1 on Vault-B/.test(text('status')), `status "${text('status')}"`);
    assert((await servers[1].store.list()).length === 1 && (await servers[0].store.list()).length === 0, 'stored on the wrong server');
    const rec = (await servers[1].store.list())[0];
    assert(rec.number === '001' && rec.name === 'Snapshot 1' && rec.deviceName === 'TouchOSC Panel' && rec.identity[0] === 0x7D, 'metadata differs');
  });

  await check('A second Save is numbered 2; a lost Store ack is recovered by resending', async () => {
    set('fader1', 'x', 0.9);
    drop = d => d && d.type === MBSP.MSG.STORE_BLOCK_ACK; // lose the server's "send block 0"
    tap('save');
    await pump();
    assert(!/saved/.test(text('status')), 'saved without the ack');
    await advance(1100); // the panel resends the header, the server repeats its ack
    assert(/Snapshot 2 saved as #2 on Vault-B/.test(text('status')), `status "${text('status')}"`);
  });

  await check('Load lists the snapshots and restores the chosen one', async () => {
    for (const k of [...Object.keys(SNAP1), 'xy', 'mode']) set(k, 'x', 0);
    tap('load');
    await pump();
    assert(/2 snapshot\(s\) on Vault-B/.test(text('status')), `status "${text('status')}"`);
    assert(text('row1Label').startsWith('#1  Snapshot 1') && text('row2Label').startsWith('#2  Snapshot 2') && text('row3Label') === '', `rows "${text('row1Label')}", "${text('row2Label')}"`);
    tap('row', 1);
    await pump();
    assert(/Loaded Snapshot 1 \(#1\)/.test(text('status')), `status "${text('status')}"`);
    for (const [k, v] of Object.entries(SNAP1)) assert(near(get(k), v), `${k} = ${get(k)}, expected ${v}`);
    assert(near(get('xy', 'x'), 0.6) && near(get('xy', 'y'), 0.9) && get('mode') === 2, 'xy / mode not restored');
  });

  await check('Server A is separate: empty, then paging through 8 snapshots', async () => {
    tap('server', 1);
    tap('load');
    await pump();
    assert(/No snapshots on Vault-A/.test(text('status')), `status "${text('status')}"`);
    for (let i = 0; i < 8; i++) { set('fader2', 'x', i / 10); tap('save'); await pump(); }
    assert(/Snapshot 8 saved as #8 on Vault-A/.test(text('status')), `status "${text('status')}"`);
    tap('load'); await pump();
    assert(text('pageLabel') === '1-6 of 8' && text('row6Label').startsWith('#6'), `page "${text('pageLabel')}"`);
    tap('next'); await pump();
    assert(text('pageLabel') === '7-8 of 8' && text('row1Label').startsWith('#7') && text('row3Label') === '', `page "${text('pageLabel')}" row1 "${text('row1Label')}"`);
    tap('row', 2); await pump();
    assert(/Loaded Snapshot 8/.test(text('status')) && near(get('fader2'), 0.7), `status "${text('status')}", fader2 ${get('fader2')}`);
  });

  await check('SysEx delivered without F0 / F7 framing is still understood', async () => {
    unframed = true;
    try { tap('discover'); await pump(); await advance(1100); } finally { unframed = false; }
    assert(text('server1Label').startsWith('Vault-A') && text('server2Label').startsWith('Vault-B'), `servers: "${text('server1Label')}"`);
    tap('server', 2);
  });

  await check('Every control the script uses exists in the layout', async () => {
    const missing = run('return __missingNames()');
    assert(!missing, `missing: ${missing}`);
  });

  await check('The generated .tosc is well-formed zlib + XML with the script embedded', async () => {
    const zlib = require('zlib');
    const file = path.join(__dirname, '..', 'MBSP-Snapshot-Panel.tosc');
    const xml = zlib.inflateSync(fs.readFileSync(file)).toString('utf8');
    assert(xml.startsWith("<?xml") && xml.includes("<lexml version='3'>") && xml.includes('function onReceiveMIDI'), 'unexpected content');
    const opens = (xml.match(/<node /g) || []).length, closes = (xml.match(/<\/node>/g) || []).length;
    assert(opens === closes && opens === layout().length + 1, `${opens} <node> vs ${closes} </node>`);
  });

  for (const s of servers) s.shutdown();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

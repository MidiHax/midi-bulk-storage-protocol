#!/usr/bin/env node
/* mbsp-studio.js: emulates a studio of 10 MIDI devices that act as MBSP Clients.
 *
 * Each device has its own MUID, Device Identity, optional Device Name and SysEx ID, and
 * randomly stores, queries, retrieves and deletes patches on an MBSP server. Every reply is
 * checked against the protocol, and a pass/fail summary is printed at the end.
 *
 *   node mbsp-studio.js --help
 *
 * Reuses the protocol codec from ../sample-server/js/mbsp-protocol.js.
 */
'use strict';
const path = require('path');
require(path.join(__dirname, '..', 'sample-server', 'js', 'mbsp-protocol.js'));
const MBSP = globalThis.MBSP;
const { MSG, STATUS, STATUS_NAME, build, parse, Reader } = MBSP;

let midi;
try { midi = require('@julusian/midi'); } catch (_) {
  console.error('Missing dependency. Run "npm install" in the sample-client folder first.');
  process.exit(1);
}

// ---------- Options ----------
const HELP = `
MBSP studio client: 10 emulated devices exercising an MBSP server.

Usage: node mbsp-studio.js [options]

  --out <port>         MIDI output to send on          (default "Loopback (A)")
  --in <port>          MIDI input to listen on         (default "Loopback (A)")
  --server <name>      Target server name, looked up with DiscoverServers to find its MUID
                       (default: the first server that answers; a name two servers share is refused)
  --ops <n>            Number of operations to run     (default 100, 0 = until Ctrl+C)
  --concurrency <n>    Devices acting at the same time (default 3)
  --rate <ms>          Pause between a device's operations (default 250)
  --block-delay <ms>   Extra pause before each Store message, on top of flow control (default 0)
  --access-key <key>   Access Key to put in every request (default none)
  --seed <n>           Random seed, to repeat a run exactly
  --cleanup            Delete every record this run stored before exiting
  --verbose            Log every reply, not just one line per operation
  --list               List MIDI ports and exit

Port names match exactly first, then by case-insensitive substring.

With the Windows MIDI Services loopback pair, whatever is sent on "Loopback (A)" arrives on
"Loopback (B)" and the reverse. So: this client sends and listens on A, and the server page
should listen on input "Loopback (B)" and reply on output "Loopback (B)".
`;

function parseArgs(argv) {
  const o = { out: 'Loopback (A)', in: 'Loopback (A)', server: '', ops: 100, concurrency: 3, rate: 250, blockDelay: 0,
    accessKey: '', seed: Date.now() % 1e9, cleanup: false, verbose: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    switch (a) {
      case '--out': o.out = next(); break;
      case '--in': o.in = next(); break;
      case '--server': o.server = next(); break;
      case '--ops': o.ops = Number(next()); break;
      case '--concurrency': o.concurrency = Math.max(1, Number(next())); break;
      case '--rate': o.rate = Number(next()); break;
      case '--block-delay': o.blockDelay = Number(next()); break;
      case '--access-key': o.accessKey = next(); break;
      case '--seed': o.seed = Number(next()); break;
      case '--cleanup': o.cleanup = true; break;
      case '--verbose': o.verbose = true; break;
      case '--list': o.list = true; break;
      case '-h': case '--help': console.log(HELP); process.exit(0); break;
      default: throw new Error(`Unknown option ${a} (see --help)`);
    }
  }
  return o;
}

let opts;
try { opts = parseArgs(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exit(2); }

// ---------- Random ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(opts.seed);
const randInt = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = arr => arr[Math.floor(rnd() * arr.length)];
function weighted(items) {
  const total = items.reduce((n, it) => n + it.weight, 0);
  let r = rnd() * total;
  for (const it of items) { r -= it.weight; if (r < 0) return it; }
  return items[items.length - 1];
}
function randomBytes(n) { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = Math.floor(rnd() * 128); return b; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- The studio ----------
// Manufacturer IDs are the real MMA/AMEI assignments. Family and model codes are
// illustrative only, not the values these instruments actually report.
const ADJ = ['Warm', 'Glass', 'Dark', 'Bright', 'Hollow', 'Analog', 'Dusty', 'Wide', 'Soft', 'Acid', 'Vintage', 'Deep', 'Icy', 'Fat', 'Lush', 'Gritty'];
const NOUN = ['Pad', 'Brass', 'Lead', 'Bass', 'Strings', 'Keys', 'Pluck', 'Choir', 'Bell', 'Sweep', 'Drone', 'Arp', 'Organ', 'Stab', 'Kit', 'Groove'];
const TAGS = ['Pad', 'Bass', 'Lead', 'Keys', 'Brass', 'Strings', 'FX', 'Drums', 'Seq', 'Arp', 'Live Set 1', 'Live Set 2', 'Ambient', 'Techno', 'Favorite', 'WIP'];
const letterNum = (letters, max) => () => `${pick(letters)}${String(randInt(1, max)).padStart(2, '0')}`;
const num3 = () => String(randInt(0, 127)).padStart(3, '0');

// Payload Types: Category + Collection bit (see the spec's Client Payload Types).
const C = MBSP.CATEGORY;
const BANK = MBSP.COLLECTION_BIT;
const VENDOR_OPERATOR = 0x30; // a manufacturer-defined Category, used by the DX7 for operator presets

/** Number generator: prefix + random number in lo..hi, zero-padded to width digits. */
const pnum = (prefix, lo, hi, width = 0) => () => prefix + String(randInt(lo, hi)).padStart(width, '0');
const fixed = s => () => s;

const STUDIO = [
  { deviceName: 'Prophet A', identity: [0x01, 0, 0, 0x32, 0x00, 0x01, 0x00], sysexId: 0x00,
    payloads: [{ type: C.PATCH, weight: 6, size: [1024, 1200], number: letterNum('ABCD', 99) },
      { type: C.TUNING, weight: 1, size: [400, 400], number: pnum('TUN', 1, 16) },
      { type: C.CALIBRATION, weight: 1, size: [4000, 6000], number: fixed('CAL') }] },
  { deviceName: 'Prophet B', identity: [0x01, 0, 0, 0x32, 0x00, 0x01, 0x00], sysexId: 0x01,
    payloads: [{ type: C.PATCH, weight: 6, size: [1024, 1200], number: letterNum('ABCD', 99) },
      { type: C.PATCH | BANK, weight: 1, size: [10000, 20000], number: pnum('U', 1, 4) }] },
  { deviceName: 'Juno-X', identity: [0x41, 0, 0, 0x06, 0x01, 0x00, 0x00], sysexId: 0x10,
    payloads: [{ type: C.PATCH, weight: 4, size: [300, 600], number: num3 },
      { type: C.PERFORMANCE, weight: 2, size: [800, 1500], number: pnum('P', 1, 64, 2) },
      { type: C.PERFORMANCE | BANK, weight: 1, size: [6000, 12000], number: fixed('PERF') },
      { type: C.GLOBAL, weight: 1, size: [128, 256], number: fixed('SYS') }] },
  { deviceName: '', label: 'Korg (no name)', identity: [0x42, 0, 0, 0x2C, 0x01, 0x00, 0x00], sysexId: 0x7F, // name and ID not provided
    payloads: [{ type: C.PATCH, weight: 3, size: [448, 448], number: num3 },
      { type: C.PERFORMANCE, weight: 1, size: [1200, 1600], number: pnum('C', 0, 127, 3) }] },
  { deviceName: 'DX7 II', identity: [0x43, 0, 0, 0x00, 0x00, 0x07, 0x00], sysexId: 0x00,
    payloads: [{ type: C.PATCH, weight: 4, size: [155, 163], number: pnum('I-', 1, 32, 2) },
      { type: C.PATCH | BANK, weight: 2, size: [4096, 4104], number: () => pick(['INT', 'CRT1', 'CRT2']) },
      { type: C.PERFORMANCE, weight: 1, size: [64, 96], number: pnum('PF', 1, 32, 2) },
      { type: C.TUNING, weight: 1, size: [266, 274], number: pnum('MCT', 1, 2) },
      { type: VENDOR_OPERATOR, weight: 1, size: [21, 21], number: pnum('OP', 1, 6) }] },
  { deviceName: 'Digitakt', identity: [0x00, 0x20, 0x3C, 0x0C, 0x00, 0x01, 0x00], sysexId: 0x7F,
    payloads: [{ type: C.DRUM_KIT, weight: 3, size: [2000, 3500], number: pnum('KIT', 1, 128, 3) },
      { type: C.PATTERN, weight: 3, size: [1500, 4000], number: letterNum('ABCDEFGH', 16) },
      { type: C.SAMPLE, weight: 1, size: [10000, 30000], number: pnum('S', 1, 127, 3) },
      { type: C.GLOBAL, weight: 1, size: [1500, 2500], number: fixed('GLOBAL') },
      { type: C.FILE, weight: 1, size: [8000, 30000], number: pnum('PRJ', 1, 64, 2) }] },
  { deviceName: 'Peak', identity: [0x00, 0x20, 0x29, 0x01, 0x01, 0x00, 0x00], sysexId: 0x00,
    payloads: [{ type: C.PATCH, weight: 4, size: [527, 527], number: letterNum('ABC', 99) },
      { type: C.TUNING, weight: 1, size: [400, 420], number: pnum('TBL', 1, 16) }] },
  { deviceName: 'Sub 37', identity: [0x04, 0, 0, 0x05, 0x00, 0x02, 0x00], sysexId: 0x7F,
    payloads: [{ type: C.PATCH, weight: 5, size: [800, 1000], number: () => `${randInt(1, 16)}-${randInt(1, 16)}` },
      { type: C.CALIBRATION, weight: 1, size: [2000, 3000], number: fixed('CAL') }] },
  { deviceName: 'Blofeld', identity: [0x3E, 0, 0, 0x13, 0x00, 0x00, 0x00], sysexId: 0x00,
    payloads: [{ type: C.PATCH, weight: 4, size: [392, 392], number: letterNum('ABCDEFGH', 99) },
      { type: C.PERFORMANCE, weight: 2, size: [400, 450], number: pnum('M', 1, 128) },
      { type: C.PERFORMANCE | BANK, weight: 1, size: [3000, 6000], number: fixed('MULTI') },
      { type: C.SAMPLE, weight: 1, size: [5000, 9000], number: pnum('WT', 80, 118) }] },
  { deviceName: 'KeyStep Pro', identity: [0x00, 0x20, 0x6B, 0x02, 0x00, 0x05, 0x00], sysexId: 0x7F,
    payloads: [{ type: C.PATTERN, weight: 3, size: [1000, 6000], number: pnum('SEQ', 1, 16) },
      { type: C.SONG, weight: 1, size: [500, 2000], number: pnum('CHAIN', 1, 16) },
      { type: C.CONTROLLER_TEMPLATE, weight: 1, size: [300, 800], number: pnum('TPL', 1, 8) },
      { type: C.SET_LIST, weight: 1, size: [100, 400], number: pnum('SET', 1, 8) },
      { type: C.GLOBAL, weight: 1, size: [200, 260], number: fixed('CONFIG') }] },
];
const STUDIO_TYPES = [...new Set(STUDIO.flatMap(d => d.payloads.map(p => p.type)))];

function randomName() {
  if (rnd() < 0.15) return ''; // Payload Name is optional; Payload Number is not
  const n = `${pick(ADJ)} ${pick(NOUN)}${rnd() < 0.3 ? ' ' + randInt(2, 9) : ''}`;
  return n.slice(0, 32);
}
function randomTags() {
  const n = randInt(0, 3), out = new Set();
  while (out.size < n) out.add(pick(TAGS));
  return [...out];
}

// ---------- MIDI link ----------
function findPort(port, wanted) {
  const names = [];
  for (let i = 0; i < port.getPortCount(); i++) names.push(port.getPortName(i));
  let idx = names.indexOf(wanted);
  if (idx < 0) idx = names.findIndex(n => n.toLowerCase().includes(wanted.toLowerCase()));
  return { idx, names };
}

const CLIENT_TO_SERVER = new Set([MSG.DISCOVER_SERVERS, MSG.STORE_HEADER, MSG.STORE_DATA_BLOCK, MSG.RETRIEVE_REQUEST, MSG.RETRIEVE_BLOCK_ACK, MSG.QUERY_REQUEST, MSG.DELETE_REQUEST]);

// Flow control (Store): wait this long for a Store_Block_Ack before resending, and resend at most this often.
const ACK_TIMEOUT_MS = 1000;
const MAX_RETRIES = 3;

class Link {
  constructor(inName, outName) {
    this.input = new midi.Input();
    this.output = new midi.Output();
    this.input.ignoreTypes(false, true, true); // receive SysEx; ignore clock and active sensing
    const i = findPort(this.input, inName), o = findPort(this.output, outName);
    if (i.idx < 0 || o.idx < 0) {
      this.close();
      throw new Error(`MIDI port not found: ${i.idx < 0 ? `input "${inName}"` : ''} ${o.idx < 0 ? `output "${outName}"` : ''}\n` +
        `Inputs: ${i.names.join(', ')}\nOutputs: ${o.names.join(', ')}`);
    }
    this.inName = i.names[i.idx]; this.outName = o.names[o.idx];
    this.devices = new Map();
    this.broadcastListeners = new Set();
    this.counts = { tx: 0, txBytes: 0, rx: 0, rxBytes: 0, echoes: 0, duplicates: 0, resends: 0, collisions: 0 };
    this.recentTx = []; // [{ key, at }] recently sent messages, to recognise echoes
    this.input.on('message', (_dt, bytes) => this._onMessage(bytes));
    this.input.openPort(i.idx);
    this.output.openPort(o.idx);
  }
  close() { try { this.input.closePort(); } catch (_) {} try { this.output.closePort(); } catch (_) {} }
  send(bytes) {
    this.counts.tx++; this.counts.txBytes += bytes.length;
    const now = Date.now();
    this.recentTx.push({ key: `${bytes.length}:${MBSP.crc32(bytes)}`, at: now });
    while (this.recentTx.length && (this.recentTx.length > 512 || now - this.recentTx[0].at > 3000)) this.recentTx.shift();
    this.output.sendMessage(Array.from(bytes));
  }
  /** True if bytes are a copy of something we sent in the last few seconds (a MIDI loop echoing it back). */
  isEcho(bytes) {
    const key = `${bytes.length}:${MBSP.crc32(bytes)}`, now = Date.now();
    return this.recentTx.some(t => t.key === key && now - t.at <= 3000);
  }
  _onMessage(bytes) {
    if (bytes[0] !== 0xF0) return;
    const d = MBSP.decodeMessage(bytes);
    if (!d) return;
    // MUID collision: another device is sending with one of our devices' MUIDs as its Source.
    const owner = this.devices.get(d.src);
    if (owner && !this.isEcho(bytes)) { owner.renewMuid(); return; }
    if (CLIENT_TO_SERVER.has(d.type)) { this.counts.echoes++; return; } // our own traffic or another client's
    this.counts.rx++; this.counts.rxBytes += bytes.length;
    if (d.dst === MBSP.MUID_BROADCAST) { for (const fn of this.broadcastListeners) fn(d); return; }
    const dev = this.devices.get(d.dst);
    if (dev) dev.deliver(d);
  }
}

// ---------- Devices ----------
class Device {
  constructor(spec, link) {
    Object.assign(this, spec);
    this.link = link;
    do { this.muid = MBSP.randomMuid(); } while (link.devices.has(this.muid));
    link.devices.set(this.muid, this);
    this.tid = randInt(0, 0x3FFF);
    this.pending = new Map();
    this.busy = false;
    this.label = spec.label || spec.deviceName;
  }
  nextTid() { this.tid = (this.tid + 1) & 0x3FFF; return this.tid; }

  /** Another device has our MUID: abandon open transactions and draw a new one (spec 5.5). */
  renewMuid() {
    const old = this.muid;
    this.link.devices.delete(old);
    do { this.muid = MBSP.randomMuid(); } while (this.link.devices.has(this.muid) || this.muid === old);
    this.link.devices.set(this.muid, this);
    this.link.counts.collisions++;
    for (const { tx } of [...this.pending.values()]) tx.finish({ error: 'MUID collision: transaction abandoned' });
    log(`WARN  ${this.label}: another device is using MUID ${MBSP.hexMuid(old)}; now using ${MBSP.hexMuid(this.muid)}`);
  }

  /** Send from this device's MUID to the target server (DiscoverServers: to everyone). */
  send(type, tid, payload, dst = type === MSG.DISCOVER_SERVERS ? MBSP.MUID_BROADCAST : serverMuid) {
    const bytes = MBSP.encodeMessage({ type, src: this.muid, dst, tid, payload, accessKey: opts.accessKey });
    if (opts.verbose) log(`  ${this.label} TX ${MBSP.MSG_NAME[type]} TID ${tid} (${bytes.length} bytes)`);
    this.link.send(bytes);
  }

  /**
   * Open a transaction: replies for this TID go to onMsg(decoded, tx). onMsg returns a value to
   * finish the transaction, or undefined to keep waiting. A quiet period of timeoutMs finishes it
   * with { timeout: true }.
   */
  open(onMsg, timeoutMs, reuseTid = null) {
    const tid = reuseTid ?? this.nextTid();
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    const tx = {
      tid, done: false,
      finish: v => { if (tx.done) return; tx.done = true; clearTimeout(tx.timer); this.pending.delete(tid); resolve(v); },
      extend: ms => { clearTimeout(tx.timer); tx.timer = setTimeout(() => tx.finish({ timeout: true }), ms ?? timeoutMs); },
    };
    tx.extend(timeoutMs);
    this.pending.set(tid, { onMsg, tx });
    return { tid, tx, promise };
  }

  deliver(d) {
    const p = this.pending.get(d.tid);
    if (!p) { this.link.counts.duplicates++; return; } // late duplicate of a finished transaction
    if (opts.verbose) log(`  ${this.label} RX ${MBSP.MSG_NAME[d.type]} TID ${d.tid}`);
    let r;
    try { r = p.onMsg(d, p.tx); } catch (err) { r = { error: `bad reply: ${err.message}` }; }
    if (r !== undefined) p.tx.finish(r);
  }
}

// ---------- Shared knowledge ----------
// Records this run stored, with their bytes, so Retrieves can be checked byte for byte.
const catalog = new Map();   // recordId -> { owner: Device, meta, payload }
const knownIds = new Set();  // every Record ID seen in Query results (including older records)
const inUse = new Set();     // Record IDs an operation is working on right now
let serverName = opts.server;
let serverMuid = null;  // the target's MUID for this session, found by DiscoverServers
let serverInfo = null;  // the target's parsed OnlineServer (versions, policies, limits)

const RESULT_KINDS = ['pass', 'warn', 'fail'];
const stats = {}; // op -> { pass, warn, fail, ms: [] }
function tally(op, kind, ms) {
  const s = stats[op] || (stats[op] = { pass: 0, warn: 0, fail: 0, ms: [] });
  s[kind]++; s.ms.push(ms);
}

function log(line) { console.log(line); }
const KIND_TAG = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };
function report(dev, op, kind, text, started) {
  const ms = Date.now() - started;
  tally(op, kind, ms);
  log(`${KIND_TAG[kind]}  ${dev.label.padEnd(14)} ${op.padEnd(16)} ${text}  (${ms} ms)`);
}

function statusFrom(d) {
  if (d.type !== MSG.STATUS) return undefined;
  if (d.src !== serverMuid) return undefined; // another server answering
  return { status: parse.status(new Reader(d.payload)) };
}
const sname = s => STATUS_NAME[s.status] || `status ${s.status}`;

/** Classify an unexpected-but-legitimate policy answer (server configuration, not a bug). */
const POLICY = new Set([STATUS.REFUSED, STATUS.BUSY, STATUS.STORAGE_FULL]);

// ---------- Operations ----------
async function opDiscover(dev) {
  const t0 = Date.now();
  const found = await discoverServer(dev, 1000);
  const names = [...found.keys()].join(', ') || 'none';
  const mine = found.get(serverName) || [];
  if (mine.length > 1) return report(dev, 'discover', 'fail', `${mine.length} servers are called "${serverName}"`, t0);
  if (!mine.length) return report(dev, 'discover', 'fail', `"${serverName}" did not answer (saw: ${names})`, t0);
  if (mine[0].muid !== serverMuid) {
    // The server restarted and drew a new MUID (or changed it after a collision): follow it.
    report(dev, 'discover', 'warn', `"${serverName}" now has MUID ${MBSP.hexMuid(mine[0].muid)} (was ${MBSP.hexMuid(serverMuid)})`, t0);
    serverMuid = mine[0].muid; serverInfo = mine[0].info;
    return;
  }
  report(dev, 'discover', 'pass', `servers: ${names}`, t0);
}

/** Store a new record, or with replace = { id, entry } save a new version over one of this device's records. */
async function opStore(dev, fault = null, replace = null) {
  const t0 = Date.now();
  const old = replace && replace.entry;
  const spec = fault === 'firmware' ? { type: C.FIRMWARE, size: [2000, 4000], number: () => 'OS' }
    : old ? { type: old.meta.type, size: [Math.max(16, Math.floor(old.payload.length * 0.8)), Math.ceil(old.payload.length * 1.2) + 16], number: () => old.meta.number }
    : weighted(dev.payloads);
  const payload = randomBytes(randInt(spec.size[0], spec.size[1]));
  // A tweaked patch keeps its number, type and name; the tags may change.
  const meta = old ? { ...old.meta, tags: randomTags() }
    : { identity: dev.identity, deviceName: dev.deviceName, sysexId: dev.sysexId, type: spec.type, number: spec.number(), name: randomName(), tags: randomTags() };
  const blockSize = fault === 'sequence' ? Math.max(1, Math.floor(payload.length / 4))
    : Math.min(pick([64, 128, 256, 512, 1024, 2048]), serverInfo ? serverInfo.maxStoreBlockSize : 256);
  const numBlocks = Math.max(1, Math.ceil(payload.length / blockSize));
  let checksum = MBSP.crc32(payload);
  if (fault === 'checksum') checksum = (checksum ^ 0x00000100) >>> 0; // one flipped bit

  // Flow control: send the header, then each block only after the Server's Store_Block_Ack asks
  // for it. The last block is answered by the final Status. Silence = resend (lost message).
  let waiter = null; // { want, resolve } while waiting for "send block <want>"
  const { tid, tx, promise } = dev.open(d => {
    if (d.type === MSG.STORE_BLOCK_ACK) {
      const n = parse.blockAck(new Reader(d.payload)).nextBlock;
      if (waiter && n === waiter.want) { const w = waiter; waiter = null; w.resolve(true); }
      return undefined; // stale or duplicated acks are ignored
    }
    return statusFrom(d);
  }, ACK_TIMEOUT_MS * (MAX_RETRIES + 2));
  promise.then(() => { if (waiter) { const w = waiter; waiter = null; w.resolve(false); } });
  const waitFor = (want, ms) => new Promise(resolve => {
    waiter = { want, resolve };
    setTimeout(() => { if (waiter && waiter.resolve === resolve) { waiter = null; resolve(false); } }, ms);
  });
  /** Send, then wait for the ack asking for block `want` (or, for want = null, for the final Status). */
  async function sendReliably(type, payloadBytes, want, label) {
    for (let attempt = 0; attempt <= MAX_RETRIES && !tx.done; attempt++) {
      if (attempt) dev.link.counts.resends++;
      if (opts.blockDelay) await sleep(opts.blockDelay);
      dev.send(type, tid, payloadBytes);
      tx.extend(ACK_TIMEOUT_MS * (MAX_RETRIES + 2));
      if (want === null) { if (await Promise.race([promise.then(() => true), sleep(ACK_TIMEOUT_MS).then(() => false)])) return true; }
      else if (await waitFor(want, ACK_TIMEOUT_MS)) return true;
    }
    if (!tx.done) tx.finish({ error: `no reply to ${label} after ${MAX_RETRIES} resend(s)` });
    return false;
  }
  const block = i => payload.subarray(i * blockSize, (i + 1) * blockSize);

  if (await sendReliably(MSG.STORE_HEADER, build.storeHeader({ ...meta, replaceId: replace ? replace.id : 0, size: payload.length, numBlocks, checksum }), 0, 'header')) {
    for (let i = 0; i < numBlocks && !tx.done; i++) {
      if (fault === 'sequence' && i === 1) {
        // Deliberately skip block 1: send block 2 where 1 is expected, then wait for the error Status.
        dev.send(MSG.STORE_DATA_BLOCK, tid, build.dataBlock({ blockIndex: 2, data: block(1) }));
        break;
      }
      const last = i === numBlocks - 1;
      if (!await sendReliably(MSG.STORE_DATA_BLOCK, build.dataBlock({ blockIndex: i, data: block(i) }), last ? null : i + 1, `block ${i}`)) break;
    }
  }
  const r = await promise;
  const what = `${meta.number} "${meta.name}" [${MBSP.payloadTypeName(meta.type)}] ${payload.length} B / ${numBlocks} blk`;
  const op = replace ? 'store:replace' : fault === 'firmware' ? 'store:firmware' : fault === 'lostfinal' ? 'store:lostfinal' : fault ? `store:bad-${fault}` : 'store';
  // OnlineServer's Policy Flags say in advance whether firmware will be accepted.
  const firmwareOk = !!(serverInfo && serverInfo.policy & MBSP.POLICY_FLAG.FIRMWARE);
  const expected = fault === 'checksum' ? STATUS.PAYLOAD_CHECKSUM_ERROR : fault === 'sequence' ? STATUS.BLOCK_SEQUENCE_ERROR
    : fault === 'firmware' && !firmwareOk ? STATUS.REFUSED : STATUS.OK;
  if (r.timeout) return report(dev, op, 'fail', `${what}: no Status reply`, t0);
  if (r.error) return report(dev, op, 'fail', `${what}: ${r.error}`, t0);
  const s = r.status;
  if (s.requestType !== MSG.STORE_HEADER) return report(dev, op, 'fail', `${what}: Status for request type ${s.requestType}`, t0);
  if (s.status === expected) {
    if (s.status === STATUS.OK) {
      if (!s.recordId) return report(dev, op, 'fail', `${what}: OK without a Record ID`, t0);
      if (replace && s.recordId !== replace.id) return report(dev, op, 'fail', `${what}: replacing #${replace.id} returned Record ID #${s.recordId}`, t0);
      catalog.set(s.recordId, { owner: dev, meta, payload, checksum });
      knownIds.add(s.recordId);
      if (fault === 'lostfinal') {
        // Pretend the Status was lost: resend the last block. The server must repeat the same Status.
        const again = dev.open(statusFrom, 3000, tid);
        dev.send(MSG.STORE_DATA_BLOCK, tid, build.dataBlock({ blockIndex: numBlocks - 1, data: block(numBlocks - 1) }));
        const r2 = await again.promise;
        const ok = r2.status && r2.status.status === STATUS.OK && r2.status.recordId === s.recordId;
        const got = r2.status ? sname(r2.status) + (r2.status.recordId ? ' #' + r2.status.recordId : '') : 'no reply';
        return report(dev, op, ok ? 'pass' : 'fail', `${what} -> OK #${s.recordId}, last block resent -> ${got}`, t0);
      }
    }
    return report(dev, op, 'pass', `${what} -> ${sname(s)}${s.recordId ? ' #' + s.recordId : ''}`, t0);
  }
  report(dev, op, POLICY.has(s.status) ? 'warn' : 'fail', `${what} -> ${sname(s)}, expected ${STATUS_NAME[expected]}`, t0);
}

/** Save a new version over one of this device's own records (a user tweaking a patch and saving again). */
async function opReplace(dev) {
  const id = pickRecord(e => e.owner === dev);
  if (id === null) return opStore(dev);
  inUse.add(id); // keep other operations off this record while its contents change
  try { await opStore(dev, null, { id, entry: catalog.get(id) }); } finally { inUse.delete(id); }
}

function pickRecord(filter) {
  const ids = [...catalog.keys()].filter(id => !inUse.has(id) && (!filter || filter(catalog.get(id))));
  return ids.length ? pick(ids) : null;
}

async function opRetrieve(dev, recordId = null, expectMissing = false) {
  const t0 = Date.now();
  if (recordId === null) {
    recordId = pickRecord();
    if (recordId === null) {
      const older = [...knownIds].filter(id => !inUse.has(id) && !catalog.has(id));
      if (!older.length) return opStore(dev);
      recordId = pick(older);
    }
  }
  inUse.add(recordId);
  try {
    const maxBlockSize = pick([0, 64, 128, 256, 1000]);
    // Flow control: ack the header and every block with Retrieve_Block_Ack ("send block n").
    // A repeated header or block (our ack was lost) is answered with the same ack again.
    let hdr = null;
    const blocks = new Map();
    let next = 0;
    let tid = 0;
    const ack = n => dev.send(MSG.RETRIEVE_BLOCK_ACK, tid, build.blockAck({ nextBlock: n }));
    const opened = dev.open((d, tx) => {
      if (d.type === MSG.STATUS) return statusFrom(d);
      if (d.src !== serverMuid) return undefined; // another server
      tx.extend(5000);
      if (d.type === MSG.RETRIEVE_HEADER) {
        const h = parse.retrieveHeader(new Reader(d.payload));
        if (!hdr) hdr = h;
        ack(next);
      } else if (d.type === MSG.RETRIEVE_DATA_BLOCK && hdr) {
        const b = parse.dataBlock(new Reader(d.payload));
        if (b.blockIndex >= hdr.numBlocks) return { error: `block index ${b.blockIndex} >= NumBlocks ${hdr.numBlocks}` };
        if (maxBlockSize && b.data.length > maxBlockSize) return { error: `block of ${b.data.length} B exceeds Max Block Size ${maxBlockSize}` };
        if (b.blockIndex === next) {
          blocks.set(next, b.data);
          next++;
          ack(next); // next = NumBlocks after the last block: "all received"
          if (next === hdr.numBlocks) return { hdr, blocks };
        } else if (b.blockIndex === next - 1) {
          ack(next); // a resend of a block we already have
        } else {
          return { error: `asked for block ${next}, got block ${b.blockIndex}` };
        }
      }
      return undefined;
    }, 5000);
    tid = opened.tid;
    const promise = opened.promise;
    dev.send(MSG.RETRIEVE_REQUEST, tid, build.retrieveRequest({ recordId, maxBlockSize }));
    const r = await promise;
    const op = expectMissing ? 'retrieve:deleted' : 'retrieve';
    const what = `#${recordId} (max blk ${maxBlockSize || 'default'})`;
    if (r.timeout) return report(dev, op, 'fail', `${what}: ${hdr ? `got ${blocks.size}/${hdr.numBlocks} blocks` : 'no reply'}`, t0);
    if (r.error) return report(dev, op, 'fail', `${what}: ${r.error}`, t0);
    if (r.status) {
      const s = r.status;
      if (expectMissing && s.status === STATUS.NOT_FOUND) return report(dev, op, 'pass', `${what} -> NOT_FOUND`, t0);
      if (s.status === STATUS.NOT_FOUND && !catalog.has(recordId)) {
        knownIds.delete(recordId); // an older record someone else deleted
        return report(dev, op, 'warn', `${what} -> NOT_FOUND (record from before this run, since deleted)`, t0);
      }
      return report(dev, op, POLICY.has(s.status) ? 'warn' : 'fail', `${what} -> ${sname(s)}`, t0);
    }
    if (expectMissing) return report(dev, op, 'fail', `${what}: deleted record was still returned`, t0);
    const total = [...r.blocks.values()].reduce((n, b) => n + b.length, 0);
    const data = new Uint8Array(total);
    let off = 0;
    for (let i = 0; i < r.hdr.numBlocks; i++) { data.set(r.blocks.get(i), off); off += r.blocks.get(i).length; }
    if (total !== r.hdr.size) return report(dev, op, 'fail', `${what}: received ${total} B, header declared Payload Size ${r.hdr.size}`, t0);
    if (MBSP.crc32(data) !== r.hdr.checksum) return report(dev, op, 'fail', `${what}: payload CRC-32 mismatch`, t0);
    if (r.hdr.recordId !== recordId) return report(dev, op, 'fail', `${what}: header has Record ID ${r.hdr.recordId}`, t0);
    const known = catalog.get(recordId);
    if (known) {
      const m = known.meta;
      if (data.length !== known.payload.length || data.some((v, i) => v !== known.payload[i])) return report(dev, op, 'fail', `${what}: payload bytes differ from what was stored`, t0);
      if (r.hdr.name !== m.name || r.hdr.number !== m.number || r.hdr.tags.join('|') !== m.tags.join('|') ||
          r.hdr.deviceName !== m.deviceName || r.hdr.sysexId !== m.sysexId || r.hdr.identity.join() !== m.identity.join()) {
        return report(dev, op, 'fail', `${what}: header metadata differs from what was stored`, t0);
      }
    }
    report(dev, op, 'pass', `${what} -> ${r.hdr.number} "${r.hdr.name}" ${total} B in ${r.hdr.numBlocks} blk${known ? ', bytes verified' : ', CRC-32 verified'}`, t0);
  } finally { inUse.delete(recordId); }
}

function queryFor(dev) {
  const base = { deviceMatchMode: 0, identity: [0, 0, 0, 0, 0, 0, 0], sysexId: 0x7F, type: 0x7F, number: '', name: '', tags: [], startIndex: 0, maxResults: randInt(3, 20) };
  const variant = pick(['mine', 'model', 'manufacturer', 'tag', 'name', 'type', 'number', 'page', 'nomatch']);
  const q = { ...base };
  switch (variant) {
    case 'mine': Object.assign(q, { deviceMatchMode: 3, identity: dev.identity, sysexId: dev.sysexId }); break;
    case 'model': Object.assign(q, { deviceMatchMode: 3, identity: dev.identity }); break;
    case 'manufacturer': Object.assign(q, { deviceMatchMode: 1, identity: dev.identity }); break;
    case 'tag': q.tags = [pick(TAGS).toLowerCase()]; break;
    case 'name': q.name = pick(rnd() < 0.5 ? ADJ : NOUN).slice(0, 4).toUpperCase(); break;
    case 'type': q.type = pick(STUDIO_TYPES); break;
    case 'number': { const id = pickRecord(); q.number = id ? catalog.get(id).meta.number.toLowerCase() : num3(); break; }
    case 'page': Object.assign(q, { startIndex: randInt(0, 6), maxResults: randInt(1, 4) }); break;
    case 'nomatch': q.name = 'zz-no-such-patch'; break;
  }
  return { variant, q };
}

async function opQuery(dev) {
  const t0 = Date.now();
  const { variant, q } = queryFor(dev);
  const results = new Map(); // resultIndex -> result (duplicates collapse)
  let total = null;
  const { tid, promise } = dev.open((d) => {
    if (d.type === MSG.STATUS) return statusFrom(d);
    if (d.type !== MSG.QUERY_RESULT) return undefined;
    if (d.src !== serverMuid) return undefined; // another server
    const r = parse.queryResult(new Reader(d.payload));
    if (total !== null && r.totalMatches !== total) return { error: `Total Matches changed from ${total} to ${r.totalMatches}` };
    total = r.totalMatches;
    results.set(r.resultIndex, r);
    const expected = Math.min(q.startIndex + q.maxResults, total) - q.startIndex;
    return results.size >= expected ? { done: true } : undefined;
  }, 4000);
  dev.send(MSG.QUERY_REQUEST, tid, build.queryRequest({ ...q }));
  const r = await promise;
  const op = `query:${variant}`;
  if (r.timeout) return report(dev, op, 'fail', results.size ? `only ${results.size} result(s) before timeout` : 'no reply', t0);
  if (r.error) return report(dev, op, 'fail', r.error, t0);
  if (r.status) {
    const s = r.status;
    if (s.status === STATUS.NOT_FOUND) return report(dev, op, 'pass', 'no matches -> NOT_FOUND', t0);
    return report(dev, op, POLICY.has(s.status) ? 'warn' : 'fail', `-> ${sname(s)}`, t0);
  }
  if (variant === 'nomatch') return report(dev, op, 'fail', `expected NOT_FOUND, got ${results.size} result(s)`, t0);
  const list = [...results.values()].sort((a, b) => a.resultIndex - b.resultIndex);
  for (let i = 0; i < list.length; i++) {
    const res = list[i];
    if (res.resultIndex !== q.startIndex + i) return report(dev, op, 'fail', `result indexes not contiguous from ${q.startIndex}`, t0);
    if (i && res.recordId <= list[i - 1].recordId) return report(dev, op, 'fail', 'results not in ascending Record ID order', t0);
    if (!MBSP.recordMatchesQuery(res, q)) return report(dev, op, 'fail', `record #${res.recordId} "${res.name}" does not match the filter`, t0);
    const known = catalog.get(res.recordId);
    // A record being replaced right now may show either version, so only settled records are compared.
    if (known && !inUse.has(res.recordId) && (known.meta.name !== res.name || known.payload.length !== res.size)) return report(dev, op, 'fail', `record #${res.recordId} metadata differs from what was stored`, t0);
    knownIds.add(res.recordId);
  }
  report(dev, op, 'pass', `${list.length} of ${total} match(es), from index ${q.startIndex}`, t0);
}

async function sendDelete(dev, recordId) {
  const { tid, promise } = dev.open(statusFrom, 4000);
  dev.send(MSG.DELETE_REQUEST, tid, build.deleteRequest({ recordId, identity: dev.identity, sysexId: dev.sysexId }));
  return promise;
}

async function opDelete(dev) {
  const t0 = Date.now();
  const foreign = rnd() < 0.25;
  const same = (a, b) => a.identity.join() === b.identity.join() && a.sysexId === b.sysexId;
  const recordId = pickRecord(e => foreign ? !same(e.owner, dev) : e.owner === dev);
  if (recordId === null) return foreign ? opQuery(dev) : opStore(dev);
  inUse.add(recordId);
  const entry = catalog.get(recordId);
  const op = foreign ? 'delete:foreign' : 'delete:own';
  const what = `#${recordId} ${entry.meta.number} "${entry.meta.name}"${foreign ? ` (owned by ${entry.owner.label})` : ''}`;
  try {
    const r = await sendDelete(dev, recordId);
    if (r.timeout) return report(dev, op, 'fail', `${what}: no Status reply`, t0);
    if (r.error) return report(dev, op, 'fail', `${what}: ${r.error}`, t0);
    const s = r.status;
    if (s.requestType !== MSG.DELETE_REQUEST || s.recordId !== recordId) return report(dev, op, 'fail', `${what}: Status does not echo the request`, t0);
    if (s.status === STATUS.OK) { catalog.delete(recordId); knownIds.delete(recordId); }
    if (foreign) {
      if (s.status === STATUS.REFUSED) return report(dev, op, 'pass', `${what} -> REFUSED (not the owner)`, t0);
      if (s.status === STATUS.OK) return report(dev, op, 'warn', `${what} -> OK (server's owner check is off)`, t0);
      return report(dev, op, 'fail', `${what} -> ${sname(s)}`, t0);
    }
    if (s.status !== STATUS.OK) return report(dev, op, POLICY.has(s.status) ? 'warn' : 'fail', `${what} -> ${sname(s)}`, t0);
    report(dev, op, 'pass', `${what} -> OK`, t0);
  } finally { inUse.delete(recordId); }
  // Sometimes confirm the record is really gone.
  if (!foreign && rnd() < 0.4) await opRetrieve(dev, recordId, true);
}

async function opFault(dev) {
  const kind = pick(['checksum', 'sequence', 'missing', 'otherserver', 'invalid', 'firmware', 'orphan', 'unknowntype', 'lostfinal']);
  if (kind === 'checksum' || kind === 'sequence' || kind === 'firmware' || kind === 'lostfinal') return opStore(dev, kind);
  const t0 = Date.now();
  if (kind === 'orphan') {
    // A Store_Data_Block with no Store_Header: the server must answer Unknown Transaction.
    const { tid, promise } = dev.open(statusFrom, 3000);
    dev.send(MSG.STORE_DATA_BLOCK, tid, build.dataBlock({ blockIndex: 0, data: [1, 2, 3] }));
    const r = await promise;
    const ok = r.status && r.status.status === STATUS.UNKNOWN_TRANSACTION && r.status.requestType === MSG.STORE_HEADER;
    return report(dev, 'fault:orphan', ok ? 'pass' : 'fail', `data block with no Store -> ${r.status ? sname(r.status) : r.timeout ? 'no reply' : r.error}`, t0);
  }
  if (kind === 'unknowntype') {
    // Message Type 55 is not defined: servers must ignore it silently.
    const { tid, promise } = dev.open(() => ({ replied: true }), 1200);
    dev.send(55, tid, build.queryRequest({}));
    const r = await promise;
    return report(dev, 'fault:unknowntype', r.timeout ? 'pass' : 'fail', r.timeout ? 'Message Type 55 ignored' : 'server answered Message Type 55', t0);
  }
  if (kind === 'missing') {
    const recordId = randInt(0x1F0000, 0x1FFFFF);
    const { tid, promise } = dev.open(statusFrom, 3000);
    dev.send(MSG.RETRIEVE_REQUEST, tid, build.retrieveRequest({ recordId }));
    const r = await promise;
    const ok = r.status && r.status.status === STATUS.NOT_FOUND && r.status.recordId === recordId;
    return report(dev, 'fault:missing', ok ? 'pass' : 'fail', `retrieve #${recordId} -> ${r.status ? sname(r.status) : r.timeout ? 'no reply' : r.error}`, t0);
  }
  if (kind === 'otherserver') {
    let other;
    do { other = MBSP.randomMuid(); } while (other === serverMuid || dev.link.devices.has(other));
    const { tid, promise } = dev.open(() => ({ replied: true }), 1200);
    dev.send(MSG.QUERY_REQUEST, tid, build.queryRequest({}), other);
    const r = await promise;
    const label = `MUID ${MBSP.hexMuid(other)}`;
    return report(dev, 'fault:otherserver', r.timeout ? 'pass' : 'fail', r.timeout ? `query for ${label} ignored` : `a server answered a query for ${label}`, t0);
  }
  // invalid: a Query with Max Results 0
  const { tid, promise } = dev.open(statusFrom, 3000);
  dev.send(MSG.QUERY_REQUEST, tid, build.queryRequest({ maxResults: 0 }));
  const r = await promise;
  const ok = r.status && r.status.status === STATUS.INVALID_REQUEST;
  report(dev, 'fault:invalid', ok ? 'pass' : 'fail', `query with Max Results 0 -> ${r.status ? sname(r.status) : r.timeout ? 'no reply' : r.error}`, t0);
}

const OPS = [
  { weight: 26, run: opStore },
  { weight: 8, run: opReplace },
  { weight: 24, run: opQuery },
  { weight: 20, run: opRetrieve },
  { weight: 10, run: opDelete },
  { weight: 7, run: opFault },
  { weight: 5, run: opDiscover },
];

// ---------- Run ----------
/** DiscoverServers: returns Map name -> [{ muid, info }]. A name with more than one entry is shared by several servers. */
async function discoverServer(dev, waitMs = 1500) {
  const seen = new Map();
  const { tid, promise } = dev.open(d => {
    if (d.type !== MSG.ONLINE_SERVER) return undefined;
    const info = parse.onlineServer(new Reader(d.payload));
    const list = seen.get(info.serverName) || [];
    if (!list.some(e => e.muid === d.src)) list.push({ muid: d.src, info });
    seen.set(info.serverName, list);
    return undefined;
  }, waitMs);
  dev.send(MSG.DISCOVER_SERVERS, tid, build.discoverServers());
  await promise;
  return seen;
}

function describeServer(o) {
  const F = MBSP.POLICY_FLAG, p = o.policy;
  const pol = [p & F.STORE_REFUSED ? 'read-only' : 'stores', p & F.DELETE_REFUSED ? 'no deletes' : p & F.OWNER_DELETE ? 'owner-only deletes' : 'any deletes',
    p & F.FIRMWARE ? 'firmware accepted' : 'firmware refused'];
  if (p & F.ACCESS_KEY) pol.push('access key required');
  const free = o.freeSpace === MBSP.LIMITS.FREE_SPACE_UNKNOWN ? 'not reported' : `${(o.freeSpace / 1048576).toFixed(1)} MB`;
  return `versions ${o.versions.join(', ')}; ${pol.join(', ')}; max store block ${o.maxStoreBlockSize} B; free space ${free}`;
}

function summary(link, startedAt) {
  const secs = (Date.now() - startedAt) / 1000;
  log('\n================ Summary ================');
  log(`${'Operation'.padEnd(20)}${'Pass'.padStart(6)}${'Warn'.padStart(6)}${'Fail'.padStart(6)}${'Avg ms'.padStart(9)}${'Max ms'.padStart(9)}`);
  let totals = { pass: 0, warn: 0, fail: 0 };
  for (const op of Object.keys(stats).sort()) {
    const s = stats[op];
    const avg = Math.round(s.ms.reduce((a, b) => a + b, 0) / s.ms.length);
    log(`${op.padEnd(20)}${String(s.pass).padStart(6)}${String(s.warn).padStart(6)}${String(s.fail).padStart(6)}${String(avg).padStart(9)}${String(Math.max(...s.ms)).padStart(9)}`);
    for (const k of RESULT_KINDS) totals[k] += s[k];
  }
  log(`${'TOTAL'.padEnd(20)}${String(totals.pass).padStart(6)}${String(totals.warn).padStart(6)}${String(totals.fail).padStart(6)}`);
  const c = link.counts;
  log(`\nMIDI: sent ${c.tx} messages (${(c.txBytes / 1024).toFixed(1)} KB), received ${c.rx} (${(c.rxBytes / 1024).toFixed(1)} KB) in ${secs.toFixed(1)} s`);
  if (c.resends) log(`Store messages resent after an ack timeout: ${c.resends}`);
  if (c.collisions) log(`MUID collisions detected (a device drew a new MUID): ${c.collisions}`);
  if (c.duplicates) {
    log(`Duplicate or late replies ignored: ${c.duplicates}. More than a few means the server is receiving each request twice`);
    log('or replying twice: check that it has exactly one input and one output enabled for this loopback.');
  }
  log(`Records stored by this run and still on the server: ${catalog.size}`);
  log(`Seed: ${opts.seed}  (repeat this run with --seed ${opts.seed})`);
  return totals;
}

async function main() {
  if (opts.list) {
    const i = new midi.Input(), o = new midi.Output();
    log('Inputs:'); for (let n = 0; n < i.getPortCount(); n++) log(`  ${i.getPortName(n)}`);
    log('Outputs:'); for (let n = 0; n < o.getPortCount(); n++) log(`  ${o.getPortName(n)}`);
    return 0;
  }
  const link = new Link(opts.in, opts.out);
  const devices = STUDIO.map(s => new Device(s, link));
  log(`MBSP studio: ${devices.length} devices, sending on "${link.outName}", listening on "${link.inName}", seed ${opts.seed}`);
  link.broadcastListeners.add(d => {
    if (d.type !== MSG.ONLINE_SERVER) return;
    const o = parse.onlineServer(new Reader(d.payload));
    if (opts.verbose) log(`  beacon: ${o.serverName} (MUID ${MBSP.hexMuid(d.src)})`);
    // A server that changed its MUID (after a collision) announces itself: follow it.
    if (o.serverName === serverName && serverMuid !== null && d.src !== serverMuid) {
      log(`  "${serverName}" announced a new MUID ${MBSP.hexMuid(d.src)} (was ${MBSP.hexMuid(serverMuid)})`);
      serverMuid = d.src; serverInfo = o;
    }
  });

  const found = await discoverServer(devices[0]);
  const servers = [...found.keys()];
  const shared = servers.filter(n => found.get(n).length > 1);
  for (const n of shared) log(`Warning: ${found.get(n).length} servers are called "${n}" (MUIDs ${found.get(n).map(e => MBSP.hexMuid(e.muid)).join(', ')}). Rename one of them.`);
  if (!serverName) {
    if (!servers.length) {
      log('No MBSP server answered DiscoverServers. Check that the server page is online, listens on the input this');
      log(`client's output "${link.outName}" leads to, and replies on an output that leads to "${link.inName}".`);
      link.close(); return 1;
    }
    serverName = servers.find(n => found.get(n).length === 1) || servers[0];
  }
  if (found.has(serverName) && found.get(serverName).length > 1) {
    log(`"${serverName}" is shared by several servers, so it can't be used as a target. Rename one of them, or pick another with --server.`);
    link.close(); return 1;
  }
  log(`Servers found: ${servers.join(', ') || 'none'}. Target: "${serverName}"`);
  const target = (found.get(serverName) || [])[0];
  if (!target) { log(`"${serverName}" did not answer DiscoverServers, so its MUID is unknown.`); link.close(); return 1; }
  serverMuid = target.muid; serverInfo = target.info;
  log(`  MUID ${MBSP.hexMuid(serverMuid)}; ${describeServer(serverInfo)}`);
  log('');

  const startedAt = Date.now();
  let started = 0, stopping = false;
  process.on('SIGINT', () => { if (stopping) process.exit(130); stopping = true; log('\nStopping after the operations in progress... (Ctrl+C again to quit now)'); });

  async function worker() {
    while (!stopping && (opts.ops === 0 || started < opts.ops)) {
      const idle = devices.filter(d => !d.busy);
      if (!idle.length) { await sleep(20); continue; }
      started++;
      const dev = pick(idle);
      dev.busy = true;
      try { await weighted(OPS).run(dev); } catch (err) { report(dev, 'internal', 'fail', err.stack || String(err), Date.now()); }
      finally { dev.busy = false; }
      if (opts.rate) await sleep(randInt(Math.floor(opts.rate / 2), opts.rate));
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, devices.length) }, worker));

  if (opts.cleanup && catalog.size) {
    log(`\nCleanup: deleting ${catalog.size} record(s) stored by this run`);
    for (const [id, e] of [...catalog]) {
      const r = await sendDelete(e.owner, id);
      if (r.status && r.status.status === STATUS.OK) catalog.delete(id);
      else log(`  could not delete #${id}: ${r.status ? sname(r.status) : 'no reply'}`);
    }
  }

  await sleep(300); // let late duplicates arrive so they're counted
  const totals = summary(link, startedAt);
  link.close();
  return totals.fail ? 1 : 0;
}

main().then(code => process.exit(code), err => { console.error(err.message || err); process.exit(1); });

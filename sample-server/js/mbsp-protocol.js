/* mbsp-protocol.js: MIDI Bulk Storage Protocol v1 message codec.
 *
 * Pure functions, no browser APIs, so it runs in the page and under Node.
 * Everything is exposed on globalThis.MBSP.
 *
 * Interpretations of the spec (docs/MBSP-Specification-v1.0-Draft2.pdf) made here:
 *  - Envelope: ... Access Key, Source MUID (u28), Destination MUID (u28), Transaction ID, Message Type.
 *    Requests go from the Client's MUID to the Server's MUID (DiscoverServers to broadcast 0FFFFFFF).
 *  - Message Checksum: Roland algorithm, (128 - (sum & 0x7F)) & 0x7F, over every byte
 *    after F0 up to (not including) the checksum byte itself.
 *  - Full Payload Checksum: CRC-32 (IEEE 802.3 / zlib: reflected polynomial 0xEDB88320,
 *    init 0xFFFFFFFF, final XOR 0xFFFFFFFF) over the re-assembled payload bytes, sent as a
 *    u32 in five 7-bit bytes, LSB first. Check value: crc32("123456789") = 0xCBF43926.
 */
(function (root) {
  'use strict';
  const MBSP = root.MBSP = root.MBSP || {};

  const SYSEX_START = 0xF0;
  const SYSEX_END = 0xF7;
  const HEADER_PREFIX = [0x7E, 0x7F, 0x6A, 0x00]; // Non-RT, broadcast, MBSP (placeholder sub-ID), base protocol
  const PROTOCOL_VERSION = 1;
  const MAX_ACCESS_KEY = 16;
  const MUID_BROADCAST = 0x0FFFFFFF;

  const MSG = {
    DISCOVER_SERVERS: 0,
    ONLINE_SERVER: 1,
    STATUS: 2,
    STORE_HEADER: 10,
    STORE_DATA_BLOCK: 11,
    STORE_BLOCK_ACK: 12,
    RETRIEVE_REQUEST: 20,
    RETRIEVE_HEADER: 21,
    RETRIEVE_DATA_BLOCK: 22,
    RETRIEVE_BLOCK_ACK: 23,
    QUERY_REQUEST: 30,
    QUERY_RESULT: 31,
    DELETE_REQUEST: 40,
  };
  const MSG_NAME = {};
  for (const [k, v] of Object.entries(MSG)) MSG_NAME[v] = k;

  const STATUS = {
    OK: 0, NOT_FOUND: 1, REFUSED: 2, PAYLOAD_CHECKSUM_ERROR: 3, BLOCK_SEQUENCE_ERROR: 4,
    TRANSACTION_TIMEOUT: 5, STORAGE_FULL: 6, BUSY: 7, INVALID_REQUEST: 8, UNKNOWN_TRANSACTION: 9,
  };
  const STATUS_NAME = {};
  for (const [k, v] of Object.entries(STATUS)) STATUS_NAME[v] = k;

  /** OnlineServer Policy Flags (bits 5-6 reserved, sent as 0). */
  const POLICY_FLAG = {
    STORE_REFUSED: 0x01,   // read-only: every Store is refused
    DELETE_REFUSED: 0x02,  // every Delete is refused
    OWNER_DELETE: 0x04,    // Delete only from the Device Identity + SysEx ID that stored the Record
    FIRMWARE: 0x08,        // Stores of Category 0E (Firmware / OS) are accepted
    ACCESS_KEY: 0x10,      // requests must carry the Server's Access Key
  };
  /** Protocol Versions this implementation supports (OnlineServer lists them). */
  const SUPPORTED_VERSIONS = [1];

  // Client Payload Type = Category (bits 0-5) + Collection bit (bit 6). 7F = Any (queries only).
  const COLLECTION_BIT = 0x40;
  const CATEGORY_MASK = 0x3F;
  const CATEGORY = {
    UNKNOWN: 0x00, PATCH: 0x01, PERFORMANCE: 0x02, GLOBAL: 0x03, FILE: 0x04, DRUM_KIT: 0x05,
    PATTERN: 0x06, SONG: 0x07, SAMPLE: 0x08, TUNING: 0x09, EFFECTS: 0x0A, CONTROLLER_TEMPLATE: 0x0B,
    CALIBRATION: 0x0C, SET_LIST: 0x0D, FIRMWARE: 0x0E,
  };
  /** [single name, collection name] per Category. */
  const CATEGORY_NAME = {
    0x00: ['Unknown', 'Collection (unknown)'],
    0x01: ['Patch', 'Bank of Patches'],
    0x02: ['Performance', 'Bank of Performances'],
    0x03: ['Global / System', 'Global / System set'],
    0x04: ['File', 'Files'],
    0x05: ['Drum Kit', 'Bank of Drum Kits'],
    0x06: ['Pattern', 'Bank of Patterns'],
    0x07: ['Song', 'Bank of Songs'],
    0x08: ['Sample / Waveform', 'Sample / Waveform bank'],
    0x09: ['Tuning', 'Bank of Tunings'],
    0x0A: ['Effects Program', 'Bank of Effects Programs'],
    0x0B: ['Controller Template', 'Bank of Controller Templates'],
    0x0C: ['Calibration', 'Calibration set'],
    0x0D: ['Set List', 'Bank of Set Lists'],
    0x0E: ['Firmware / OS', 'Firmware / OS set'],
  };
  const payloadCategory = t => t & CATEGORY_MASK;
  const isCollection = t => t !== 0x7F && (t & COLLECTION_BIT) !== 0;
  /** A Payload Type a Client may Store: not 7F (Any) and not Category 3F (reserved). */
  const isStorablePayloadType = t => Number.isInteger(t) && t >= 0 && t < 0x7F && payloadCategory(t) !== 0x3F;

  function payloadTypeName(t) {
    if (t === 0x7F) return 'Any';
    const cat = payloadCategory(t), coll = isCollection(t) ? 1 : 0;
    if (CATEGORY_NAME[cat]) return CATEGORY_NAME[cat][coll];
    const base = cat >= 0x30 && cat <= 0x3E ? `Vendor ${hex2(cat)}` : `Reserved ${hex2(cat)}`;
    return coll ? `${base} collection` : base;
  }

  const LIMITS = {
    SERVER_NAME_MIN: 4, SERVER_NAME_MAX: 16,
    DEVICE_NAME_MAX: 32,
    NUMBER_MIN: 1, NUMBER_MAX: 8,
    NAME_MIN: 0, NAME_MAX: 32, // Payload Name is optional (length 0 = not provided)
    TAGS_MAX: 8, TAG_MIN: 1, TAG_MAX: 16,
    U14_MAX: 0x3FFF, U21_MAX: 0x1FFFFF, U28_MAX: 0x0FFFFFFF, U32_MAX: 0xFFFFFFFF,
    SYSEX_ID_NONE: 0x7F,
    TYPE_ANY: 0x7F,
    MAX_RESULTS: 127,
    VERSIONS_MAX: 16,
    STORE_BLOCK_MIN: 256,          // smallest Max Store Block Size a Server may announce
    FREE_SPACE_UNKNOWN: 0x0FFFFFFF, // OnlineServer Free Space: not reported, or 256 MiB or more
  };

  /** Thrown when a payload field is missing or out of range. */
  class MbspFieldError extends Error {}

  function rolandChecksum(bytes, start = 0, end = bytes.length) {
    let sum = 0;
    for (let i = start; i < end; i++) sum += bytes[i];
    return (128 - (sum & 0x7F)) & 0x7F;
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  /** CRC-32 (IEEE 802.3 / zlib) of bytes[0..end). Used for the Full Payload Checksum. */
  function crc32(bytes, end = bytes.length) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function hex8(v) { return (v >>> 0).toString(16).toUpperCase().padStart(8, '0'); }

  function isPrintableAscii(str) {
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 0x20 || c > 0x7E) return false;
    }
    return true;
  }

  // ---------- Writer: builds 7-bit payload bytes ----------
  class Writer {
    constructor() { this.bytes = []; }
    u7(v) { this._check(v, 0x7F, 'u7'); this.bytes.push(v); return this; }
    u14(v) { this._check(v, LIMITS.U14_MAX, 'u14'); this.bytes.push(v & 0x7F, (v >> 7) & 0x7F); return this; }
    u21(v) { this._check(v, LIMITS.U21_MAX, 'u21'); this.bytes.push(v & 0x7F, (v >> 7) & 0x7F, (v >> 14) & 0x7F); return this; }
    u28(v) {
      this._check(v, LIMITS.U28_MAX, 'u28');
      this.bytes.push(v & 0x7F, (v >>> 7) & 0x7F, (v >>> 14) & 0x7F, (v >>> 21) & 0x7F);
      return this;
    }
    /** 32-bit value in five 7-bit bytes, LSB first (the last byte carries bits 28-31). */
    u32(v) {
      this._check(v, LIMITS.U32_MAX, 'u32');
      this.bytes.push(v & 0x7F, (v >>> 7) & 0x7F, (v >>> 14) & 0x7F, (v >>> 21) & 0x7F, (v >>> 28) & 0x0F);
      return this;
    }
    raw(arr) { for (const b of arr) this.u7(b); return this; }
    /** Length-prefixed ASCII string. */
    str(s, min, max, what) {
      if (typeof s !== 'string' || s.length < min || s.length > max || !isPrintableAscii(s)) {
        throw new MbspFieldError(`${what} must be ${min}-${max} printable ASCII characters`);
      }
      this.u7(s.length);
      for (let i = 0; i < s.length; i++) this.bytes.push(s.charCodeAt(i));
      return this;
    }
    identity(id) {
      if (!id || id.length !== 7) throw new MbspFieldError('Device Identity must be 7 bytes');
      return this.raw(id);
    }
    tags(tags, what = 'Tag') {
      tags = tags || [];
      if (tags.length > LIMITS.TAGS_MAX) throw new MbspFieldError(`At most ${LIMITS.TAGS_MAX} tags`);
      this.u7(tags.length);
      for (const t of tags) this.str(t, LIMITS.TAG_MIN, LIMITS.TAG_MAX, what);
      return this;
    }
    _check(v, max, what) {
      if (!Number.isInteger(v) || v < 0 || v > max) throw new MbspFieldError(`${what} value ${v} out of range`);
    }
  }

  // ---------- Reader: walks a 7-bit payload ----------
  class Reader {
    constructor(bytes) { this.b = bytes; this.p = 0; }
    get remaining() { return this.b.length - this.p; }
    need(n, what) { if (this.p + n > this.b.length) throw new MbspFieldError(`Payload truncated reading ${what}`); }
    u7(what = 'byte') { this.need(1, what); return this.b[this.p++]; }
    u14(what = 'u14') { this.need(2, what); const v = this.b[this.p] | (this.b[this.p + 1] << 7); this.p += 2; return v; }
    u21(what = 'u21') { this.need(3, what); const v = this.b[this.p] | (this.b[this.p + 1] << 7) | (this.b[this.p + 2] << 14); this.p += 3; return v; }
    u28(what = 'u28') {
      this.need(4, what);
      const v = (this.b[this.p] | (this.b[this.p + 1] << 7) | (this.b[this.p + 2] << 14) | (this.b[this.p + 3] << 21)) >>> 0;
      this.p += 4; return v;
    }
    u32(what = 'u32') {
      this.need(5, what);
      const b = this.b, p = this.p;
      if (b[p + 4] > 0x0F) throw new MbspFieldError(`${what} out of range`);
      const v = (b[p] | (b[p + 1] << 7) | (b[p + 2] << 14) | (b[p + 3] << 21)) + b[p + 4] * 0x10000000;
      this.p += 5; return v;
    }
    bytes(n, what = 'data') { this.need(n, what); const out = this.b.slice(this.p, this.p + n); this.p += n; return out; }
    str(min, max, what) {
      const len = this.u7(`${what} length`);
      if (len < min || len > max) throw new MbspFieldError(`${what} length ${len} not in ${min}-${max}`);
      const raw = this.bytes(len, what);
      let s = '';
      for (const c of raw) {
        if (c < 0x20 || c > 0x7E) throw new MbspFieldError(`${what} contains non-printable ASCII`);
        s += String.fromCharCode(c);
      }
      return s;
    }
    identity() { return Array.from(this.bytes(7, 'Device Identity')); }
    tags(what = 'Tag') {
      const n = this.u7('Number of Tags');
      if (n > LIMITS.TAGS_MAX) throw new MbspFieldError(`Number of ${what}s ${n} exceeds ${LIMITS.TAGS_MAX}`);
      const out = [];
      for (let i = 0; i < n; i++) out.push(this.str(LIMITS.TAG_MIN, LIMITS.TAG_MAX, what));
      return out;
    }
    end() { if (this.remaining !== 0) throw new MbspFieldError(`${this.remaining} unexpected trailing byte(s)`); }
  }

  // ---------- Envelope ----------

  /**
   * Wrap a payload in the MBSP SysEx envelope.
   * @returns {Uint8Array} complete F0 ... F7 message
   */
  function encodeMessage({ type, src, dst, tid, payload = [], accessKey = '', version = PROTOCOL_VERSION }) {
    const w = new Writer();
    w.raw(HEADER_PREFIX);
    w.u7(version);
    if (accessKey.length > MAX_ACCESS_KEY || !isPrintableAscii(accessKey)) throw new MbspFieldError('Access Key must be 0-16 ASCII characters');
    w.u7(accessKey.length);
    for (let i = 0; i < accessKey.length; i++) w.u7(accessKey.charCodeAt(i));
    w.u28(src);
    w.u28(dst);
    w.u14(tid);
    w.u7(type);
    w.raw(payload);
    const body = w.bytes;
    const out = new Uint8Array(body.length + 3);
    out[0] = SYSEX_START;
    out.set(body, 1);
    out[body.length + 1] = rolandChecksum(body);
    out[body.length + 2] = SYSEX_END;
    return out;
  }

  /**
   * Parse an MBSP envelope. Returns null for anything that is not a well-formed MBSP header
   * (the spec says malformed headers are silently ignored).
   * @returns {{version:number, accessKey:string, src:number, dst:number, tid:number, type:number, payload:Uint8Array}|null}
   */
  function decodeMessage(data) {
    const b = data instanceof Uint8Array ? data : Uint8Array.from(data);
    // F0 + 4 prefix + ver + keylen + src4 + dst4 + tid2 + type + cs + F7 = 20 bytes minimum
    if (b.length < 20 || b[0] !== SYSEX_START || b[b.length - 1] !== SYSEX_END) return null;
    for (let i = 0; i < HEADER_PREFIX.length; i++) if (b[1 + i] !== HEADER_PREFIX[i]) return null;
    for (let i = 1; i < b.length - 1; i++) if (b[i] > 0x7F) return null;
    const csIndex = b.length - 2;
    if (rolandChecksum(b, 1, csIndex) !== b[csIndex]) return null;

    let p = 5;
    const version = b[p++];
    const keyLen = b[p++];
    if (keyLen > MAX_ACCESS_KEY) return null;
    if (p + keyLen + 11 > csIndex) return null;
    let accessKey = '';
    for (let i = 0; i < keyLen; i++) accessKey += String.fromCharCode(b[p++]);
    const u28 = () => { const v = (b[p] | (b[p + 1] << 7) | (b[p + 2] << 14) | (b[p + 3] << 21)) >>> 0; p += 4; return v; };
    const src = u28(), dst = u28();
    const tid = b[p] | (b[p + 1] << 7);
    p += 2;
    const type = b[p++];
    return { version, accessKey, src, dst, tid, type, payload: b.slice(p, csIndex) };
  }

  // ---------- Payload builders (both directions, used by the server and the self-test client) ----------

  const build = {
    discoverServers() { return []; },

    onlineServer({ serverName, versions = SUPPORTED_VERSIONS, policy = 0, maxStoreBlockSize = LIMITS.U14_MAX, freeSpace = LIMITS.FREE_SPACE_UNKNOWN }) {
      if (!versions.length || versions.length > LIMITS.VERSIONS_MAX) throw new MbspFieldError(`1-${LIMITS.VERSIONS_MAX} Supported Versions`);
      if (maxStoreBlockSize < LIMITS.STORE_BLOCK_MIN) throw new MbspFieldError(`Max Store Block Size must be at least ${LIMITS.STORE_BLOCK_MIN}`);
      const w = new Writer().str(serverName, LIMITS.SERVER_NAME_MIN, LIMITS.SERVER_NAME_MAX, 'Server Name').u7(versions.length);
      for (const v of versions) w.u7(v);
      return w.u7(policy & 0x1F).u14(maxStoreBlockSize).u28(Math.min(freeSpace, LIMITS.FREE_SPACE_UNKNOWN)).bytes;
    },

    status({ requestType, status, recordId = 0 }) {
      return new Writer()
        .u7(requestType).u7(status).u21(recordId).bytes;
    },

    /** r.replaceId: 0 (or absent) = store a new Record; otherwise the Record ID to replace. */
    storeHeader(r) {
      return new Writer()
        .u21(r.replaceId || 0)
        .identity(r.identity)
        .str(r.deviceName || '', 0, LIMITS.DEVICE_NAME_MAX, 'Device Name')
        .u7(r.sysexId ?? LIMITS.SYSEX_ID_NONE)
        .u7(r.type)
        .str(r.number, LIMITS.NUMBER_MIN, LIMITS.NUMBER_MAX, 'Payload Number')
        .str(r.name || '', LIMITS.NAME_MIN, LIMITS.NAME_MAX, 'Payload Name')
        .tags(r.tags)
        .u21(r.size)
        .u14(r.numBlocks)
        .u32(r.checksum).bytes;
    },

    /** Store_Block_Ack / Retrieve_Block_Ack: "received everything before nextBlock, send nextBlock". */
    blockAck({ nextBlock }) { return new Writer().u14(nextBlock).bytes; },

    dataBlock({ blockIndex, data }) {
      return new Writer()
        .u14(blockIndex).u14(data.length).raw(data).bytes;
    },

    retrieveRequest({ recordId, maxBlockSize = 0 }) {
      return new Writer()
        .u21(recordId).u14(maxBlockSize).bytes;
    },

    retrieveHeader(r) {
      return new Writer()
        .u21(r.recordId)
        .identity(r.identity)
        .str(r.deviceName || '', 0, LIMITS.DEVICE_NAME_MAX, 'Device Name')
        .u7(r.sysexId ?? LIMITS.SYSEX_ID_NONE)
        .u7(r.type)
        .str(r.number, LIMITS.NUMBER_MIN, LIMITS.NUMBER_MAX, 'Payload Number')
        .str(r.name || '', LIMITS.NAME_MIN, LIMITS.NAME_MAX, 'Payload Name')
        .tags(r.tags)
        .u21(r.size)
        .u14(r.numBlocks)
        .u32(r.checksum).bytes;
    },

    queryRequest(q) {
      return new Writer()
        .u7(q.deviceMatchMode || 0)
        .identity(q.identity || [0, 0, 0, 0, 0, 0, 0])
        .u7(q.sysexId ?? LIMITS.SYSEX_ID_NONE)
        .u7(q.type ?? LIMITS.TYPE_ANY)
        .str(q.number || '', 0, LIMITS.NUMBER_MAX, 'Payload Number Filter')
        .str(q.name || '', 0, LIMITS.NAME_MAX, 'Payload Name Filter')
        .tags(q.tags, 'Tag Filter')
        .u14(q.startIndex || 0)
        .u7(q.maxResults ?? LIMITS.MAX_RESULTS).bytes;
    },

    queryResult(r) {
      return new Writer()
        .u14(r.totalMatches)
        .u14(r.resultIndex)
        .u21(r.recordId)
        .identity(r.identity)
        .str(r.deviceName || '', 0, LIMITS.DEVICE_NAME_MAX, 'Device Name')
        .u7(r.sysexId ?? LIMITS.SYSEX_ID_NONE)
        .u7(r.type)
        .str(r.number, LIMITS.NUMBER_MIN, LIMITS.NUMBER_MAX, 'Payload Number')
        .str(r.name || '', LIMITS.NAME_MIN, LIMITS.NAME_MAX, 'Payload Name')
        .tags(r.tags)
        .u21(r.size).bytes;
    },

    deleteRequest({ recordId, identity, sysexId }) {
      return new Writer()
        .u21(recordId)
        .identity(identity)
        .u7(sysexId ?? LIMITS.SYSEX_ID_NONE).bytes;
    },
  };

  // ---------- Payload parsers ----------
  // Each parser takes a Reader positioned at the start of the payload. Messages are addressed by
  // the envelope's Destination MUID; only OnlineServer carries the Server Name (for display).

  const parse = {
    serverName(r) { return r.str(LIMITS.SERVER_NAME_MIN, LIMITS.SERVER_NAME_MAX, 'Server Name'); },

    /** Fields added by later versions are appended, so bytes after the known fields are ignored. */
    onlineServer(r) {
      const serverName = parse.serverName(r);
      const n = r.u7('Number of Supported Versions');
      if (n < 1 || n > LIMITS.VERSIONS_MAX) throw new MbspFieldError(`Number of Supported Versions ${n} not in 1-${LIMITS.VERSIONS_MAX}`);
      const versions = Array.from(r.bytes(n, 'Supported Versions'));
      return { serverName, versions, policy: r.u7('Policy Flags'), maxStoreBlockSize: r.u14('Max Store Block Size'), freeSpace: r.u28('Free Space') };
    },

    status(r) {
      const out = { requestType: r.u7('Request Message Type'), status: r.u7('Status Code'), recordId: r.u21('Record ID') };
      r.end(); return out;
    },

    /** Record metadata fields shared by Store_Header, Retrieve_Header and Query_Result. */
    _recordFields(r) {
      const identity = r.identity();
      const deviceName = r.str(0, LIMITS.DEVICE_NAME_MAX, 'Device Name');
      const sysexId = r.u7('Device SysEx ID');
      const type = r.u7('Payload Type');
      const number = r.str(LIMITS.NUMBER_MIN, LIMITS.NUMBER_MAX, 'Payload Number');
      const name = r.str(LIMITS.NAME_MIN, LIMITS.NAME_MAX, 'Payload Name');
      const tags = r.tags();
      return { identity, deviceName, sysexId, type, number, name, tags };
    },

    storeHeader(r) {
      const replaceId = r.u21('Replace Record ID');
      const f = parse._recordFields(r);
      f.replaceId = replaceId;
      f.size = r.u21('Payload Size');
      f.numBlocks = r.u14('NumBlocks');
      f.checksum = r.u32('Full Payload Checksum');
      r.end();
      return f;
    },

    blockAck(r) { const out = { nextBlock: r.u14('Next Block Index') }; r.end(); return out; },

    dataBlock(r) {
      const blockIndex = r.u14('Block Index');
      const size = r.u14('Block Size');
      if (r.remaining !== size) throw new MbspFieldError(`Block Size ${size} does not match ${r.remaining} data byte(s)`);
      return { blockIndex, data: r.bytes(size) };
    },

    retrieveRequest(r) {
      const out = { recordId: r.u21('Record ID'), maxBlockSize: r.u14('Max Block Size') };
      r.end(); return out;
    },

    retrieveHeader(r) {
      const recordId = r.u21('Record ID');
      const f = parse._recordFields(r);
      f.recordId = recordId;
      f.size = r.u21('Payload Size');
      f.numBlocks = r.u14('NumBlocks');
      f.checksum = r.u32('Full Payload Checksum');
      r.end(); return f;
    },

    queryRequest(r) {
      const q = {};
      q.deviceMatchMode = r.u7('Device Match Mode');
      q.identity = r.identity();
      q.sysexId = r.u7('Device SysEx ID Filter');
      q.type = r.u7('Payload Type Filter');
      q.number = r.str(0, LIMITS.NUMBER_MAX, 'Payload Number Filter');
      q.name = r.str(0, LIMITS.NAME_MAX, 'Payload Name Filter');
      q.tags = r.tags('Tag Filter');
      q.startIndex = r.u14('Start Index');
      q.maxResults = r.u7('Max Results');
      r.end();
      if (q.deviceMatchMode > 3) throw new MbspFieldError(`Device Match Mode ${q.deviceMatchMode} not in 0-3`);
      if (q.maxResults < 1) throw new MbspFieldError('Max Results must be 1-127');
      return q;
    },

    queryResult(r) {
      const totalMatches = r.u14('Total Matches');
      const resultIndex = r.u14('Result Index');
      const recordId = r.u21('Record ID');
      const f = parse._recordFields(r);
      Object.assign(f, { totalMatches, resultIndex, recordId, size: r.u21('Payload Size') });
      r.end(); return f;
    },

    deleteRequest(r) {
      const out = { recordId: r.u21('Record ID'), identity: r.identity(), sysexId: r.u7('Device SysEx ID') };
      r.end(); return out;
    },
  };

  // ---------- Matching helpers (shared by the server and the GUI) ----------

  /** Device Match Mode compare: 1 = manufacturer (3 bytes), 2 = + family (5), 3 = + model (7). */
  function identityMatches(mode, want, have) {
    const n = [0, 3, 5, 7][mode];
    for (let i = 0; i < n; i++) if (want[i] !== have[i]) return false;
    return true;
  }

  /** True if a stored record satisfies a parsed MBSP_Query_Request. */
  function recordMatchesQuery(rec, q) {
    if (q.deviceMatchMode && !identityMatches(q.deviceMatchMode, q.identity, rec.identity)) return false;
    if (q.sysexId !== LIMITS.SYSEX_ID_NONE && rec.sysexId !== q.sysexId) return false;
    if (q.type !== LIMITS.TYPE_ANY && rec.type !== q.type) return false;
    if (q.number && rec.number.toLowerCase() !== q.number.toLowerCase()) return false;
    if (q.name && !rec.name.toLowerCase().includes(q.name.toLowerCase())) return false;
    if (q.tags && q.tags.length) {
      const have = new Set(rec.tags.map(t => t.toLowerCase()));
      for (const t of q.tags) if (!have.has(t.toLowerCase())) return false;
    }
    return true;
  }

  // ---------- Formatting helpers ----------
  const hex2 = v => v.toString(16).toUpperCase().padStart(2, '0');
  const hexBytes = (arr, sep = ' ') => Array.from(arr, hex2).join(sep);
  const hexMuid = m => '0x' + m.toString(16).toUpperCase().padStart(7, '0');

  function formatManufacturer(identity) {
    return identity[0] === 0 ? hexBytes(identity.slice(0, 3)) : hex2(identity[0]);
  }
  function formatIdentity(identity) {
    const fam = identity[3] | (identity[4] << 7);
    const mdl = identity[5] | (identity[6] << 7);
    return `${formatManufacturer(identity)} / ${hex2(fam >> 7)}${hex2(fam & 0x7F)} / ${hex2(mdl >> 7)}${hex2(mdl & 0x7F)}`;
  }

  /** A MUID is valid as a device's own MUID unless it is reserved (0FFFFF00-0FFFFFFE) or broadcast. */
  const isValidMuid = m => Number.isInteger(m) && m >= 0 && m < 0x0FFFFF00;

  function randomMuid() {
    let m;
    do { m = Math.floor(Math.random() * 0x10000000); } while (m >= 0x0FFFFF00);
    return m;
  }

  Object.assign(MBSP, {
    SYSEX_START, SYSEX_END, HEADER_PREFIX, PROTOCOL_VERSION, MUID_BROADCAST,
    MSG, MSG_NAME, STATUS, STATUS_NAME, LIMITS, POLICY_FLAG, SUPPORTED_VERSIONS,
    COLLECTION_BIT, CATEGORY_MASK, CATEGORY, CATEGORY_NAME,
    payloadCategory, isCollection, isStorablePayloadType, payloadTypeName,
    MbspFieldError, Writer, Reader,
    isValidMuid, rolandChecksum, crc32, hex8, isPrintableAscii, encodeMessage, decodeMessage,
    build, parse, identityMatches, recordMatchesQuery,
    hex2, hexBytes, hexMuid, formatManufacturer, formatIdentity, randomMuid,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);

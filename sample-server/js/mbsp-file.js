/* mbsp-file.js: the .MBSP database file format (export / import of a whole server database).
 *
 * Binary, little-endian. Strings are a u8 length followed by ASCII bytes.
 *
 *   File header
 *     magic          6 bytes   "MBSPDB"
 *     formatVersion  u16       2 (version 1 files, with a 7-bit payload checksum, are still read)
 *     flags          u16       0 (reserved)
 *     exportedAt     f64       Unix time in milliseconds
 *     nextRecordId   u32       the server's next Record ID counter
 *     recordCount    u32
 *     serverName     str       informational only
 *   Each record
 *     id             u32       Record ID (1 - 0x1FFFFF)
 *     storedAt       f64       Unix time in milliseconds
 *     identity       7 bytes   Device Identity, as received
 *     sysexId        u8        00-7E, 7F = not provided
 *     type           u8        Client Payload Type
 *     crc32          u32       Full Payload Checksum (CRC-32), as received. Version 1: u8, ignored
 *     deviceName     str       0-32
 *     number         str       1-8
 *     name           str       0-32 (optional)
 *     tagCount       u8        0-8, then tagCount x str (1-16)
 *     payloadLength  u32
 *     payload        payloadLength bytes
 *   Trailer
 *     crc32          u32       CRC-32 (IEEE) of every byte before it
 */
(function (root) {
  'use strict';
  const MBSP = root.MBSP = root.MBSP || {};

  const MAGIC = 'MBSPDB';
  const FORMAT_VERSION = 2;

  class MbspFileError extends Error {}

  const crc32 = (bytes, end) => MBSP.crc32(bytes, end); // defined in mbsp-protocol.js

  class ByteWriter {
    constructor() { this.buf = new Uint8Array(1024); this.view = new DataView(this.buf.buffer); this.len = 0; }
    ensure(n) {
      if (this.len + n <= this.buf.length) return;
      let size = this.buf.length * 2;
      while (size < this.len + n) size *= 2;
      const nb = new Uint8Array(size); nb.set(this.buf.subarray(0, this.len));
      this.buf = nb; this.view = new DataView(nb.buffer);
    }
    u8(v) { this.ensure(1); this.buf[this.len++] = v; }
    u16(v) { this.ensure(2); this.view.setUint16(this.len, v, true); this.len += 2; }
    u32(v) { this.ensure(4); this.view.setUint32(this.len, v, true); this.len += 4; }
    f64(v) { this.ensure(8); this.view.setFloat64(this.len, v, true); this.len += 8; }
    bytes(arr) { this.ensure(arr.length); this.buf.set(arr, this.len); this.len += arr.length; }
    str(s) {
      if (s.length > 255) throw new MbspFileError('String too long');
      this.u8(s.length);
      for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i) & 0x7F);
    }
    result() { return this.buf.slice(0, this.len); }
  }

  class ByteReader {
    constructor(bytes, end) { this.b = bytes; this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.p = 0; this.end = end; }
    need(n) { if (this.p + n > this.end) throw new MbspFileError('File is truncated'); }
    u8() { this.need(1); return this.b[this.p++]; }
    u16() { this.need(2); const v = this.view.getUint16(this.p, true); this.p += 2; return v; }
    u32() { this.need(4); const v = this.view.getUint32(this.p, true); this.p += 4; return v; }
    f64() { this.need(8); const v = this.view.getFloat64(this.p, true); this.p += 8; return v; }
    bytes(n) { this.need(n); const v = this.b.slice(this.p, this.p + n); this.p += n; return v; }
    str(min, max, what) {
      const n = this.u8();
      if (n < min || n > max) throw new MbspFileError(`${what} length ${n} not in ${min}-${max}`);
      const raw = this.bytes(n);
      let s = '';
      for (const c of raw) {
        if (c < 0x20 || c > 0x7E) throw new MbspFileError(`${what} contains non-printable characters`);
        s += String.fromCharCode(c);
      }
      return s;
    }
  }

  /**
   * @param {{meta:object, payload:Uint8Array}[]} entries
   * @returns {Uint8Array}
   */
  function encodeDatabaseFile({ serverName, nextRecordId, entries, exportedAt = Date.now() }) {
    const w = new ByteWriter();
    for (const ch of MAGIC) w.u8(ch.charCodeAt(0));
    w.u16(FORMAT_VERSION);
    w.u16(0);
    w.f64(exportedAt);
    w.u32(nextRecordId);
    w.u32(entries.length);
    w.str(serverName || '');
    for (const { meta, payload } of entries) {
      w.u32(meta.id);
      w.f64(meta.storedAt || 0);
      w.bytes(meta.identity);
      w.u8(meta.sysexId);
      w.u8(meta.type);
      w.u32(meta.crc32 ?? crc32(payload));
      w.str(meta.deviceName || '');
      w.str(meta.number);
      w.str(meta.name);
      w.u8(meta.tags.length);
      for (const t of meta.tags) w.str(t);
      w.u32(payload.length);
      w.bytes(payload);
    }
    w.u32(crc32(w.buf, w.len));
    return w.result();
  }

  /** @returns {{serverName, nextRecordId, exportedAt, entries}} */
  function decodeDatabaseFile(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length < 6 + 2 + 2 + 8 + 4 + 4 + 1 + 4) throw new MbspFileError('Not an .MBSP file (too short)');
    for (let i = 0; i < MAGIC.length; i++) {
      if (bytes[i] !== MAGIC.charCodeAt(i)) throw new MbspFileError('Not an .MBSP file (bad signature)');
    }
    const end = bytes.length - 4;
    const stored = new DataView(bytes.buffer, bytes.byteOffset + end, 4).getUint32(0, true);
    if (stored !== crc32(bytes, end)) throw new MbspFileError('File is corrupt (CRC-32 mismatch)');

    const r = new ByteReader(bytes, end);
    r.p = MAGIC.length;
    const version = r.u16();
    if (version !== 1 && version !== FORMAT_VERSION) throw new MbspFileError(`Unsupported .MBSP format version ${version}`);
    r.u16(); // flags
    const exportedAt = r.f64();
    const nextRecordId = r.u32();
    const count = r.u32();
    const serverName = r.str(0, 255, 'Server Name');
    const entries = [];
    const seen = new Set();
    for (let i = 0; i < count; i++) {
      const meta = {};
      meta.id = r.u32();
      if (meta.id < 1 || meta.id > MBSP.MAX_RECORD_ID || seen.has(meta.id)) throw new MbspFileError(`Bad or duplicate Record ID ${meta.id}`);
      seen.add(meta.id);
      meta.storedAt = r.f64();
      meta.identity = Array.from(r.bytes(7));
      meta.sysexId = r.u8();
      meta.type = r.u8();
      if (version === 1) r.u8(); // old 7-bit payload checksum: replaced by a CRC-32 of the payload below
      else meta.crc32 = r.u32();
      if (meta.identity.some(b => b > 0x7F) || meta.sysexId > 0x7F || !MBSP.isStorablePayloadType(meta.type)) {
        throw new MbspFileError(`Record ${meta.id} has out-of-range fields`);
      }
      meta.deviceName = r.str(0, 32, 'Device Name');
      meta.number = r.str(1, 8, 'Payload Number');
      meta.name = r.str(0, 32, 'Payload Name'); // optional
      const tagCount = r.u8();
      if (tagCount > 8) throw new MbspFileError(`Record ${meta.id} has ${tagCount} tags`);
      meta.tags = [];
      for (let t = 0; t < tagCount; t++) meta.tags.push(r.str(1, 16, 'Tag'));
      const len = r.u32();
      if (len > 0x1FFFFF) throw new MbspFileError(`Record ${meta.id} payload is too large`);
      const payload = r.bytes(len);
      meta.size = len;
      if (version === 1) meta.crc32 = crc32(payload);
      else if (meta.crc32 !== crc32(payload)) throw new MbspFileError(`Record ${meta.id} payload does not match its CRC-32`);
      entries.push({ meta, payload });
    }
    if (r.p !== end) throw new MbspFileError('Unexpected data after the last record');
    return { serverName, nextRecordId, exportedAt, entries };
  }

  Object.assign(MBSP, { MbspFileError, encodeDatabaseFile, decodeDatabaseFile, MBSP_FILE_EXTENSION: '.mbsp' });
})(typeof globalThis !== 'undefined' ? globalThis : this);

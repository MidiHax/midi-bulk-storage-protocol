/* mbsp-store.js: record storage for the MBSP sample server.
 *
 * Two stores share one async API:
 *   MemoryStore    - in-memory, used by the self-test and Node tests
 *   IndexedDbStore - the browser database the page uses
 *
 * A record's metadata and its payload are kept apart so listing and querying never
 * load payload bytes.
 *
 * Record metadata:
 *   { id, storedAt, identity: number[7], deviceName, sysexId, type, number, name,
 *     tags: string[], crc32, size }       crc32 = Full Payload Checksum as received
 *   (records saved before the CRC-32 change have no crc32; the server computes it on Retrieve)
 *
 * replace(id, meta, payload) swaps a Record's contents atomically and keeps its ID (Store with Replace Record ID).
 *
 * Record IDs are allocated from a counter that only goes up, so a deleted ID is never
 * reused and a Client holding a stale ID gets Not Found rather than someone else's data.
 */
(function (root) {
  'use strict';
  const MBSP = root.MBSP = root.MBSP || {};
  const MAX_RECORD_ID = 0x1FFFFF;

  class StorageFullError extends Error {}

  function cloneMeta(m) { return { ...m, identity: m.identity.slice(), tags: m.tags.slice() }; }

  class MemoryStore {
    /** capacity: optional payload byte limit (for tests); without it the store is unlimited and reports no Free Space. */
    constructor({ capacity = null } = {}) { this.records = new Map(); this.payloads = new Map(); this.nextId = 1; this.capacity = capacity; }
    _used() { let n = 0; for (const p of this.payloads.values()) n += p.length; return n; }
    _fits(extra) { if (this.capacity !== null && this._used() + extra > this.capacity) throw new StorageFullError('capacity reached'); }
    async open() { return this; }
    async list() { return [...this.records.values()].sort((a, b) => a.id - b.id).map(cloneMeta); }
    async get(id) { const m = this.records.get(id); return m ? cloneMeta(m) : null; }
    async getPayload(id) { const p = this.payloads.get(id); return p ? p.slice() : null; }
    async add(meta, payload) {
      if (this.nextId > MAX_RECORD_ID) throw new StorageFullError('Record IDs exhausted');
      this._fits(payload.length);
      const id = this.nextId++;
      this.records.set(id, cloneMeta({ ...meta, id, size: payload.length }));
      this.payloads.set(id, Uint8Array.from(payload));
      return id;
    }
    async remove(id) { const had = this.records.delete(id); this.payloads.delete(id); return had; }
    /** Replace a Record's metadata and payload, keeping its ID. Returns false if it no longer exists. */
    async replace(id, meta, payload) {
      if (!this.records.has(id)) return false;
      this._fits(payload.length - this.payloads.get(id).length);
      this.records.set(id, cloneMeta({ ...meta, id, size: payload.length }));
      this.payloads.set(id, Uint8Array.from(payload));
      return true;
    }
    /** Delete every Record. The Record ID counter is kept, so IDs are never reused (S-19). */
    async clear() { this.records.clear(); this.payloads.clear(); }
    async getNextId() { return this.nextId; }
    async freeSpace() { return this.capacity === null ? null : Math.max(0, this.capacity - this._used()); }
    /** Replace the whole database, keeping record IDs. */
    async replaceAll(entries, nextId) {
      await this.clear();
      for (const { meta, payload } of entries) {
        this.records.set(meta.id, cloneMeta(meta));
        this.payloads.set(meta.id, Uint8Array.from(payload));
      }
      this.nextId = nextId;
    }
  }

  // ---------- IndexedDB ----------
  const DB_NAME = 'mbsp-sample-server';
  const DB_VERSION = 1;

  function req(r) {
    return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  }
  function done(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
  }
  function isQuota(err) { return err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED'); }

  class IndexedDbStore {
    constructor(name = DB_NAME) { this.name = name; this.db = null; }

    async open() {
      const r = indexedDB.open(this.name, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('payloads')) db.createObjectStore('payloads');
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      this.db = await req(r);
      return this;
    }

    async list() {
      const tx = this.db.transaction('records', 'readonly');
      const all = await req(tx.objectStore('records').getAll()); // key order = ascending id
      return all;
    }
    async get(id) {
      const tx = this.db.transaction('records', 'readonly');
      return (await req(tx.objectStore('records').get(id))) || null;
    }
    async getPayload(id) {
      const tx = this.db.transaction('payloads', 'readonly');
      return (await req(tx.objectStore('payloads').get(id))) || null;
    }
    /** Bytes the browser will still let this origin store, or null if it can't say. */
    async freeSpace() {
      try {
        const nav = typeof navigator !== 'undefined' ? navigator : null;
        if (!nav || !nav.storage || !nav.storage.estimate) return null;
        const { quota, usage } = await nav.storage.estimate();
        return Number.isFinite(quota) && Number.isFinite(usage) ? Math.max(0, quota - usage) : null;
      } catch (_) { return null; }
    }
    async getNextId() {
      const tx = this.db.transaction('meta', 'readonly');
      return (await req(tx.objectStore('meta').get('nextId'))) || 1;
    }

    /** Allocate an ID and write metadata + payload in one IndexedDB transaction. */
    add(meta, payload) {
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(['records', 'payloads', 'meta'], 'readwrite');
        let id = 0;
        let failure = null;
        tx.oncomplete = () => resolve(id);
        tx.onabort = tx.onerror = () => {
          const err = failure || tx.error;
          reject(isQuota(err) ? new StorageFullError(err.message) : err);
        };
        const metaStore = tx.objectStore('meta');
        metaStore.get('nextId').onsuccess = (e) => {
          id = e.target.result || 1;
          if (id > MAX_RECORD_ID) { failure = new StorageFullError('Record IDs exhausted'); tx.abort(); return; }
          metaStore.put(id + 1, 'nextId');
          tx.objectStore('records').put({ ...meta, id, size: payload.length });
          tx.objectStore('payloads').put(Uint8Array.from(payload), id);
        };
      });
    }

    /** Replace a Record's metadata and payload in one IndexedDB transaction, keeping its ID. */
    replace(id, meta, payload) {
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(['records', 'payloads'], 'readwrite');
        let found = false;
        tx.oncomplete = () => resolve(found);
        tx.onabort = tx.onerror = () => reject(isQuota(tx.error) ? new StorageFullError(tx.error.message) : tx.error);
        tx.objectStore('records').get(id).onsuccess = (e) => {
          if (!e.target.result) return; // gone: nothing to replace
          found = true;
          tx.objectStore('records').put({ ...meta, id, size: payload.length });
          tx.objectStore('payloads').put(Uint8Array.from(payload), id);
        };
      });
    }

    async remove(id) {
      const tx = this.db.transaction(['records', 'payloads'], 'readwrite');
      const existing = await req(tx.objectStore('records').get(id));
      if (existing) {
        tx.objectStore('records').delete(id);
        tx.objectStore('payloads').delete(id);
      }
      await done(tx);
      return !!existing;
    }

    async clear() {
      const tx = this.db.transaction(['records', 'payloads', 'meta'], 'readwrite');
      tx.objectStore('records').clear();
      tx.objectStore('payloads').clear(); // the Record ID counter in 'meta' is kept: IDs are never reused (S-19)
      await done(tx);
    }

    async replaceAll(entries, nextId) {
      const tx = this.db.transaction(['records', 'payloads', 'meta'], 'readwrite');
      const recs = tx.objectStore('records');
      const pays = tx.objectStore('payloads');
      recs.clear(); pays.clear();
      for (const { meta, payload } of entries) {
        recs.put(meta);
        pays.put(Uint8Array.from(payload), meta.id);
      }
      tx.objectStore('meta').put(nextId, 'nextId');
      try { await done(tx); } catch (err) { throw isQuota(err) ? new StorageFullError(err.message) : err; }
    }
  }

  /** Read every record with its payload, for export. */
  async function readAll(store) {
    const metas = await store.list();
    const out = [];
    for (const meta of metas) out.push({ meta, payload: (await store.getPayload(meta.id)) || new Uint8Array(0) });
    return out;
  }

  /**
   * Import entries into a store.
   *  mode 'replace': the database becomes exactly the file's contents, record IDs kept.
   *  mode 'merge':   every imported record is added as a new record with a new ID, so IDs
   *                  that Clients already hold never change meaning.
   */
  async function importEntries(store, entries, fileNextId, mode) {
    if (mode === 'replace') {
      const maxId = entries.reduce((m, e) => Math.max(m, e.meta.id), 0);
      // Never go back below this store's own counter: IDs it already handed out are not reused.
      const ownNext = (await store.getNextId()) || 1;
      await store.replaceAll(entries, Math.max(fileNextId || 1, maxId + 1, ownNext));
      return entries.length;
    }
    let n = 0;
    for (const { meta, payload } of entries) {
      const { id, ...rest } = meta; // eslint-disable-line no-unused-vars
      await store.add(rest, payload);
      n++;
    }
    return n;
  }

  Object.assign(MBSP, { MemoryStore, IndexedDbStore, StorageFullError, MAX_RECORD_ID, readAll, importEntries });
})(typeof globalThis !== 'undefined' ? globalThis : this);

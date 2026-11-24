/* mbsp-server.js: the MBSP v1 server engine.
 *
 * Transport- and storage-agnostic: feed it complete SysEx messages with handleMessage(),
 * and it calls send(bytes) with its replies. The page wires that to Web MIDI; the self-test
 * wires it to an in-memory loopback.
 *
 * Behaviour that the spec leaves to the implementation (see README.md):
 *  - The server has its own random MUID, drawn at start-up (power-up). Messages whose Destination
 *    MUID is not ours are ignored; DiscoverServers is accepted when sent to the broadcast MUID.
 *  - A message whose Source MUID is ours, and which is not an echo of something we sent, means another
 *    device has the same MUID: we abandon open transfers, draw a new MUID and announce it.
 *  - Server-to-Client messages (types 1, 2, 12, 21, 22, 31), unknown Message Types, Retrieve acks
 *    for no open Retrieve and non-v1 headers are ignored silently. DiscoverServers is answered
 *    whatever its Protocol Version.
 *  - The final Status of every Store is remembered for completedStoreMs. A Store_Data_Block for a
 *    remembered Store (the Client resent its last block because the Status was lost) gets that same
 *    Status again; one for no open or remembered Store gets Status 9 (Unknown Transaction).
 *  - A Store_Header with a Replace Record ID follows the Delete rules (Delete allowed, owner check) and
 *    swaps the Record's contents only after the whole payload has arrived and passed its CRC-32.
 *    A Retrieve already in progress keeps sending the old payload (it holds its own copy).
 *  - A payload that fails validation gets Status 8 (Invalid Request).
 *  - Replies carry an empty Access Key.
 *  - Client discovery (optional in the spec): discoverClients() broadcasts MBSP_DiscoverClients, and every
 *    MBSP_OnlineClient (a reply, or a broadcast announcement) updates an advisory device list, keyed by
 *    Client MUID. A rediscovery drops devices that no longer answer. An announcement from a new MUID with the
 *    Device Identity and SysEx ID of a listed device (one that has a SysEx ID) replaces the old entry.
 *    The list is used only for display and for Offers, never for ownership.
 *  - Offers (optional in the spec) are sent by offer(), from the GUI. Each gets its own Transaction ID
 *    from a server counter. Replies are collected for offerReplyWaitMs; a Client that accepted may
 *    Retrieve the offered Record without the Access Key for offerLifetimeMs. Nothing is resent.
 */
(function (root) {
  'use strict';
  const MBSP = root.MBSP = root.MBSP || {};
  const { MSG, MSG_NAME, STATUS, STATUS_NAME, OFFER_RESPONSE, OFFER_RESPONSE_NAME, LIMITS, Reader, MbspFieldError, build, parse, encodeMessage, decodeMessage } = MBSP;

  const DEFAULT_SETTINGS = {
    serverName: 'WebMBSP',
    accessKey: '',              // when set, requests must carry this Access Key or get Refused
    readOnly: false,            // refuse Store and Delete
    allowDelete: true,          // refuse Delete only
    enforceOwnerOnDelete: true, // Delete must come from the Device Identity + SysEx ID that stored the record
    allowFirmware: false,       // accept Stores of Category 0E (Firmware / OS); refused by default
    blockSize: 256,             // default and maximum Retrieve block size (bytes)
    maxStoreBlockSize: 16383,   // largest Store block accepted, announced in OnlineServer (256-16383)
    blockDelayMs: 20,           // pause between outgoing Query_Result messages (they are not acknowledged)
    transactionTimeoutMs: 5000, // Store gives up when no Data Block arrives for this long
    completedStoreMs: 10000,    // how long the final Status of a finished Store is remembered and repeated
    maxCompletedStores: 64,     // the oldest remembered Store is forgotten beyond this
    ackTimeoutMs: 1000,         // Retrieve: resend the last header/block when no Block Ack arrives for this long
    maxRetries: 3,              // Retrieve: resends before giving up
    maxConcurrentStores: 8,
    maxConcurrentRetrieves: 4,
    beaconEnabled: false,
    beaconIntervalMs: 10000,
    offerReplyWaitMs: 2000,     // Offer: how long to wait for the first Offer_Reply
    offerLifetimeMs: 60000,
    clientDiscoveryWaitMs: 1000, // DiscoverClients: how long to collect OnlineClient replies     // Offer: how long a Pending answer may take, and a keyless Retrieve is allowed
  };

  const SERVER_TO_CLIENT = new Set([MSG.ONLINE_SERVER, MSG.STATUS, MSG.STORE_BLOCK_ACK, MSG.RETRIEVE_HEADER, MSG.RETRIEVE_DATA_BLOCK, MSG.QUERY_RESULT, MSG.OFFER, MSG.DISCOVER_CLIENTS]);
  const QUIET_TX = new Set([MSG.RETRIEVE_DATA_BLOCK, MSG.STORE_BLOCK_ACK]); // logged at debug level

  const { hexMuid } = MBSP;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /** A default name that is unlikely to clash with another unit's: "WebMBSP-" + 4 hex digits. */
  function uniqueServerName(prefix = 'WebMBSP') {
    return `${prefix}-${Math.floor(Math.random() * 0x10000).toString(16).toUpperCase().padStart(4, '0')}`;
  }

  function validateServerName(name) {
    return typeof name === 'string' && name.length >= LIMITS.SERVER_NAME_MIN && name.length <= LIMITS.SERVER_NAME_MAX && MBSP.isPrintableAscii(name);
  }

  class MbspServer {
    /**
     * @param {object} opts
     * @param {object} opts.store     MemoryStore or IndexedDbStore (opened)
     * @param {(bytes:Uint8Array)=>void} opts.send
     * @param {object} [opts.settings]
     */
    constructor({ store, send, settings = {}, muid = null }) {
      this.store = store;
      this.send = send;
      this.muid = muid ?? MBSP.randomMuid(); // a new MUID at every start-up
      this.recentTx = [];                     // [{ key, at }] of recently sent messages, to recognise echoes
      this.onMuidChanged = null;              // (muid) after a collision forced a new MUID
      this.settings = { ...DEFAULT_SETTINGS };
      this.applySettings(settings);
      this.stores = new Map();     // key "muid:tid" -> in-progress Store transaction
      this.retrieves = new Map();  // key -> outgoing Retrieve
      this.completed = new Map();  // key -> { status, recordId, expires }: finished Stores, oldest first
      this.offers = new Map();     // Transaction ID -> Offer we sent (see offer())
      this.serverTid = 0;          // Transaction IDs of messages we initiate (DiscoverClients, Offer)
      this.clients = new Map();    // Client MUID -> { muid, identity, sysexId, deviceName, capabilities, lastSeen }
      this.clientDiscovery = null; // { tid, answered, timer } while a DiscoverClients is collecting replies
      this.beaconTimer = null;
      this.stats = { rx: 0, tx: 0, ignored: 0, stored: 0, retrieved: 0, queried: 0, deleted: 0, errors: 0 };
      // Event hooks, set by the UI
      this.onLog = null;            // ({level, text, bytes})
      this.onRecordsChanged = null; // ()
      this.onTransfersChanged = null; // (transfers[])
      this.onOffersChanged = null;    // (offers[])
      this.onClientsChanged = null;   // (clients[])
      this._updateBeacon();
    }

    applySettings(patch) {
      const next = { ...this.settings, ...patch };
      if (!validateServerName(next.serverName)) throw new Error('Server Name must be 4-16 printable ASCII characters');
      if (next.accessKey.length > 16 || !MBSP.isPrintableAscii(next.accessKey)) throw new Error('Access Key must be 0-16 printable ASCII characters');
      next.blockSize = Math.max(1, Math.min(LIMITS.U14_MAX, Math.floor(next.blockSize) || DEFAULT_SETTINGS.blockSize));
      next.maxStoreBlockSize = Math.max(LIMITS.STORE_BLOCK_MIN, Math.min(LIMITS.U14_MAX, Math.floor(next.maxStoreBlockSize) || DEFAULT_SETTINGS.maxStoreBlockSize));
      next.blockDelayMs = Math.max(0, Math.floor(next.blockDelayMs) || 0);
      next.completedStoreMs = Math.max(0, Math.floor(next.completedStoreMs ?? DEFAULT_SETTINGS.completedStoreMs));
      next.maxCompletedStores = Math.max(1, Math.floor(next.maxCompletedStores) || DEFAULT_SETTINGS.maxCompletedStores);
      next.transactionTimeoutMs = Math.max(100, Math.floor(next.transactionTimeoutMs) || DEFAULT_SETTINGS.transactionTimeoutMs);
      next.ackTimeoutMs = Math.max(20, Math.floor(next.ackTimeoutMs) || DEFAULT_SETTINGS.ackTimeoutMs);
      next.maxRetries = Math.max(0, Math.floor(next.maxRetries ?? DEFAULT_SETTINGS.maxRetries));
      next.beaconIntervalMs = Math.max(1000, Math.floor(next.beaconIntervalMs) || DEFAULT_SETTINGS.beaconIntervalMs);
      this.settings = next;
      if (this.beaconTimer !== undefined) this._updateBeacon();
    }

    /** Stop timers and abandon transfers (page unload, tests). */
    shutdown() {
      for (const tx of this.stores.values()) clearTimeout(tx.timer);
      this.stores.clear();
      for (const r of this.retrieves.values()) clearTimeout(r.timer);
      this.retrieves.clear();
      this.completed.clear();
      this._clearOffers();
      if (this.clientDiscovery) clearTimeout(this.clientDiscovery.timer);
      this.clientDiscovery = null;
      clearInterval(this.beaconTimer);
      this.beaconTimer = null;
      this._transfersChanged();
    }

    // ---------- Logging / events ----------
    _log(level, text, bytes) { if (this.onLog) this.onLog({ level, text, bytes }); }
    _transfersChanged() {
      if (!this.onTransfersChanged) return;
      const list = [];
      for (const t of this.stores.values()) list.push({ kind: 'store', name: t.header.name, number: t.header.number, done: t.nextBlock, total: t.header.numBlocks, muid: t.muid });
      for (const t of this.retrieves.values()) list.push({ kind: 'retrieve', name: t.name, number: t.number, done: t.sent, total: t.total, muid: t.muid });
      this.onTransfersChanged(list);
    }
    _recordsChanged() { if (this.onRecordsChanged) this.onRecordsChanged(); }

    // ---------- Sending ----------
    _reply(req, type, payload, text) {
      const bytes = encodeMessage({ type, src: this.muid, dst: req.muid, tid: req.tid, payload });
      this._rememberTx(bytes);
      this.stats.tx++;
      this._log(QUIET_TX.has(type) ? 'debug' : 'tx', `TX ${MSG_NAME[type]} -> MUID ${hexMuid(req.muid)} TID ${req.tid}${text ? ': ' + text : ''}`, bytes);
      this.send(bytes);
    }

    _status(req, requestType, status, recordId = 0) {
      if (status !== STATUS.OK) this.stats.errors++;
      // The final Status of an opened Store: remember it, so a resent last block can get it again.
      // Every outcome of a Store that replaces a Record carries the Replace Record ID.
      if (requestType === MSG.STORE_HEADER && !recordId && req.header && req.header.replaceId) recordId = req.header.replaceId;
      if (requestType === MSG.STORE_HEADER && req.key) this._rememberStore(req.key, status, recordId);
      this._reply(req, MSG.STATUS, build.status({ requestType, status, recordId }),
        `${MSG_NAME[requestType] || requestType} ${STATUS_NAME[status]}${recordId ? ' record ' + recordId : ''}`);
    }

    // ---------- MUID collisions ----------

    /** Keep the last few seconds of sent messages, so a MIDI loop echoing them back is not mistaken for a collision. */
    _rememberTx(bytes) {
      const now = Date.now();
      this.recentTx.push({ key: `${bytes.length}:${MBSP.crc32(bytes)}`, at: now });
      while (this.recentTx.length && (this.recentTx.length > 256 || now - this.recentTx[0].at > 3000)) this.recentTx.shift();
    }
    _isEcho(bytes) {
      const key = `${bytes.length}:${MBSP.crc32(bytes)}`, now = Date.now();
      return this.recentTx.some(t => t.key === key && now - t.at <= 3000);
    }

    /** Another device is using our MUID: abandon transfers, draw a new MUID and announce it. */
    async _muidCollision(data) {
      const old = this.muid;
      do { this.muid = MBSP.randomMuid(); } while (this.muid === old);
      for (const tx of this.stores.values()) clearTimeout(tx.timer);
      for (const r of this.retrieves.values()) clearTimeout(r.timer);
      this.stores.clear(); this.retrieves.clear(); this.completed.clear();
      this._clearOffers();
      this._transfersChanged();
      this._log('warn', `Another device is using this server's MUID ${hexMuid(old)}. Open transfers were abandoned; the new MUID is ${hexMuid(this.muid)}.`, data);
      if (this.onMuidChanged) this.onMuidChanged(this.muid);
      await this.announce();
    }

    // ---------- Beacon ----------
    _updateBeacon() {
      clearInterval(this.beaconTimer);
      this.beaconTimer = null;
      if (this.settings.beaconEnabled) {
        this.beaconTimer = setInterval(() => this.announce(), this.settings.beaconIntervalMs);
      }
    }

    /** Policy Flags for OnlineServer, from the current settings. */
    policyFlags() {
      const s = this.settings, F = MBSP.POLICY_FLAG;
      return (s.readOnly ? F.STORE_REFUSED : 0) | (s.readOnly || !s.allowDelete ? F.DELETE_REFUSED : 0) |
        (s.enforceOwnerOnDelete ? F.OWNER_DELETE : 0) | (s.allowFirmware ? F.FIRMWARE : 0) | (s.accessKey ? F.ACCESS_KEY : 0);
    }

    /** MBSP_OnlineServer payload: name, supported versions, policies and limits. */
    async _onlinePayload() {
      let free = null;
      try { free = this.store.freeSpace ? await this.store.freeSpace() : null; } catch (_) { free = null; }
      return build.onlineServer({
        serverName: this.settings.serverName, versions: MBSP.SUPPORTED_VERSIONS, policy: this.policyFlags(),
        maxStoreBlockSize: this.settings.maxStoreBlockSize, freeSpace: free === null ? LIMITS.FREE_SPACE_UNKNOWN : free,
      });
    }

    /** Broadcast MBSP_OnlineServer (Beacon Mode, or the "Announce" button). */
    async announce() {
      this._reply({ muid: MBSP.MUID_BROADCAST, tid: 0 }, MSG.ONLINE_SERVER, await this._onlinePayload(), 'beacon');
    }

    // ---------- Receiving ----------

    /**
     * Handle one complete SysEx message. Resolves when the server has finished acting on it
     * (including any Retrieve / Query replies), which makes tests deterministic.
     */
    async handleMessage(data) {
      const msg = decodeMessage(data);
      if (!msg) {
        const b = data;
        if (b && b.length > 5 && b[0] === 0xF0 && b[1] === 0x7E && b[3] === 0x6A && b[4] === 0x00) {
          this.stats.ignored++;
          this._log('warn', 'Ignored malformed MBSP message (bad header, byte or checksum)', data);
        }
        return;
      }
      msg.muid = msg.src; // the Client's MUID: replies go to it, and transactions are keyed on it
      // Another device sending with our MUID as its Source (and not an echo of our own message): a collision.
      if (msg.src === this.muid && !this._isEcho(data)) return this._muidCollision(data);
      // DiscoverServers is answered whatever its version, so a Client can learn which versions we support.
      if (msg.version !== MBSP.PROTOCOL_VERSION && msg.type !== MSG.DISCOVER_SERVERS) {
        this.stats.ignored++;
        this._log('warn', `Ignored MBSP message with protocol version ${msg.version}`, data);
        return;
      }
      if (SERVER_TO_CLIENT.has(msg.type)) {
        this.stats.ignored++;
        this._log('debug', `Ignored ${MSG_NAME[msg.type]} (server-to-client message)`, data);
        return;
      }
      // Addressing: our MUID, or broadcast for DiscoverServers only.
      const forUs = msg.dst === this.muid || (msg.dst === MBSP.MUID_BROADCAST && (msg.type === MSG.DISCOVER_SERVERS || msg.type === MSG.ONLINE_CLIENT));
      if (!forUs) {
        this.stats.ignored++;
        this._log('debug', `Ignored ${MSG_NAME[msg.type] || 'type ' + msg.type} for MUID ${hexMuid(msg.dst)}`, data);
        return;
      }
      this.stats.rx++;
      try {
        switch (msg.type) {
          case MSG.DISCOVER_SERVERS: return await this._onDiscover(msg, data);
          case MSG.STORE_HEADER: return await this._onStoreHeader(msg, data);
          case MSG.STORE_DATA_BLOCK: return await this._onStoreBlock(msg, data);
          case MSG.RETRIEVE_REQUEST: return await this._onRetrieve(msg, data);
          case MSG.RETRIEVE_BLOCK_ACK: return this._onRetrieveAck(msg, data);
          case MSG.QUERY_REQUEST: return await this._onQuery(msg, data);
          case MSG.DELETE_REQUEST: return await this._onDelete(msg, data);
          case MSG.OFFER_REPLY: return this._onOfferReply(msg, data);
          case MSG.ONLINE_CLIENT: return this._onOnlineClient(msg, data);
          default:
            // Unknown types are ignored silently: they can't be addressed to one server, so a reply
            // would come from every server on the network.
            this.stats.rx--; this.stats.ignored++;
            this._log('warn', `Ignored unknown Message Type ${msg.type} from MUID ${hexMuid(msg.muid)}`, data);
            return;
        }
      } catch (err) {
        this.stats.errors++;
        this._log('error', `Internal error handling ${MSG_NAME[msg.type] || msg.type}: ${err && err.message}`);
        const requestType = msg.type === MSG.STORE_DATA_BLOCK ? MSG.STORE_HEADER
          : msg.type === MSG.RETRIEVE_BLOCK_ACK ? MSG.RETRIEVE_REQUEST : msg.type;
        return this._status(msg, requestType, STATUS.BUSY);
      }
    }

    /** A Reader over the payload of a message already known to be addressed to us. */
    _addressed(msg) { return new Reader(msg.payload); }

    _keyOk(msg) { return !this.settings.accessKey || msg.accessKey === this.settings.accessKey; }

    async _onDiscover(msg, data) {
      this._log('rx', `RX DISCOVER_SERVERS (v${msg.version}) from MUID ${hexMuid(msg.muid)} TID ${msg.tid}`, data);
      this._reply(msg, MSG.ONLINE_SERVER, await this._onlinePayload());
    }

    /** True if the requester (Device Identity + SysEx ID) is the Record's Owner. */
    _isOwner(meta, identity, sysexId) {
      return MBSP.identityMatches(3, identity, meta.identity) && sysexId === meta.sysexId;
    }

    // ----- Store -----
    async _onStoreHeader(msg, data) {
      const r = this._addressed(msg, data);
      if (!r) return;
      let h;
      try {
        h = parse.storeHeader(r);
        if (!MBSP.isStorablePayloadType(h.type)) {
          throw new MbspFieldError(`Payload Type ${MBSP.hex2(h.type)} is not valid in a Store (7F and Category 3F are reserved)`);
        }
        if (h.numBlocks < 1) throw new MbspFieldError('NumBlocks must be at least 1');
        if (h.size > h.numBlocks * this.settings.maxStoreBlockSize) {
          throw new MbspFieldError(`Payload Size ${h.size} does not fit in ${h.numBlocks} block(s) of at most ${this.settings.maxStoreBlockSize} bytes`);
        }
      } catch (err) {
        if (!(err instanceof MbspFieldError)) throw err;
        this._log('warn', `RX STORE_HEADER invalid: ${err.message}`, data);
        return this._status(msg, MSG.STORE_HEADER, STATUS.INVALID_REQUEST);
      }
      this._log('rx', `RX STORE_HEADER from MUID ${hexMuid(msg.muid)} TID ${msg.tid}: ${h.number} "${h.name}"` +
        `${h.deviceName ? ' (' + h.deviceName + ')' : ''}, ${h.size} byte(s) in ${h.numBlocks} block(s)${h.replaceId ? ', replacing record ' + h.replaceId : ''}`, data);
      if (!this._keyOk(msg)) return this._status(msg, MSG.STORE_HEADER, STATUS.REFUSED, h.replaceId);
      if (this.settings.readOnly) return this._status(msg, MSG.STORE_HEADER, STATUS.REFUSED, h.replaceId);
      if (MBSP.payloadCategory(h.type) === MBSP.CATEGORY.FIRMWARE && !this.settings.allowFirmware) {
        this._log('warn', `Store of firmware "${h.name}" refused (accepting firmware is switched off)`);
        return this._status(msg, MSG.STORE_HEADER, STATUS.REFUSED, h.replaceId);
      }
      if (h.replaceId) {
        // Replace follows the Delete rules: it removes what the Record held.
        if (!this.settings.allowDelete) return this._status(msg, MSG.STORE_HEADER, STATUS.REFUSED, h.replaceId);
        const old = await this.store.get(h.replaceId);
        if (!old) return this._status(msg, MSG.STORE_HEADER, STATUS.NOT_FOUND, h.replaceId);
        if (this.settings.enforceOwnerOnDelete && !this._isOwner(old, h.identity, h.sysexId)) {
          this._log('warn', `Replace of record ${h.replaceId} refused: requester is not the device that stored it`);
          return this._status(msg, MSG.STORE_HEADER, STATUS.REFUSED, h.replaceId);
        }
      }

      // Payload Size lets us refuse a Store that cannot fit before any Block is sent.
      let free = null;
      try { free = this.store.freeSpace ? await this.store.freeSpace() : null; } catch (_) { free = null; }
      const old = h.replaceId ? await this.store.get(h.replaceId) : null;
      if (free !== null && h.size - (old ? old.size || 0 : 0) > free) {
        this._log('warn', `Store of ${h.size} byte(s) refused up front: ${free} byte(s) free`);
        return this._status(msg, MSG.STORE_HEADER, STATUS.STORAGE_FULL, h.replaceId);
      }

      const key = `${msg.muid}:${msg.tid}`;
      this.completed.delete(key); // a new Store with this MUID + TID replaces any remembered one
      const previous = this.stores.get(key);
      if (previous) {
        clearTimeout(previous.timer);
        this.stores.delete(key);
        // A header resent because our first ack was lost is normal; a restart mid-transfer is worth a warning.
        this._log(previous.nextBlock ? 'warn' : 'debug', `Store TID ${msg.tid} restarted by a repeated header` +
          (previous.nextBlock ? `, ${previous.nextBlock} earlier block(s) discarded` : ''));
      }
      if (this.stores.size >= this.settings.maxConcurrentStores) return this._status(msg, MSG.STORE_HEADER, STATUS.BUSY, h.replaceId);

      const tx = { key, muid: msg.muid, tid: msg.tid, header: h, nextBlock: 0, chunks: [], size: 0, timer: null };
      this.stores.set(key, tx);
      this._armTimeout(tx);
      this._transfersChanged();
      this._ackStore(tx); // "ready for block 0"
    }

    _rememberStore(key, status, recordId) {
      if (!this.settings.completedStoreMs) return;
      this.completed.delete(key);
      this.completed.set(key, { status, recordId, expires: Date.now() + this.settings.completedStoreMs });
      while (this.completed.size > this.settings.maxCompletedStores) this.completed.delete(this.completed.keys().next().value);
    }

    /** The remembered final Status of a finished Store, or null. Drops expired entries. */
    _completedStore(key) {
      const now = Date.now();
      for (const [k, c] of this.completed) { if (c.expires > now) break; this.completed.delete(k); }
      return this.completed.get(key) || null;
    }

    /** MBSP_Store_Block_Ack: everything before tx.nextBlock has arrived, send tx.nextBlock. */
    _ackStore(tx) {
      this._reply(tx, MSG.STORE_BLOCK_ACK, build.blockAck({ nextBlock: tx.nextBlock }), `next block ${tx.nextBlock}`);
    }

    _armTimeout(tx) {
      clearTimeout(tx.timer);
      tx.timer = setTimeout(() => {
        if (this.stores.get(tx.key) !== tx) return;
        this.stores.delete(tx.key);
        this._log('warn', `Store TID ${tx.tid} timed out after block ${tx.nextBlock} of ${tx.header.numBlocks}`);
        this._status(tx, MSG.STORE_HEADER, STATUS.TRANSACTION_TIMEOUT);
        this._transfersChanged();
      }, this.settings.transactionTimeoutMs);
    }

    _abortStore(tx, status, why) {
      clearTimeout(tx.timer);
      this.stores.delete(tx.key);
      this._log('warn', `Store TID ${tx.tid} failed: ${why}`);
      this._status(tx, MSG.STORE_HEADER, status);
      this._transfersChanged();
    }

    async _onStoreBlock(msg, data) {
      const r = this._addressed(msg, data);
      if (!r) return;
      const tx = this.stores.get(`${msg.muid}:${msg.tid}`);
      if (!tx) {
        const done = this._completedStore(`${msg.muid}:${msg.tid}`);
        if (done) {
          // The Client resent a block of a finished Store: its final Status was lost. Repeat it.
          this._log('debug', `Store TID ${msg.tid}: block after the Store ended, repeating its final Status`, data);
          if (done.status !== STATUS.OK) this.stats.errors--; // already counted when first sent
          return this._status(msg, MSG.STORE_HEADER, done.status, done.recordId);
        }
        // Addressed to us, but no Store is open or remembered: it ended too long ago, this
        // server restarted, or it never existed.
        this._log('warn', `RX STORE_DATA_BLOCK for no open Store (MUID ${hexMuid(msg.muid)} TID ${msg.tid})`, data);
        return this._status(msg, MSG.STORE_HEADER, STATUS.UNKNOWN_TRANSACTION);
      }
      let blk;
      try { blk = parse.dataBlock(r); } catch (err) {
        if (!(err instanceof MbspFieldError)) throw err;
        return this._abortStore(tx, STATUS.INVALID_REQUEST, err.message);
      }
      if (blk.data.length > this.settings.maxStoreBlockSize) {
        return this._abortStore(tx, STATUS.INVALID_REQUEST, `block of ${blk.data.length} bytes exceeds Max Store Block Size ${this.settings.maxStoreBlockSize}`);
      }
      this._log('debug', `RX STORE_DATA_BLOCK TID ${msg.tid} block ${blk.blockIndex}, ${blk.data.length} byte(s)`, data);
      if (blk.blockIndex === tx.nextBlock - 1) {
        // The Client resent the block we already accepted (our ack was lost): repeat the ack.
        this._armTimeout(tx);
        this._log('debug', `Store TID ${msg.tid}: block ${blk.blockIndex} repeated, re-sending ack`);
        return this._ackStore(tx);
      }
      if (blk.blockIndex !== tx.nextBlock) {
        return this._abortStore(tx, STATUS.BLOCK_SEQUENCE_ERROR, `expected block ${tx.nextBlock}, got ${blk.blockIndex}`);
      }
      if (tx.size + blk.data.length > tx.header.size) {
        return this._abortStore(tx, STATUS.INVALID_REQUEST, `blocks exceed the declared Payload Size of ${tx.header.size} bytes`);
      }
      tx.chunks.push(blk.data);
      tx.size += blk.data.length;
      tx.nextBlock++;

      if (tx.nextBlock < tx.header.numBlocks) {
        this._armTimeout(tx);
        this._transfersChanged();
        return this._ackStore(tx);
      }
      // The last block is answered by the final Status instead of an ack.

      // Last block: verify and write.
      clearTimeout(tx.timer);
      this.stores.delete(tx.key);
      this._transfersChanged();
      if (tx.size !== tx.header.size) {
        this._log('warn', `Store TID ${tx.tid}: received ${tx.size} byte(s), header declared ${tx.header.size}`);
        return this._status(tx, MSG.STORE_HEADER, STATUS.INVALID_REQUEST, tx.header.replaceId);
      }
      const payload = new Uint8Array(tx.size);
      let off = 0;
      for (const c of tx.chunks) { payload.set(c, off); off += c.length; }
      const sum = MBSP.crc32(payload);
      if (sum !== tx.header.checksum) {
        this._log('warn', `Store TID ${tx.tid}: payload CRC-32 ${MBSP.hex8(sum)} does not match header ${MBSP.hex8(tx.header.checksum)}`);
        return this._status(tx, MSG.STORE_HEADER, STATUS.PAYLOAD_CHECKSUM_ERROR);
      }
      const h = tx.header;
      const meta = {
        storedAt: Date.now(), identity: h.identity, deviceName: h.deviceName, sysexId: h.sysexId,
        type: h.type, number: h.number, name: h.name, tags: h.tags, crc32: h.checksum,
      };
      let id;
      try {
        if (h.replaceId) {
          // Commit the replacement only now that the whole payload has arrived and checked out.
          if (!await this.store.replace(h.replaceId, meta, payload)) {
            this._log('warn', `Store TID ${tx.tid}: record ${h.replaceId} was deleted before the replacement arrived`);
            return this._status(tx, MSG.STORE_HEADER, STATUS.NOT_FOUND, h.replaceId);
          }
          id = h.replaceId;
        } else {
          id = await this.store.add(meta, payload);
        }
      } catch (err) {
        if (err instanceof MBSP.StorageFullError) {
          this._log('error', `Store TID ${tx.tid}: storage full (${err.message})`);
          return this._status(tx, MSG.STORE_HEADER, STATUS.STORAGE_FULL);
        }
        throw err;
      }
      this.stats.stored++;
      this._log('info', `${h.replaceId ? 'Replaced' : 'Stored'} record ${id}: ${h.number} "${h.name}", ${payload.length} byte(s)`);
      this._status(tx, MSG.STORE_HEADER, STATUS.OK, id);
      this._recordsChanged();
    }

    // ----- Retrieve -----
    async _onRetrieve(msg, data) {
      const r = this._addressed(msg, data);
      if (!r) return;
      let q;
      try { q = parse.retrieveRequest(r); } catch (err) {
        if (!(err instanceof MbspFieldError)) throw err;
        this._log('warn', `RX RETRIEVE_REQUEST invalid: ${err.message}`, data);
        return this._status(msg, MSG.RETRIEVE_REQUEST, STATUS.INVALID_REQUEST);
      }
      this._log('rx', `RX RETRIEVE_REQUEST from MUID ${hexMuid(msg.muid)} TID ${msg.tid}: record ${q.recordId}, max block ${q.maxBlockSize || 'default'}`, data);
      // A Client that accepted our Offer of this Record may Retrieve it without the Access Key.
      if (!this._keyOk(msg) && !this._offerAccepted(msg.muid, q.recordId)) return this._status(msg, MSG.RETRIEVE_REQUEST, STATUS.REFUSED, q.recordId);

      const meta = q.recordId ? await this.store.get(q.recordId) : null;
      if (!meta) return this._status(msg, MSG.RETRIEVE_REQUEST, STATUS.NOT_FOUND, q.recordId);
      const payload = (await this.store.getPayload(q.recordId)) || new Uint8Array(0);

      const blockSize = q.maxBlockSize ? Math.min(q.maxBlockSize, this.settings.blockSize) : this.settings.blockSize;
      const total = Math.max(1, Math.ceil(payload.length / blockSize));
      if (total > LIMITS.U14_MAX) {
        this._log('warn', `Retrieve record ${q.recordId}: block size ${blockSize} would need ${total} blocks`);
        return this._status(msg, MSG.RETRIEVE_REQUEST, STATUS.INVALID_REQUEST, q.recordId);
      }
      const key = `${msg.muid}:${msg.tid}`;
      if (this.retrieves.has(key)) {
        this._log('debug', `Ignored repeated RETRIEVE_REQUEST TID ${msg.tid} (transfer already in progress)`, data);
        return;
      }
      if (this.retrieves.size >= this.settings.maxConcurrentRetrieves) {
        return this._status(msg, MSG.RETRIEVE_REQUEST, STATUS.BUSY, q.recordId);
      }

      // Flow control: send the header, then each block only when the Client's
      // MBSP_Retrieve_Block_Ack asks for it. pending = what we last sent (-1 = header).
      const job = {
        key, muid: msg.muid, tid: msg.tid, recordId: meta.id, name: meta.name, number: meta.number,
        payload, blockSize, total, sent: 0, pending: -1, retries: 0, timer: null,
        header: build.retrieveHeader({
          recordId: meta.id, identity: meta.identity, deviceName: meta.deviceName,
          sysexId: meta.sysexId, type: meta.type, number: meta.number, name: meta.name, tags: meta.tags,
          size: payload.length, numBlocks: total, checksum: meta.crc32 ?? MBSP.crc32(payload), // older records: no stored CRC-32
        }),
      };
      this.retrieves.set(key, job);
      this._log('info', `Retrieve of record ${meta.id} ${meta.number}${meta.name ? ` "${meta.name}"` : ''}: ${total} block(s) of up to ${blockSize} bytes`);
      this._sendRetrievePart(job, -1);
      this._transfersChanged();
    }

    /** Send the Retrieve_Header (index -1) or one Retrieve_Data_Block, and wait for its ack. */
    _sendRetrievePart(job, index, isRetry = false) {
      job.pending = index;
      if (!isRetry) job.retries = 0;
      if (index < 0) {
        this._reply(job, MSG.RETRIEVE_HEADER, job.header, `record ${job.recordId}, ${job.total} block(s)${isRetry ? ' (resend)' : ''}`);
      } else {
        const data = job.payload.subarray(index * job.blockSize, Math.min(job.payload.length, (index + 1) * job.blockSize));
        this._reply(job, MSG.RETRIEVE_DATA_BLOCK, build.dataBlock({ blockIndex: index, data }), `block ${index}${isRetry ? ' (resend)' : ''}`);
      }
      clearTimeout(job.timer);
      job.timer = setTimeout(() => this._retrieveAckTimeout(job), this.settings.ackTimeoutMs);
    }

    _retrieveAckTimeout(job) {
      if (this.retrieves.get(job.key) !== job) return;
      if (job.retries >= this.settings.maxRetries) {
        this.retrieves.delete(job.key);
        this._log('warn', `Retrieve of record ${job.recordId} abandoned: no ack after ${job.retries} resend(s)`);
        this._status(job, MSG.RETRIEVE_REQUEST, STATUS.TRANSACTION_TIMEOUT, job.recordId);
        this._transfersChanged();
        return;
      }
      job.retries++;
      this._sendRetrievePart(job, job.pending, true);
    }

    /** MBSP_Retrieve_Block_Ack from the Client: "send block nextBlock" (nextBlock = NumBlocks: all received). */
    _onRetrieveAck(msg, data) {
      const job = this.retrieves.get(`${msg.muid}:${msg.tid}`);
      if (!job) {
        this.stats.ignored++;
        this._log('debug', `Ignored RETRIEVE_BLOCK_ACK for unknown transaction MUID ${hexMuid(msg.muid)} TID ${msg.tid}`, data);
        return;
      }
      let ack;
      try { ack = parse.blockAck(new Reader(msg.payload)); } catch (err) {
        if (!(err instanceof MbspFieldError)) throw err;
        clearTimeout(job.timer);
        this.retrieves.delete(job.key);
        this._log('warn', `Retrieve of record ${job.recordId} failed: bad ack (${err.message})`, data);
        this._status(job, MSG.RETRIEVE_REQUEST, STATUS.INVALID_REQUEST, job.recordId);
        this._transfersChanged();
        return;
      }
      this._log('debug', `RX RETRIEVE_BLOCK_ACK TID ${msg.tid}: next block ${ack.nextBlock}`, data);
      // Only the ack for what we last sent moves the transfer on. Anything else is a late or
      // duplicated ack and is ignored; lost messages are recovered by our own resend timer.
      if (ack.nextBlock !== job.pending + 1) return;
      job.sent = ack.nextBlock;
      if (ack.nextBlock === job.total) {
        clearTimeout(job.timer);
        this.retrieves.delete(job.key);
        this.stats.retrieved++;
        this._log('info', `Sent record ${job.recordId} (${job.payload.length} byte(s)) to MUID ${hexMuid(job.muid)}`);
        this._offerDelivered(job.muid, job.recordId);
      } else {
        this._sendRetrievePart(job, ack.nextBlock);
      }
      this._transfersChanged();
    }

    // ----- Query -----
    async _onQuery(msg, data) {
      const r = this._addressed(msg, data);
      if (!r) return;
      let q;
      try { q = parse.queryRequest(r); } catch (err) {
        if (!(err instanceof MbspFieldError)) throw err;
        this._log('warn', `RX QUERY_REQUEST invalid: ${err.message}`, data);
        return this._status(msg, MSG.QUERY_REQUEST, STATUS.INVALID_REQUEST);
      }
      this._log('rx', `RX QUERY_REQUEST from MUID ${hexMuid(msg.muid)} TID ${msg.tid}: ${describeQuery(q)}`, data);
      if (!this._keyOk(msg)) return this._status(msg, MSG.QUERY_REQUEST, STATUS.REFUSED);

      const all = await this.store.list(); // ascending Record ID: stable order for paging
      const matches = all.filter(rec => MBSP.recordMatchesQuery(rec, q));
      const page = matches.slice(q.startIndex, q.startIndex + q.maxResults);
      if (!page.length) return this._status(msg, MSG.QUERY_REQUEST, STATUS.NOT_FOUND);

      const totalMatches = Math.min(matches.length, LIMITS.U14_MAX);
      this.stats.queried++;
      for (let i = 0; i < page.length; i++) {
        const resultIndex = q.startIndex + i;
        if (resultIndex > LIMITS.U14_MAX) break;
        if (i > 0) await sleep(this.settings.blockDelayMs);
        const rec = page[i];
        this._reply(msg, MSG.QUERY_RESULT, build.queryResult({
          totalMatches, resultIndex, recordId: rec.id,
          identity: rec.identity, deviceName: rec.deviceName, sysexId: rec.sysexId, type: rec.type,
          number: rec.number, name: rec.name, tags: rec.tags, size: rec.size,
        }), `${resultIndex + 1}/${matches.length} record ${rec.id} ${rec.number} "${rec.name}"`);
      }
    }

    // ----- Delete -----
    async _onDelete(msg, data) {
      const r = this._addressed(msg, data);
      if (!r) return;
      let q;
      try { q = parse.deleteRequest(r); } catch (err) {
        if (!(err instanceof MbspFieldError)) throw err;
        this._log('warn', `RX DELETE_REQUEST invalid: ${err.message}`, data);
        return this._status(msg, MSG.DELETE_REQUEST, STATUS.INVALID_REQUEST);
      }
      this._log('rx', `RX DELETE_REQUEST from MUID ${hexMuid(msg.muid)} TID ${msg.tid}: record ${q.recordId}`, data);
      if (!this._keyOk(msg) || this.settings.readOnly || !this.settings.allowDelete) {
        return this._status(msg, MSG.DELETE_REQUEST, STATUS.REFUSED, q.recordId);
      }
      const meta = q.recordId ? await this.store.get(q.recordId) : null;
      if (!meta) return this._status(msg, MSG.DELETE_REQUEST, STATUS.NOT_FOUND, q.recordId);
      if (this.settings.enforceOwnerOnDelete && !this._isOwner(meta, q.identity, q.sysexId)) {
        this._log('warn', `Delete of record ${q.recordId} refused: requester is not the device that stored it`);
        return this._status(msg, MSG.DELETE_REQUEST, STATUS.REFUSED, q.recordId);
      }
      await this.store.remove(q.recordId);
      this.stats.deleted++;
      this._log('info', `Deleted record ${q.recordId}: ${meta.number} "${meta.name}"`);
      this._status(msg, MSG.DELETE_REQUEST, STATUS.OK, q.recordId);
      this._recordsChanged();
    }
  }

  Object.assign(MbspServer.prototype, {
    // ----- Offer (optional) -----

    /**
     * Offer a Record to a device: send MBSP_Offer and collect the Offer_Replies.
     * @param {object} o
     * @param {number} o.recordId
     * @param {number[]} o.identity  Target Device Identity (7 bytes)
     * @param {number} [o.sysexId]   Target Device SysEx ID; 7F = any unit of that model
     * @param {number} [o.dst]       a Client MUID, or broadcast (the default)
     * @returns {Promise<object>} the Offer, whose replies fill in as they arrive
     */
    async offer({ recordId, identity, sysexId = LIMITS.SYSEX_ID_NONE, dst = MBSP.MUID_BROADCAST }) {
      const meta = await this.store.get(recordId);
      if (!meta) throw new Error(`Record ${recordId} does not exist`);
      const tid = this._nextServerTid();
      const old = this.offers.get(tid);
      if (old) this._dropOffer(old);
      const size = meta.size ?? ((await this.store.getPayload(recordId)) || []).length;
      const offer = {
        tid, recordId, identity: Array.from(identity), sysexId, dst, number: meta.number, name: meta.name,
        sentAt: Date.now(), expires: Date.now() + this.settings.offerLifetimeMs, replies: new Map(), noReply: false, timers: [],
      };
      this.offers.set(tid, offer);
      this._reply({ muid: dst, tid }, MSG.OFFER, build.offer({ recordId, identity, sysexId, type: meta.type, number: meta.number, name: meta.name, size }),
        `record ${recordId} ${meta.number}${meta.name ? ` "${meta.name}"` : ''} to ${MBSP.formatIdentity(identity)}${sysexId === LIMITS.SYSEX_ID_NONE ? ' (any unit)' : ' ID ' + MBSP.hex2(sysexId)}`);
      offer.timers.push(setTimeout(() => {
        if (this.offers.get(tid) !== offer || offer.replies.size) return;
        offer.noReply = true;
        this._log('warn', `Offer ${tid} of record ${recordId}: no device answered (switched off, not connected, or no Offer support)`);
        this._offersChanged();
      }, this.settings.offerReplyWaitMs));
      offer.timers.push(setTimeout(() => { if (this.offers.get(tid) === offer) this._dropOffer(offer); }, this.settings.offerLifetimeMs));
      this._offersChanged();
      return offer;
    },

    /** Transaction ID for a message we initiate: 1-16383 from our own counter; 0 is left to announcements. */
    _nextServerTid() {
      this.serverTid = this.serverTid % LIMITS.U14_MAX + 1;
      return this.serverTid;
    },

    // ----- Client discovery (optional) -----

    /** Broadcast MBSP_DiscoverClients. Devices that do not answer within clientDiscoveryWaitMs leave the list. */
    discoverClients() {
      if (this.clientDiscovery) clearTimeout(this.clientDiscovery.timer);
      const d = { tid: this._nextServerTid(), answered: new Set(), timer: null };
      this.clientDiscovery = d;
      this._reply({ muid: MBSP.MUID_BROADCAST, tid: d.tid }, MSG.DISCOVER_CLIENTS, build.discoverClients());
      d.timer = setTimeout(() => {
        if (this.clientDiscovery !== d) return;
        this.clientDiscovery = null;
        for (const muid of [...this.clients.keys()]) if (!d.answered.has(muid)) this.clients.delete(muid);
        this._log('info', `Client discovery: ${this.clients.size} device(s) answered`);
        this._clientsChanged();
      }, this.settings.clientDiscoveryWaitMs);
      this._clientsChanged();
      return d.tid;
    },

    _onOnlineClient(msg, data) {
      let c;
      try { c = parse.onlineClient(new Reader(msg.payload)); } catch (err) {
        if (!(err instanceof MbspFieldError)) throw err;
        this.stats.ignored++;
        this._log('warn', `Ignored malformed ONLINE_CLIENT from MUID ${hexMuid(msg.muid)}: ${err.message}`, data);
        return;
      }
      // A device that announces itself under a new MUID: drop its old entry, when it can be told apart by its SysEx ID.
      if (c.sysexId !== LIMITS.SYSEX_ID_NONE) {
        for (const [muid, old] of this.clients) {
          if (muid !== msg.muid && old.sysexId === c.sysexId && MBSP.identityMatches(3, old.identity, c.identity)) this.clients.delete(muid);
        }
      }
      this.clients.set(msg.muid, { muid: msg.muid, ...c, lastSeen: Date.now() });
      if (this.clientDiscovery) this.clientDiscovery.answered.add(msg.muid);
      this._log('rx', `RX ONLINE_CLIENT${msg.dst === MBSP.MUID_BROADCAST ? ' (announcement)' : ''} from MUID ${hexMuid(msg.muid)}: ` +
        `${c.deviceName || '(no name)'}, ${MBSP.formatIdentity(c.identity)}${c.sysexId === LIMITS.SYSEX_ID_NONE ? '' : ' ID ' + MBSP.hex2(c.sysexId)}` +
        `${c.capabilities & MBSP.CLIENT_CAP.OFFERS ? ', accepts Offers' : ''}`, data);
      this._clientsChanged();
    },

    _clientsChanged() {
      if (this.onClientsChanged) this.onClientsChanged([...this.clients.values()], !!this.clientDiscovery);
    },

    _onOfferReply(msg, data) {
      const offer = this.offers.get(msg.tid);
      let rep;
      try { rep = parse.offerReply(new Reader(msg.payload)); } catch (err) {
        if (!(err instanceof MbspFieldError)) throw err;
        this.stats.ignored++;
        this._log('warn', `Ignored malformed OFFER_REPLY from MUID ${hexMuid(msg.muid)}: ${err.message}`, data);
        return;
      }
      // A reply to an Offer we did not send, or one that has expired, is ignored. Offer_Reply is never answered.
      if (!offer || offer.recordId !== rep.recordId || (offer.dst !== MBSP.MUID_BROADCAST && offer.dst !== msg.muid)) {
        this.stats.ignored++;
        this._log('debug', `Ignored OFFER_REPLY TID ${msg.tid} from MUID ${hexMuid(msg.muid)}: no matching Offer`, data);
        return;
      }
      const prev = offer.replies.get(msg.muid);
      offer.replies.set(msg.muid, { ...rep, muid: msg.muid, at: Date.now(), delivered: prev ? prev.delivered : false });
      offer.noReply = false;
      this._log('rx', `RX OFFER_REPLY from MUID ${hexMuid(msg.muid)}${rep.deviceName ? ` (${rep.deviceName})` : ''}: ${OFFER_RESPONSE_NAME[rep.response]} record ${rep.recordId}`, data);
      this._offersChanged();
    },

    /** True if this Client accepted a live Offer of this Record. */
    _offerAccepted(muid, recordId) {
      const now = Date.now();
      for (const o of this.offers.values()) {
        if (o.recordId !== recordId || o.expires <= now) continue;
        const r = o.replies.get(muid);
        if (r && r.response === OFFER_RESPONSE.ACCEPTED) return true;
      }
      return false;
    },

    _offerDelivered(muid, recordId) {
      let changed = false;
      for (const o of this.offers.values()) {
        const r = o.recordId === recordId && o.replies.get(muid);
        if (r && r.response === OFFER_RESPONSE.ACCEPTED && !r.delivered) { r.delivered = true; changed = true; }
      }
      if (changed) this._offersChanged();
    },

    _dropOffer(offer) {
      for (const t of offer.timers) clearTimeout(t);
      this.offers.delete(offer.tid);
      this._offersChanged();
    },

    _clearOffers() {
      if (!this.offers) return;
      for (const o of this.offers.values()) for (const t of o.timers) clearTimeout(t);
      this.offers.clear();
      this._offersChanged();
    },

    _offersChanged() {
      if (!this.onOffersChanged) return;
      this.onOffersChanged([...this.offers.values()].map(o => ({
        tid: o.tid, recordId: o.recordId, number: o.number, name: o.name, identity: o.identity, sysexId: o.sysexId,
        dst: o.dst, sentAt: o.sentAt, noReply: o.noReply, replies: [...o.replies.values()],
      })));
    },
  });


  function describeQuery(q) {
    const parts = [];
    if (q.deviceMatchMode) parts.push(`device[${['', 'mfr', 'mfr+family', 'exact'][q.deviceMatchMode]}] ${MBSP.formatIdentity(q.identity)}`);
    if (q.sysexId !== LIMITS.SYSEX_ID_NONE) parts.push(`sysex ID ${MBSP.hex2(q.sysexId)}`);
    if (q.type !== LIMITS.TYPE_ANY) parts.push(`type ${MBSP.hex2(q.type)} (${MBSP.payloadTypeName(q.type)})`);
    if (q.number) parts.push(`number "${q.number}"`);
    if (q.name) parts.push(`name ~"${q.name}"`);
    if (q.tags.length) parts.push(`tags [${q.tags.join(', ')}]`);
    parts.push(`start ${q.startIndex}, max ${q.maxResults}`);
    return parts.join(', ');
  }

  Object.assign(MBSP, { MbspServer, DEFAULT_SETTINGS, validateServerName, uniqueServerName });
})(typeof globalThis !== 'undefined' ? globalThis : this);

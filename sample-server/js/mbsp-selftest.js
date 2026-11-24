/* mbsp-selftest.js: a virtual MBSP Client that exercises a server over an in-memory loopback.
 *
 * Runs against a fresh MbspServer + MemoryStore, so it never touches the real database.
 * Used by the page's "Run self-test" button and by test/run-tests.js under Node.
 */
(function (root) {
  'use strict';
  const MBSP = root.MBSP = root.MBSP || {};
  const { MSG, STATUS, build, parse, Reader, encodeMessage, decodeMessage } = MBSP;

  const SERVER = 'SelfTest';
  const PROPHET = [0x01, 0x00, 0x00, 0x23, 0x01, 0x05, 0x00];  // 1-byte manufacturer ID 01
  const JUNO = [0x00, 0x20, 0x29, 0x10, 0x00, 0x02, 0x00];     // 3-byte manufacturer ID 00 20 29

  function makePayload(n, seed) {
    const p = new Uint8Array(n);
    for (let i = 0; i < n; i++) p[i] = (i * 7 + seed) & 0x7F;
    return p;
  }

  async function runSelfTest({ log = () => {}, serverSettings = {} } = {}) {
    const store = new MBSP.MemoryStore();
    const inbox = [];
    const server = new MBSP.MbspServer({
      store,
      send: bytes => inbox.push(decodeMessage(bytes)),
      settings: { serverName: SERVER, blockDelayMs: 0, transactionTimeoutMs: 200, completedStoreMs: 300, blockSize: 64, ackTimeoutMs: 60, maxRetries: 2, ...serverSettings },
    });
    const muid = MBSP.randomMuid();
    let tid = 1;
    const results = [];

    const OTHER_MUID = 0x0123456; // a MUID that is neither ours nor the server's
    /** Send a message from our Client MUID to the server's MUID (DiscoverServers: to broadcast). */
    const send = (type, payload, opts = {}) => server.handleMessage(encodeMessage({
      type, src: opts.src ?? muid, dst: opts.dst ?? (type === MSG.DISCOVER_SERVERS ? MBSP.MUID_BROADCAST : server.muid),
      tid: opts.tid ?? tid, payload, accessKey: opts.accessKey || '', version: opts.version,
    }));
    const take = () => inbox.splice(0, inbox.length);
    const statusOf = m => parse.status(new Reader(m.payload));

    async function check(name, fn) {
      try {
        await fn();
        results.push({ name, ok: true });
        log({ level: 'info', text: `PASS  ${name}` });
      } catch (err) {
        results.push({ name, ok: false, error: err.message });
        log({ level: 'error', text: `FAIL  ${name}: ${err.message}` });
      }
      tid = (tid + 1) & 0x3FFF;
      take();
    }
    function assert(cond, msg) { if (!cond) throw new Error(msg); }
    const ackOf = m => parse.blockAck(new Reader(m.payload)).nextBlock;
    /** Expect exactly one Status (Store_Block_Acks before it are allowed). */
    function expectStatus(msgs, requestType, status) {
      msgs = msgs.filter(m => m.type !== MSG.STORE_BLOCK_ACK);
      assert(msgs.length === 1, `expected 1 reply, got ${msgs.length}`);
      assert(msgs[0].type === MSG.STATUS, `expected STATUS, got type ${msgs[0].type}`);
      const s = statusOf(msgs[0]);
      assert(s.requestType === requestType, `expected request type ${requestType}, got ${s.requestType}`);
      assert(s.status === status, `expected ${MBSP.STATUS_NAME[status]}, got ${MBSP.STATUS_NAME[s.status]}`);
      assert(msgs[0].dst === muid && msgs[0].src === server.muid && msgs[0].tid === tid, 'reply MUIDs/TID do not match the request');
      return s;
    }
    /** Expect exactly one message, a Block Ack of the given type asking for block `next`. */
    function expectAck(msgs, type, next) {
      assert(msgs.length === 1, `expected 1 ack, got ${msgs.length} message(s)`);
      assert(msgs[0].type === type, `expected ${MBSP.MSG_NAME[type]}, got ${MBSP.MSG_NAME[msgs[0].type] || msgs[0].type}`);
      assert(ackOf(msgs[0]) === next, `expected ack for block ${next}, got ${ackOf(msgs[0])}`);
    }
    /** A complete Store following the flow control: wait for each Store_Block_Ack before the next block. */
    async function store1(rec, payload, blockSize = 50) {
      const blocks = Math.max(1, Math.ceil(payload.length / blockSize));
      await send(MSG.STORE_HEADER, build.storeHeader({ ...rec, size: payload.length, numBlocks: blocks, checksum: MBSP.crc32(payload) }));
      expectAck(take(), MSG.STORE_BLOCK_ACK, 0);
      for (let i = 0; i < blocks; i++) {
        await send(MSG.STORE_DATA_BLOCK, build.dataBlock({ blockIndex: i, data: payload.subarray(i * blockSize, (i + 1) * blockSize) }));
        if (i < blocks - 1) expectAck(take(), MSG.STORE_BLOCK_ACK, i + 1);
      }
      return expectStatus(take(), MSG.STORE_HEADER, STATUS.OK).recordId;
    }
    /** A complete Retrieve following the flow control: ack the header and every block. */
    async function retrieve1(recordId, maxBlockSize = 0) {
      await send(MSG.RETRIEVE_REQUEST, build.retrieveRequest({ recordId, maxBlockSize }));
      let out = take();
      assert(out.length === 1 && out[0].type === MSG.RETRIEVE_HEADER, `expected RETRIEVE_HEADER, got ${out.map(m => MBSP.MSG_NAME[m.type]).join(', ') || 'nothing'}`);
      const header = parse.retrieveHeader(new Reader(out[0].payload));
      const blocks = [];
      for (let i = 0; i < header.numBlocks; i++) {
        await send(MSG.RETRIEVE_BLOCK_ACK, build.blockAck({ nextBlock: i }));
        out = take();
        assert(out.length === 1 && out[0].type === MSG.RETRIEVE_DATA_BLOCK, `ack ${i} did not produce exactly one block`);
        const b = parse.dataBlock(new Reader(out[0].payload));
        assert(b.blockIndex === i, `asked for block ${i}, got ${b.blockIndex}`);
        assert(out[0].src === server.muid && out[0].dst === muid, 'Retrieve_Data_Block not sent from the server MUID to ours');
        blocks.push(b);
      }
      await send(MSG.RETRIEVE_BLOCK_ACK, build.blockAck({ nextBlock: header.numBlocks })); // "all received"
      assert(take().length === 0, 'server sent more after the final ack');
      assert(!server.retrieves.size, 'server did not close the Retrieve after the final ack');
      const data = new Uint8Array(blocks.reduce((n, b) => n + b.data.length, 0));
      let off = 0;
      for (const b of blocks) { data.set(b.data, off); off += b.data.length; }
      return { header, blocks, data };
    }

    const padPayload = makePayload(300, 3);
    const leadPayload = makePayload(40, 9);
    const ids = {};

    await check('Envelope round-trip and checksum', async () => {
      const bytes = encodeMessage({ type: MSG.DISCOVER_SERVERS, src: 0x0ABCDEF, dst: MBSP.MUID_BROADCAST, tid: 0x1234, payload: [], accessKey: 'key' });
      const m = decodeMessage(bytes);
      assert(m && m.src === 0x0ABCDEF && m.dst === MBSP.MUID_BROADCAST && m.tid === 0x1234 && m.accessKey === 'key', 'decoded header fields differ');
      const bad = bytes.slice(); bad[bad.length - 2] ^= 1;
      assert(decodeMessage(bad) === null, 'bad checksum was accepted');
    });

    await check('Full Payload Checksum is CRC-32 in five 7-bit bytes', async () => {
      const ascii = Array.from('123456789', c => c.charCodeAt(0));
      assert(MBSP.crc32(ascii) === 0xCBF43926, 'CRC-32 check value is wrong');
      const w = new MBSP.Writer().u32(0xCBF43926).bytes;
      assert(w.join() === [0x26, 0x72, 0x50, 0x5F, 0x0C].join(), `u32 encoding is ${MBSP.hexBytes(w)}`);
      assert(new Reader(w).u32() === 0xCBF43926, 'u32 did not round-trip');
      let threw = false; try { new Reader([0, 0, 0, 0, 0x10]).u32(); } catch (_) { threw = true; }
      assert(threw, 'u32 with bits above 31 was accepted');
    });

    await check('DiscoverServers -> OnlineServer', async () => {
      await send(MSG.DISCOVER_SERVERS, build.discoverServers());
      const out = take();
      assert(out.length === 1 && out[0].type === MSG.ONLINE_SERVER, 'no OnlineServer reply');
      assert(out[0].dst === muid && out[0].src === server.muid, 'OnlineServer not sent from the server MUID to the requesting MUID');
      assert(parse.onlineServer(new Reader(out[0].payload)).serverName === SERVER, 'wrong server name');
    });

    await check('OnlineServer lists versions, policies and limits', async () => {
      await send(MSG.DISCOVER_SERVERS, build.discoverServers());
      const o = parse.onlineServer(new Reader(take()[0].payload));
      const F = MBSP.POLICY_FLAG;
      assert(o.versions.join() === '1', `versions ${o.versions}`);
      assert(o.policy === F.OWNER_DELETE, `default policy flags ${MBSP.hex2(o.policy)}`);
      assert(o.maxStoreBlockSize === server.settings.maxStoreBlockSize && o.freeSpace === MBSP.LIMITS.FREE_SPACE_UNKNOWN, 'limits differ');
      server.applySettings({ readOnly: true, allowFirmware: true, accessKey: 'k' });
      try {
        await send(MSG.DISCOVER_SERVERS, build.discoverServers());
        const p = parse.onlineServer(new Reader(take()[0].payload)).policy;
        assert(p === (F.STORE_REFUSED | F.DELETE_REFUSED | F.OWNER_DELETE | F.FIRMWARE | F.ACCESS_KEY), `policy flags ${MBSP.hex2(p)}`);
      } finally { server.applySettings({ readOnly: false, allowFirmware: false, accessKey: '' }); }
      // A later version may append fields: a v1 Client ignores them.
      const longer = [...build.onlineServer({ serverName: SERVER }), 1, 2, 3];
      assert(parse.onlineServer(new Reader(longer)).serverName === SERVER, 'appended OnlineServer fields were not ignored');
    });

    await check('DiscoverServers of another Protocol Version is answered in version 1', async () => {
      await send(MSG.DISCOVER_SERVERS, build.discoverServers(), { version: 2 });
      const out = take();
      assert(out.length === 1 && out[0].type === MSG.ONLINE_SERVER && out[0].version === 1, 'no version 1 OnlineServer reply');
      await send(MSG.QUERY_REQUEST, build.queryRequest({}), { version: 2 });
      assert(take().length === 0, 'answered a version 2 Query');
    });

    await check('Store multi-block payload', async () => {
      ids.pad = await store1({ identity: PROPHET, deviceName: 'Prophet A', sysexId: 0, type: 1, number: 'B22', name: 'JunoPad', tags: ['Pad', 'Warm'] }, padPayload);
      assert(ids.pad === 1, `expected record 1, got ${ids.pad}`);
    });

    await check('Store second device', async () => {
      ids.lead = await store1({ identity: JUNO, deviceName: '', sysexId: 0x7F, type: 1, number: '099', name: 'Mini Lead', tags: ['Lead'] }, leadPayload);
    });

    await check('Store same model, different SysEx ID', async () => {
      ids.padB = await store1({ identity: PROPHET, deviceName: 'Prophet B', sysexId: 1, type: 0x41, number: 'A', name: 'Bank A', tags: [] }, makePayload(120, 5));
    });

    await check('Store rejects bad payload checksum', async () => {
      await send(MSG.STORE_HEADER, build.storeHeader({ identity: PROPHET, sysexId: 0, type: 1, number: '1', name: 'Bad', tags: [], size: 3, numBlocks: 1, checksum: 0x00 }));
      await send(MSG.STORE_DATA_BLOCK, build.dataBlock({ blockIndex: 0, data: [1, 2, 3] }));
      expectStatus(take(), MSG.STORE_HEADER, STATUS.PAYLOAD_CHECKSUM_ERROR);
    });

    await check('Store rejects out-of-order block', async () => {
      await send(MSG.STORE_HEADER, build.storeHeader({ identity: PROPHET, sysexId: 0, type: 1, number: '1', name: 'Seq', tags: [], size: 3, numBlocks: 3, checksum: 0 }));
      await send(MSG.STORE_DATA_BLOCK, build.dataBlock({ blockIndex: 1, data: [1] }));
      expectStatus(take(), MSG.STORE_HEADER, STATUS.BLOCK_SEQUENCE_ERROR);
    });

    await check('Store times out when blocks stop', async () => {
      await send(MSG.STORE_HEADER, build.storeHeader({ identity: PROPHET, sysexId: 0, type: 1, number: '1', name: 'Slow', tags: [], size: 2, numBlocks: 2, checksum: 0 }));
      await send(MSG.STORE_DATA_BLOCK, build.dataBlock({ blockIndex: 0, data: [1] }));
      await new Promise(r => setTimeout(r, server.settings.transactionTimeoutMs + 100));
      expectStatus(take(), MSG.STORE_HEADER, STATUS.TRANSACTION_TIMEOUT);
    });

    await check('Store rejects Payload Type 7F', async () => {
      await send(MSG.STORE_HEADER, build.storeHeader({ identity: PROPHET, sysexId: 0, type: 0x7F, number: '1', name: 'X', tags: [], size: 0, numBlocks: 1, checksum: 0 }));
      expectStatus(take(), MSG.STORE_HEADER, STATUS.INVALID_REQUEST);
    });

    await check('Store rejects reserved Category 3F', async () => {
      await send(MSG.STORE_HEADER, build.storeHeader({ identity: PROPHET, sysexId: 0, type: 0x3F, number: '1', name: 'X', tags: [], size: 0, numBlocks: 1, checksum: 0 }));
      expectStatus(take(), MSG.STORE_HEADER, STATUS.INVALID_REQUEST);
    });

    await check('Firmware Store is refused by default', async () => {
      await send(MSG.STORE_HEADER, build.storeHeader({ identity: PROPHET, sysexId: 0, type: MBSP.CATEGORY.FIRMWARE, number: 'OS', name: 'OS 1.2', tags: [], size: 0, numBlocks: 1, checksum: 0 }));
      expectStatus(take(), MSG.STORE_HEADER, STATUS.REFUSED);
    });

    await check('Messages for another server are ignored', async () => {
      await send(MSG.QUERY_REQUEST, build.queryRequest({}), { dst: OTHER_MUID });
      assert(take().length === 0, 'server replied to a message for another MUID');
    });

    await check('Requests sent to the broadcast MUID are ignored (except DiscoverServers)', async () => {
      await send(MSG.QUERY_REQUEST, build.queryRequest({}), { dst: MBSP.MUID_BROADCAST });
      assert(take().length === 0, 'server answered a broadcast Query');
      await send(MSG.DISCOVER_SERVERS, build.discoverServers(), { dst: server.muid });
      assert(take().length === 1, 'DiscoverServers sent to the server MUID was not answered');
    });

    await check('Query all returns every record in ID order', async () => {
      await send(MSG.QUERY_REQUEST, build.queryRequest({}));
      const out = take().map(m => parse.queryResult(new Reader(m.payload)));
      assert(out.length === 3, `expected 3 results, got ${out.length}`);
      assert(out.every((r, i) => r.resultIndex === i && r.totalMatches === 3), 'bad result index / total');
      assert(out[0].recordId === ids.pad && out[0].size === padPayload.length && out[0].tags.join() === 'Pad,Warm', 'first result fields differ');
      assert(out[0].deviceName === 'Prophet A' && out[0].sysexId === 0, 'device name / sysex ID not returned');
    });

    await check('Query by exact device + SysEx ID (Prophet A vs B)', async () => {
      await send(MSG.QUERY_REQUEST, build.queryRequest({ deviceMatchMode: 3, identity: PROPHET, sysexId: 1 }));
      const out = take().map(m => parse.queryResult(new Reader(m.payload)));
      assert(out.length === 1 && out[0].recordId === ids.padB, 'did not isolate Prophet B');
    });

    await check('Query by manufacturer only', async () => {
      await send(MSG.QUERY_REQUEST, build.queryRequest({ deviceMatchMode: 1, identity: [0x00, 0x20, 0x29, 0, 0, 0, 0] }));
      const out = take().map(m => parse.queryResult(new Reader(m.payload)));
      assert(out.length === 1 && out[0].recordId === ids.lead, 'manufacturer match failed');
    });

    await check('Query by Payload Type matches the Collection bit exactly', async () => {
      await send(MSG.QUERY_REQUEST, build.queryRequest({ type: 0x41 }));
      let out = take().map(m => parse.queryResult(new Reader(m.payload)));
      assert(out.length === 1 && out[0].recordId === ids.padB, 'type 41 (Bank of Patches) did not return just the bank');
      await send(MSG.QUERY_REQUEST, build.queryRequest({ type: 0x01 }));
      out = take().map(m => parse.queryResult(new Reader(m.payload)));
      assert(out.length === 2 && !out.some(r => r.recordId === ids.padB), 'type 01 (Patch) should not include the bank');
    });

    await check('Query by name substring and tag (case-insensitive)', async () => {
      await send(MSG.QUERY_REQUEST, build.queryRequest({ name: 'junop', tags: ['pad'] }));
      const out = take().map(m => parse.queryResult(new Reader(m.payload)));
      assert(out.length === 1 && out[0].recordId === ids.pad, 'name/tag filter failed');
    });

    await check('Query paging', async () => {
      await send(MSG.QUERY_REQUEST, build.queryRequest({ startIndex: 1, maxResults: 1 }));
      const out = take().map(m => parse.queryResult(new Reader(m.payload)));
      assert(out.length === 1 && out[0].resultIndex === 1 && out[0].totalMatches === 3 && out[0].recordId === ids.lead, 'paging failed');
    });

    await check('Query with no matches -> Not Found', async () => {
      await send(MSG.QUERY_REQUEST, build.queryRequest({ name: 'zzz' }));
      expectStatus(take(), MSG.QUERY_REQUEST, STATUS.NOT_FOUND);
    });

    await check('Retrieve re-assembles the stored payload (one block per ack)', async () => {
      const { header: h, data } = await retrieve1(ids.pad, 100);
      // Client allows 100-byte blocks, but the server's own cap is 64: 300 bytes -> 5 blocks.
      assert(h.recordId === ids.pad && h.numBlocks === 5 && h.name === 'JunoPad', `header fields differ (numBlocks ${h.numBlocks})`);
      assert(MBSP.crc32(data) === h.checksum, 'payload CRC-32 mismatch');
      assert(data.length === padPayload.length && data.every((v, i) => v === padPayload[i]), 'payload bytes differ');
    });

    await check('Flow control: Store waits for acks; a repeated block gets the same ack', async () => {
      const p = makePayload(150, 6);
      await send(MSG.STORE_HEADER, build.storeHeader({ identity: JUNO, sysexId: 0x7F, type: 1, number: 'R1', name: 'Resend', tags: [], size: p.length, numBlocks: 3, checksum: MBSP.crc32(p) }));
      expectAck(take(), MSG.STORE_BLOCK_ACK, 0);
      await send(MSG.STORE_DATA_BLOCK, build.dataBlock({ blockIndex: 0, data: p.subarray(0, 50) }));
      expectAck(take(), MSG.STORE_BLOCK_ACK, 1);
      // Pretend that ack was lost: resend block 0. The server must repeat "next block 1", not fail.
      await send(MSG.STORE_DATA_BLOCK, build.dataBlock({ blockIndex: 0, data: p.subarray(0, 50) }));
      expectAck(take(), MSG.STORE_BLOCK_ACK, 1);
      await send(MSG.STORE_DATA_BLOCK, build.dataBlock({ blockIndex: 1, data: p.subarray(50, 100) }));
      expectAck(take(), MSG.STORE_BLOCK_ACK, 2);
      await send(MSG.STORE_DATA_BLOCK, build.dataBlock({ blockIndex: 2, data: p.subarray(100) }));
      const id = expectStatus(take(), MSG.STORE_HEADER, STATUS.OK).recordId;
      const back = await store.getPayload(id);
      assert(back.length === 150 && back.every((v, i) => v === p[i]), 'repeated block was stored twice or bytes differ');
      await store.remove(id); // keep the record count the later tests expect
    });

    await check('Flow control: Retrieve sends nothing until acked, resends on silence, ignores stale acks', async () => {
      await send(MSG.RETRIEVE_REQUEST, build.retrieveRequest({ recordId: ids.lead, maxBlockSize: 16 }));
      let out = take();
      assert(out.length === 1 && out[0].type === MSG.RETRIEVE_HEADER, 'expected only the header before any ack');
      // Say nothing: the header must be resent after the ack timeout.
      await new Promise(r => setTimeout(r, server.settings.ackTimeoutMs + 30));
      out = take();
      assert(out.length === 1 && out[0].type === MSG.RETRIEVE_HEADER, 'header was not resent after the ack timeout');
      await send(MSG.RETRIEVE_BLOCK_ACK, build.blockAck({ nextBlock: 0 }));
      out = take();
      assert(out.length === 1 && parse.dataBlock(new Reader(out[0].payload)).blockIndex === 0, 'ack 0 did not send block 0');
      // A duplicated (stale) ack must not trigger another block.
      await send(MSG.RETRIEVE_BLOCK_ACK, build.blockAck({ nextBlock: 0 }));
      assert(take().length === 0, 'stale ack caused a send');
      // Lost block: say nothing again, block 0 is resent.
      await new Promise(r => setTimeout(r, server.settings.ackTimeoutMs + 30));
      out = take();
      assert(out.length === 1 && parse.dataBlock(new Reader(out[0].payload)).blockIndex === 0, 'block 0 was not resent');
      for (let i = 1; i <= 3; i++) {
        await send(MSG.RETRIEVE_BLOCK_ACK, build.blockAck({ nextBlock: i }));
        assert(take().length === (i < 3 ? 1 : 0), `unexpected reply to ack ${i}`);
      }
      assert(!server.retrieves.size, 'Retrieve was not closed by the final ack');
    });

    await check('Flow control: Retrieve gives up with Transaction Timeout after the retries', async () => {
      await send(MSG.RETRIEVE_REQUEST, build.retrieveRequest({ recordId: ids.lead }));
      take();
      const s = server.settings;
      await new Promise(r => setTimeout(r, s.ackTimeoutMs * (s.maxRetries + 1) + 60));
      const out = take();
      assert(out.filter(m => m.type === MSG.RETRIEVE_HEADER).length === s.maxRetries, `expected ${s.maxRetries} header resends`);
      expectStatus(out.filter(m => m.type === MSG.STATUS), MSG.RETRIEVE_REQUEST, STATUS.TRANSACTION_TIMEOUT);
      assert(!server.retrieves.size, 'abandoned Retrieve still open');
    });

    await check('Retrieve unknown record -> Not Found', async () => {
      await send(MSG.RETRIEVE_REQUEST, build.retrieveRequest({ recordId: 999 }));
      const s = expectStatus(take(), MSG.RETRIEVE_REQUEST, STATUS.NOT_FOUND);
      assert(s.recordId === 999, 'Status does not echo the Record ID');
    });

    await check('Delete by a different device is refused', async () => {
      await send(MSG.DELETE_REQUEST, build.deleteRequest({ recordId: ids.pad, identity: PROPHET, sysexId: 1 }));
      expectStatus(take(), MSG.DELETE_REQUEST, STATUS.REFUSED);
    });

    await check('Delete by the owning device', async () => {
      await send(MSG.DELETE_REQUEST, build.deleteRequest({ recordId: ids.pad, identity: PROPHET, sysexId: 0 }));
      expectStatus(take(), MSG.DELETE_REQUEST, STATUS.OK);
      await send(MSG.RETRIEVE_REQUEST, build.retrieveRequest({ recordId: ids.pad }));
      expectStatus(take(), MSG.RETRIEVE_REQUEST, STATUS.NOT_FOUND);
    });

    await check('Record IDs are not reused after a delete', async () => {
      // ids.pad (record 1) was deleted above; a new record must get a fresh, higher ID.
      const expected = await store.getNextId();
      const id = await store1({ identity: JUNO, sysexId: 0x7F, type: 0, number: 'X1', name: 'After', tags: [] }, makePayload(10, 1));
      assert(id === expected && id > ids.padB, `expected record ${expected}, got ${id}`);
      assert(!(await store.get(ids.pad)), 'deleted record came back');
    });

    await check('Access Key is enforced when configured', async () => {
      server.applySettings({ accessKey: 'secret' });
      await send(MSG.QUERY_REQUEST, build.queryRequest({}));
      expectStatus(take(), MSG.QUERY_REQUEST, STATUS.REFUSED);
      await send(MSG.QUERY_REQUEST, build.queryRequest({}), { accessKey: 'secret' });
      assert(take().length === 3, 'correct Access Key did not return results');
      server.applySettings({ accessKey: '' });
    });

    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const R7 = { identity: JUNO, sysexId: 2, type: 1, number: 'R7' };
    let r7 = 0, r7Payload = null;

    await check('Replace keeps the Record ID and swaps the contents', async () => {
      const p1 = makePayload(120, 11);
      r7 = await store1({ ...R7, name: 'Before', tags: ['v1'] }, p1);
      const count = (await store.list()).length;
      const p2 = makePayload(170, 12);
      tid = (tid + 1) & 0x3FFF;
      const id = await store1({ ...R7, replaceId: r7, name: 'After', tags: ['v2'] }, p2);
      assert(id === r7, `Status OK carried Record ID ${id}, expected ${r7}`);
      assert((await store.list()).length === count, 'a Replace created a new record');
      tid = (tid + 1) & 0x3FFF;
      const { header: h, data } = await retrieve1(r7);
      assert(h.name === 'After' && h.tags.join() === 'v2' && same(data, p2), 'the record does not hold the new version');
      r7Payload = p2;
    });

    await check('Replace of a missing Record -> Not Found', async () => {
      await send(MSG.STORE_HEADER, build.storeHeader({ ...R7, replaceId: 0x1FFFF0, name: '', tags: [], size: 0, numBlocks: 1, checksum: 0 }));
      const st = expectStatus(take(), MSG.STORE_HEADER, STATUS.NOT_FOUND);
      assert(st.recordId === 0x1FFFF0, 'Not Found should carry the Record ID');
    });

    await check('Replace by another device, or with Delete switched off -> Refused', async () => {
      await send(MSG.STORE_HEADER, build.storeHeader({ ...R7, identity: PROPHET, sysexId: 0, replaceId: r7, name: '', tags: [], size: 0, numBlocks: 1, checksum: 0 }));
      expectStatus(take(), MSG.STORE_HEADER, STATUS.REFUSED);
      server.applySettings({ allowDelete: false });
      try {
        tid = (tid + 1) & 0x3FFF;
        await send(MSG.STORE_HEADER, build.storeHeader({ ...R7, replaceId: r7, name: '', tags: [], size: 0, numBlocks: 1, checksum: 0 }));
        expectStatus(take(), MSG.STORE_HEADER, STATUS.REFUSED);
      } finally { server.applySettings({ allowDelete: true }); }
    });

    await check('A failed Replace leaves the Record unchanged', async () => {
      await send(MSG.STORE_HEADER, build.storeHeader({ ...R7, replaceId: r7, name: 'Broken', tags: [], size: 3, numBlocks: 1, checksum: 12345 }));
      take();
      await send(MSG.STORE_DATA_BLOCK, build.dataBlock({ blockIndex: 0, data: [1, 2, 3] }));
      expectStatus(take(), MSG.STORE_HEADER, STATUS.PAYLOAD_CHECKSUM_ERROR);
      tid = (tid + 1) & 0x3FFF;
      const { header: h, data } = await retrieve1(r7);
      assert(h.name === 'After' && same(data, r7Payload), 'the failed Replace changed the record');
    });

    await check('A Retrieve in progress keeps sending the old version during a Replace', async () => {
      const tidR = (tid + 500) & 0x3FFF;
      const ackR = n => send(MSG.RETRIEVE_BLOCK_ACK, build.blockAck({ nextBlock: n }), { tid: tidR });
      await send(MSG.RETRIEVE_REQUEST, build.retrieveRequest({ recordId: r7 }), { tid: tidR });
      const h = parse.retrieveHeader(new Reader(take()[0].payload));
      const parts = [];
      await ackR(0);
      parts.push(...parse.dataBlock(new Reader(take()[0].payload)).data);
      const p3 = makePayload(90, 13);
      await store1({ ...R7, replaceId: r7, name: 'Third', tags: [] }, p3); // completes mid-Retrieve
      for (let i = 1; i < h.numBlocks; i++) {
        await ackR(i);
        parts.push(...parse.dataBlock(new Reader(take()[0].payload)).data);
      }
      await ackR(h.numBlocks);
      take();
      assert(same(parts, r7Payload) && h.checksum === MBSP.crc32(r7Payload), 'the Retrieve mixed old and new data');
      tid = (tid + 1) & 0x3FFF;
      const { data } = await retrieve1(r7);
      assert(same(data, p3), 'a new Retrieve does not return the replacement');
    });

    await check('An empty Payload is stored and retrieved as one Block of size 0', async () => {
      const id = await store1({ ...R7, sysexId: 3, number: 'E1', name: 'Empty', tags: [] }, new Uint8Array(0));
      tid = (tid + 1) & 0x3FFF;
      const { header: h, data } = await retrieve1(id);
      assert(MBSP.crc32([]) === 0, 'CRC-32 of no bytes is not 0');
      assert(h.numBlocks === 1 && h.checksum === 0 && data.length === 0, `numBlocks ${h.numBlocks}, ${data.length} byte(s)`);
    });

    await check('Overlapping Replaces of one Record: each gets OK, the last to complete wins', async () => {
      const a = makePayload(20, 21), b = makePayload(30, 22);
      const tidA = (tid + 600) & 0x3FFF, tidB = (tid + 601) & 0x3FFF;
      const hdr = (p, name) => build.storeHeader({ ...R7, replaceId: r7, name, tags: [], size: p.length, numBlocks: 1, checksum: MBSP.crc32(p) });
      await send(MSG.STORE_HEADER, hdr(a, 'A'), { tid: tidA });
      await send(MSG.STORE_HEADER, hdr(b, 'B'), { tid: tidB });
      await send(MSG.STORE_DATA_BLOCK, build.dataBlock({ blockIndex: 0, data: b }), { tid: tidB }); // B completes first
      await send(MSG.STORE_DATA_BLOCK, build.dataBlock({ blockIndex: 0, data: a }), { tid: tidA }); // A completes last
      const st = take().filter(m => m.type === MSG.STATUS).map(m => statusOf(m));
      assert(st.length === 2 && st.every(s => s.status === STATUS.OK && s.recordId === r7), 'both replacements should get OK with the Record ID');
      const meta = await store.get(r7), p = await store.getPayload(r7);
      assert(meta.name === 'A' && same(p, a), `record holds "${meta.name}", expected the last to complete ("A")`);
    });

    await check('Payload Size: Blocks that do not add up to it -> Invalid Request, nothing stored', async () => {
      const before = (await store.list()).length;
      const p = makePayload(10, 31);
      await send(MSG.STORE_HEADER, build.storeHeader({ ...R7, name: 'Short', tags: [], size: 12, numBlocks: 1, checksum: MBSP.crc32(p) }));
      take();
      await send(MSG.STORE_DATA_BLOCK, build.dataBlock({ blockIndex: 0, data: p }));
      expectStatus(take(), MSG.STORE_HEADER, STATUS.INVALID_REQUEST);
      tid = (tid + 1) & 0x3FFF;
      await send(MSG.STORE_HEADER, build.storeHeader({ ...R7, name: 'Long', tags: [], size: 8, numBlocks: 1, checksum: MBSP.crc32(p) }));
      take();
      await send(MSG.STORE_DATA_BLOCK, build.dataBlock({ blockIndex: 0, data: p }));
      expectStatus(take(), MSG.STORE_HEADER, STATUS.INVALID_REQUEST);
      tid = (tid + 1) & 0x3FFF;
      await send(MSG.STORE_HEADER, build.storeHeader({ ...R7, name: 'Wide', tags: [], size: 2 * 16383 + 1, numBlocks: 2, checksum: 0 }));
      expectStatus(take(), MSG.STORE_HEADER, STATUS.INVALID_REQUEST);
      assert((await store.list()).length === before, 'a record was stored');
    });

    await check('Payload Size: a Store that cannot fit gets Storage Full before any Block', async () => {
      const out = [];
      const s2 = new MBSP.MbspServer({ store: new MBSP.MemoryStore({ capacity: 100 }), send: b => out.push(decodeMessage(b)),
        settings: { serverName: 'Tiny', blockDelayMs: 0 } });
      try {
        await s2.handleMessage(encodeMessage({ type: MSG.STORE_HEADER, src: muid, dst: s2.muid, tid,
          payload: build.storeHeader({ ...R7, name: 'Huge', tags: [], size: 101, numBlocks: 1, checksum: 0 }) }));
      } finally { s2.shutdown(); }
      const st = out.filter(m => m.type === MSG.STATUS);
      assert(st.length === 1 && statusOf(st[0]).status === STATUS.STORAGE_FULL, 'expected Storage Full in reply to the header');
      assert(!out.some(m => m.type === MSG.STORE_BLOCK_ACK), 'the server asked for a Block');
    });

    await check('Retrieve with a Max Block Size too small for 16,383 Blocks -> Invalid Request', async () => {
      const id = await store1({ ...R7, number: 'MB', name: 'Many', tags: [] }, makePayload(16384, 32));
      tid = (tid + 1) & 0x3FFF;
      await send(MSG.RETRIEVE_REQUEST, build.retrieveRequest({ recordId: id, maxBlockSize: 1 }));
      expectStatus(take(), MSG.RETRIEVE_REQUEST, STATUS.INVALID_REQUEST);
    });

    await check('Record IDs keep increasing: a deleted ID is not reused', async () => {
      const a = await store1({ ...R7, number: 'D1', name: '', tags: [] }, makePayload(4, 33));
      await store.remove(a);
      tid = (tid + 1) & 0x3FFF;
      const b = await store1({ ...R7, number: 'D2', name: '', tags: [] }, makePayload(4, 34));
      assert(b > a, `new Record ID ${b} is not above deleted ${a}`);
    });

    await check('Unknown Message Type is ignored silently', async () => {
      await send(55, build.queryRequest({}));
      assert(take().length === 0, 'server replied to an unknown Message Type');
    });

    await check('Lost final Status: a resent last block gets the same Status again', async () => {
      const p = makePayload(80, 7);
      const id = await store1({ identity: JUNO, sysexId: 0x7F, type: 1, number: 'L1', name: 'Lost', tags: [] }, p);
      const before = (await store.list()).length;
      await send(MSG.STORE_DATA_BLOCK, build.dataBlock({ blockIndex: 1, data: p.subarray(50) }));
      const s = expectStatus(take(), MSG.STORE_HEADER, STATUS.OK);
      assert(s.recordId === id, `repeated Status has Record ID ${s.recordId}, expected ${id}`);
      assert((await store.list()).length === before, 'the resent block created another record');
      // A failed Store's error Status is remembered too.
      tid = (tid + 1) & 0x3FFF;
      await send(MSG.STORE_HEADER, build.storeHeader({ identity: JUNO, sysexId: 0x7F, type: 1, number: 'L2', name: '', tags: [], size: 1, numBlocks: 1, checksum: 1 }));
      await send(MSG.STORE_DATA_BLOCK, build.dataBlock({ blockIndex: 0, data: [5] }));
      expectStatus(take(), MSG.STORE_HEADER, STATUS.PAYLOAD_CHECKSUM_ERROR);
      await send(MSG.STORE_DATA_BLOCK, build.dataBlock({ blockIndex: 0, data: [5] }));
      expectStatus(take(), MSG.STORE_HEADER, STATUS.PAYLOAD_CHECKSUM_ERROR);
      // Once the memory time has passed, the same block gets Unknown Transaction.
      await new Promise(r => setTimeout(r, server.settings.completedStoreMs + 50));
      await send(MSG.STORE_DATA_BLOCK, build.dataBlock({ blockIndex: 0, data: [5] }));
      expectStatus(take(), MSG.STORE_HEADER, STATUS.UNKNOWN_TRANSACTION);
    });

    await check('Data Block for no open Store -> Unknown Transaction', async () => {
      await send(MSG.STORE_DATA_BLOCK, build.dataBlock({ blockIndex: 0, data: [1, 2] }));
      expectStatus(take(), MSG.STORE_HEADER, STATUS.UNKNOWN_TRANSACTION);
      await send(MSG.STORE_DATA_BLOCK, build.dataBlock({ blockIndex: 0, data: [1, 2] }), { dst: OTHER_MUID });
      assert(take().length === 0, 'answered a Data Block for another server');
    });

    await check('An echo of the server\'s own message is not a MUID collision', async () => {
      const before = server.muid;
      let sent = null;
      const realSend = server.send;
      server.send = b => { sent = b; realSend(b); };
      try { await send(MSG.DISCOVER_SERVERS, build.discoverServers()); } finally { server.send = realSend; }
      take();
      await server.handleMessage(sent); // a MIDI loop brings our OnlineServer back
      assert(server.muid === before && take().length === 0, 'an echo was treated as a collision');
    });

    await check('MUID collision: the server draws a new MUID and announces it', async () => {
      const before = server.muid;
      // Another server (or a Client) sending with our MUID as its Source.
      await server.handleMessage(encodeMessage({ type: MSG.ONLINE_SERVER, src: before, dst: MBSP.MUID_BROADCAST, tid: 0,
        payload: build.onlineServer({ serverName: 'Impostor' }) }));
      assert(server.muid !== before && MBSP.isValidMuid(server.muid), 'the server kept its MUID');
      const out = take();
      assert(out.length === 1 && out[0].type === MSG.ONLINE_SERVER && out[0].src === server.muid && out[0].dst === MBSP.MUID_BROADCAST, 'new MUID not announced');
      await send(MSG.QUERY_REQUEST, build.queryRequest({}), { dst: before });
      assert(take().length === 0, 'the old MUID is still answered');
    });

    await check('Store Block larger than Max Store Block Size -> Invalid Request', async () => {
      server.applySettings({ maxStoreBlockSize: 256 });
      try {
        const p = makePayload(300, 2);
        await send(MSG.STORE_HEADER, build.storeHeader({ identity: PROPHET, sysexId: 0, type: 1, number: '1', name: 'Big', tags: [], size: p.length, numBlocks: 2, checksum: MBSP.crc32(p) }));
        await send(MSG.STORE_DATA_BLOCK, build.dataBlock({ blockIndex: 0, data: p }));
        expectStatus(take(), MSG.STORE_HEADER, STATUS.INVALID_REQUEST);
      } finally { server.applySettings({ maxStoreBlockSize: 16383 }); }
    });

    await check('.mbsp file export / import round-trip', async () => {
      const entries = await MBSP.readAll(store);
      const nextId = await store.getNextId();
      const file = MBSP.encodeDatabaseFile({ serverName: SERVER, nextRecordId: nextId, entries });
      const back = MBSP.decodeDatabaseFile(file);
      assert(back.entries.length === entries.length && back.nextRecordId === nextId, 'record count / next ID differ');
      const copy = new MBSP.MemoryStore();
      await MBSP.importEntries(copy, back.entries, back.nextRecordId, 'replace');
      assert((await copy.list()).map(r => r.id).join() === (await store.list()).map(r => r.id).join(), 'IDs not preserved on replace');
      const p1 = await copy.getPayload(ids.lead), p2 = await store.getPayload(ids.lead);
      assert(p1.length === p2.length && p1.every((v, i) => v === p2[i]), 'payload differs after import');
      await MBSP.importEntries(copy, back.entries, back.nextRecordId, 'merge');
      assert((await copy.list()).length === entries.length * 2, 'merge did not add new records');
      const corrupt = file.slice(); corrupt[20] ^= 0xFF;
      let threw = false; try { MBSP.decodeDatabaseFile(corrupt); } catch (_) { threw = true; }
      assert(threw, 'corrupt file was accepted');
    });

    await check('.mbsp version 1 file (7-bit checksum) is still imported', async () => {
      const meta = await store.get(ids.lead), payload = await store.getPayload(ids.lead);
      const v2 = MBSP.encodeDatabaseFile({ serverName: 'S', nextRecordId: 99, entries: [{ meta, payload }] });
      // Rewrite as version 1: the header is 26 bytes + server name (1 + 1 char); the CRC-32 sits 21 bytes into the record.
      const at = 26 + 2 + 21, body = [...v2.slice(0, at), 0x55, ...v2.slice(at + 4, v2.length - 4)];
      body[6] = 1; body[7] = 0;
      const crc = MBSP.crc32(body), v1 = Uint8Array.from([...body, crc & 0xFF, (crc >>> 8) & 0xFF, (crc >>> 16) & 0xFF, crc >>> 24]);
      const back = MBSP.decodeDatabaseFile(v1);
      assert(back.entries.length === 1 && back.entries[0].meta.crc32 === MBSP.crc32(payload), 'CRC-32 not computed for a version 1 record');
      const bad = MBSP.encodeDatabaseFile({ serverName: 'S', nextRecordId: 99, entries: [{ meta: { ...meta, crc32: (meta.crc32 ^ 1) >>> 0 }, payload }] });
      let threw = false; try { MBSP.decodeDatabaseFile(bad); } catch (_) { threw = true; }
      assert(threw, 'a record whose payload does not match its CRC-32 was imported');
    });

    await check('Payload Name is optional', async () => {
      const id = await store1({ identity: JUNO, sysexId: 0x7F, type: 1, number: '042', name: '', tags: [] }, makePayload(30, 4));
      const { header: h } = await retrieve1(id);
      assert(h.name === '' && h.number === '042', 'unnamed record did not round-trip');
    });

    await check('Payload Number is required', async () => {
      // The builder refuses an empty number, so write the header by hand.
      const payload = new MBSP.Writer()
        .str(SERVER, 4, 16, 'Server Name').identity(PROPHET).str('', 0, 32, 'Device Name').u7(0).u7(1)
        .str('', 0, 8, 'Payload Number').str('No Number', 0, 32, 'Payload Name').tags([]).u14(1).u7(0).bytes;
      await send(MSG.STORE_HEADER, payload);
      expectStatus(take(), MSG.STORE_HEADER, STATUS.INVALID_REQUEST);
    });

    await check('Firmware Store is accepted when allowed', async () => {
      server.applySettings({ allowFirmware: true });
      const id = await store1({ identity: PROPHET, sysexId: 0, type: MBSP.CATEGORY.FIRMWARE, number: 'OS', name: 'OS 1.2', tags: [] }, makePayload(500, 2));
      assert(id > 0, 'no Record ID');
      server.applySettings({ allowFirmware: false });
    });

    // ----- Offer (optional feature) -----
    let offerRec = 0;
    const offerPayload = makePayload(130, 40);
    const replyTo = (offer, response, opts = {}) => send(MSG.OFFER_REPLY,
      build.offerReply({ recordId: opts.recordId ?? offer.recordId, response, sysexId: 2, deviceName: 'Juno Test' }), { tid: offer.tid, ...opts });

    await check('Offer: broadcast with Target Identity, Record ID, Payload Type, Number, Name and Size', async () => {
      offerRec = await store1({ identity: JUNO, sysexId: 2, type: 0x01, number: 'OF1', name: 'Offered', tags: [] }, offerPayload);
      take();
      const offer = await server.offer({ recordId: offerRec, identity: JUNO, sysexId: 2 });
      const out = take();
      assert(out.length === 1 && out[0].type === MSG.OFFER, 'expected one OFFER');
      assert(out[0].src === server.muid && out[0].dst === MBSP.MUID_BROADCAST && out[0].tid === offer.tid && out[0].accessKey === '', 'Offer envelope');
      const o = parse.offer(new Reader(out[0].payload));
      assert(o.recordId === offerRec && same(o.identity, JUNO) && o.sysexId === 2 && o.type === 0x01 &&
        o.number === 'OF1' && o.name === 'Offered' && o.size === offerPayload.length, 'Offer fields');
      assert(MBSP.offerIsFor(o, JUNO, 2) && !MBSP.offerIsFor(o, JUNO, 3) && !MBSP.offerIsFor(o, PROPHET, 2), 'offerIsFor, specific unit');
      assert(MBSP.offerIsFor({ ...o, sysexId: 0x7F }, JUNO, 9), 'offerIsFor, any unit');
      const next = await server.offer({ recordId: offerRec, identity: JUNO });
      assert(next.tid === offer.tid + 1, 'Offer Transaction IDs do not count up');
      take();
    });

    await check('Offer: an accepted Offer allows a Retrieve without the Access Key, and is marked delivered', async () => {
      server.applySettings({ accessKey: 'secret' });
      try {
        await send(MSG.RETRIEVE_REQUEST, build.retrieveRequest({ recordId: offerRec }));
        expectStatus(take(), MSG.RETRIEVE_REQUEST, STATUS.REFUSED);
        tid = (tid + 1) & 0x3FFF;
        const offer = await server.offer({ recordId: offerRec, identity: JUNO, sysexId: 2 });
        take();
        await replyTo(offer, MBSP.OFFER_RESPONSE.ACCEPTED);
        assert(take().length === 0, 'the server answered an Offer_Reply');
        const rep = offer.replies.get(muid);
        assert(rep && rep.response === MBSP.OFFER_RESPONSE.ACCEPTED && rep.deviceName === 'Juno Test', 'reply not recorded');
        const { data } = await retrieve1(offerRec);
        assert(same(Array.from(data), Array.from(offerPayload)), 'payload differs');
        assert(rep.delivered, 'Offer not marked delivered');
        // The keyless Retrieve is only for the offered Record.
        tid = (tid + 1) & 0x3FFF;
        await send(MSG.RETRIEVE_REQUEST, build.retrieveRequest({ recordId: ids.padB || 1 }));
        expectStatus(take(), MSG.RETRIEVE_REQUEST, STATUS.REFUSED);
      } finally { server.applySettings({ accessKey: '' }); }
    });

    await check('Offer: Pending then Declined; replies to unknown Offers and Offers sent to a server are ignored', async () => {
      const offer = await server.offer({ recordId: offerRec, identity: JUNO, sysexId: 2 });
      take();
      await replyTo(offer, MBSP.OFFER_RESPONSE.PENDING);
      assert(offer.replies.get(muid).response === MBSP.OFFER_RESPONSE.PENDING, 'Pending not recorded');
      await replyTo(offer, MBSP.OFFER_RESPONSE.DECLINED);
      assert(offer.replies.get(muid).response === MBSP.OFFER_RESPONSE.DECLINED, 'Declined did not replace Pending');
      const ignoredBefore = server.stats.ignored;
      await replyTo({ tid: 0x3FFE, recordId: offerRec }, MBSP.OFFER_RESPONSE.ACCEPTED);             // no such Offer
      await replyTo(offer, MBSP.OFFER_RESPONSE.ACCEPTED, { recordId: offerRec + 1000 });           // wrong Record ID
      await send(MSG.OFFER, build.offer({ recordId: 1, identity: JUNO, sysexId: 2, type: 1, number: 'X', size: 0 }), { dst: MBSP.MUID_BROADCAST });
      assert(take().length === 0, 'the server replied');
      assert(server.stats.ignored === ignoredBefore + 3, 'not counted as ignored');
      assert(offer.replies.get(muid).response === MBSP.OFFER_RESPONSE.DECLINED, 'a mismatched reply changed the Offer');
    });

    await check('Offer: no reply is reported after the reply wait; a directed Offer ignores other MUIDs', async () => {
      server.applySettings({ offerReplyWaitMs: 30 });
      try {
        const offer = await server.offer({ recordId: offerRec, identity: JUNO, dst: OTHER_MUID });
        const out = take();
        assert(out.length === 1 && out[0].dst === OTHER_MUID, 'directed Offer not sent to the MUID');
        await replyTo(offer, MBSP.OFFER_RESPONSE.ACCEPTED); // from our MUID, not the one offered to
        assert(offer.replies.size === 0, 'reply from another MUID accepted');
        await new Promise(r => setTimeout(r, 60));
        assert(offer.noReply, 'no-reply not reported');
      } finally { server.applySettings({ offerReplyWaitMs: 2000 }); }
      let threw = false;
      try { await server.offer({ recordId: 999999, identity: JUNO }); } catch (_) { threw = true; }
      assert(threw, 'offered a Record that does not exist');
    });

    // ----- Client discovery (optional feature) -----
    const online = (c, opts = {}) => send(MSG.ONLINE_CLIENT, build.onlineClient(c), opts);

    await check('Client discovery: DiscoverClients is broadcast with a server Transaction ID; replies fill the device list', async () => {
      server.applySettings({ clientDiscoveryWaitMs: 30 });
      try {
        const dtid = server.discoverClients();
        const out = take();
        assert(out.length === 1 && out[0].type === MSG.DISCOVER_CLIENTS && out[0].dst === MBSP.MUID_BROADCAST && out[0].tid === dtid &&
          out[0].src === server.muid && out[0].payload.length === 0, 'DiscoverClients envelope');
        await online({ identity: JUNO, sysexId: 2, deviceName: 'Juno Test', capabilities: MBSP.CLIENT_CAP.OFFERS }, { tid: dtid });
        assert(take().length === 0, 'the server answered an OnlineClient');
        const c = server.clients.get(muid);
        assert(c && same(c.identity, JUNO) && c.sysexId === 2 && c.deviceName === 'Juno Test' && (c.capabilities & MBSP.CLIENT_CAP.OFFERS), 'device not listed');
        // Round trip of the codec, and extra bytes from a later version are ignored.
        const p = build.onlineClient({ identity: PROPHET, sysexId: 0x7F, deviceName: '', capabilities: 0 });
        const back = parse.onlineClient(new Reader(Uint8Array.from([...p, 0x11, 0x22])));
        assert(same(back.identity, PROPHET) && back.sysexId === 0x7F && back.deviceName === '' && back.capabilities === 0, 'codec round trip');
      } finally { server.applySettings({ clientDiscoveryWaitMs: 1000 }); }
    });

    await check('Client discovery: announcements are accepted; a new MUID replaces a device with the same Identity and SysEx ID', async () => {
      await online({ identity: PROPHET, sysexId: 5, deviceName: 'Prophet', capabilities: 0 }, { dst: MBSP.MUID_BROADCAST, tid: 0, src: OTHER_MUID });
      assert(server.clients.get(OTHER_MUID)?.deviceName === 'Prophet', 'broadcast announcement not listed');
      await online({ identity: PROPHET, sysexId: 5, deviceName: 'Prophet', capabilities: 0 }, { dst: MBSP.MUID_BROADCAST, tid: 0, src: OTHER_MUID + 1 });
      assert(!server.clients.has(OTHER_MUID) && server.clients.has(OTHER_MUID + 1), 'old MUID not replaced');
      // Devices without a SysEx ID cannot be told apart, so both stay.
      await online({ identity: PROPHET, sysexId: 0x7F, capabilities: 0 }, { dst: MBSP.MUID_BROADCAST, tid: 0, src: OTHER_MUID + 2 });
      await online({ identity: PROPHET, sysexId: 0x7F, capabilities: 0 }, { dst: MBSP.MUID_BROADCAST, tid: 0, src: OTHER_MUID + 3 });
      assert(server.clients.has(OTHER_MUID + 2) && server.clients.has(OTHER_MUID + 3), 'identical units merged');
      assert(take().length === 0, 'the server replied');
    });

    await check('Client discovery: a rediscovery drops devices that do not answer; another server\'s DiscoverClients is ignored', async () => {
      server.applySettings({ clientDiscoveryWaitMs: 30 });
      try {
        const dtid = server.discoverClients();
        take();
        await online({ identity: JUNO, sysexId: 2, deviceName: 'Juno Test', capabilities: 1 }, { tid: dtid });
        await new Promise(r => setTimeout(r, 60));
        assert(server.clients.size === 1 && server.clients.has(muid), `expected only the device that answered, got ${server.clients.size}`);
      } finally { server.applySettings({ clientDiscoveryWaitMs: 1000 }); }
      const ignored = server.stats.ignored;
      await send(MSG.DISCOVER_CLIENTS, [], { dst: MBSP.MUID_BROADCAST, src: OTHER_MUID });
      assert(take().length === 0 && server.stats.ignored === ignored + 1, 'DiscoverClients from another server not ignored');
      let threw = false;
      try { await online({ identity: JUNO, sysexId: 2 }, {}); } catch (_) { threw = true; }
      assert(!threw && server.clients.get(muid).capabilities === 0, 'capabilities not updated');
    });

    await check('Payload Type names', async () => {
      const n = MBSP.payloadTypeName;
      assert(n(0x01) === 'Patch' && n(0x41) === 'Bank of Patches' && n(0x45) === 'Bank of Drum Kits', 'standard names');
      assert(n(0x31) === 'Vendor 31' && n(0x71) === 'Vendor 31 collection' && n(0x20) === 'Reserved 20' && n(0x7F) === 'Any', 'vendor / reserved names');
      assert(!MBSP.isStorablePayloadType(0x3F) && !MBSP.isStorablePayloadType(0x7F) && MBSP.isStorablePayloadType(0x7E), 'storable check');
    });

    server.shutdown();
    const failed = results.filter(r => !r.ok).length;
    log({ level: failed ? 'error' : 'info', text: `Self-test finished: ${results.length - failed}/${results.length} passed` });
    return { results, failed };
  }

  MBSP.runSelfTest = runSelfTest;
})(typeof globalThis !== 'undefined' ? globalThis : this);

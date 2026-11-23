# MBSP WebMIDI Server

A MIDI Bulk Storage Protocol (MBSP) v1 server that runs in a web page. It listens for MBSP SysEx on Web MIDI, keeps records in the browser's IndexedDB, and lets you browse, search, export and import the database.

It follows the protocol in the [MBSP specification](../docs/MBSP-Specification-v1.0-Draft2.pdf).

## Running it

Web MIDI with SysEx needs a secure context and a browser that supports it.

- **Chrome or Edge:** serve the folder from localhost, for example `npx serve .` or `python -m http.server 8000`, then open `http://localhost:8000/`. Opening `index.html` straight from disk may also work in Chrome, but that hasn't been tested and browsers treat `file://` permissions inconsistently, so use localhost.
- **Firefox:** Web MIDI needs Firefox's site-permission add-on prompt, which only works over https or localhost.
- **Safari:** has no Web MIDI.

Then:

1. Click **Connect MIDI** and allow MIDI with SysEx access. After the first time, the page reconnects automatically.
2. Pick the MIDI input to listen on and the output to reply on. New ports start switched off, so replies don't go to instruments you didn't choose. Choices are remembered by port ID. When two ports share a name (Windows often lists one device twice), they're marked `[#1]`, `[#2]`. Enable only one, or every message is handled twice.
3. Optionally rename the server (4-16 ASCII characters). The page starts with a unique default name such as `WebMBSP-3F2A`. Clients show this name and use discovery to find the server's MUID, which the page draws at random each time it loads and shows in the header.

### Running more than one server

Add `?instance=<name>` to the URL, for example `index.html?instance=A` and `index.html?instance=B`, to run several servers in one browser. Each instance has its own database, settings, server name and MUID, and its own port choices. Without it, every tab of the page shares one database.

## Files

| File | What it is |
|---|---|
| `index.html` | The page |
| `crt.css` | A copy of the CRT Vibe theme (`css-crt-vibe/crt.css`) |
| `js/mbsp-protocol.js` | Message codec: envelope, checksums, a builder and parser for every message type, query matching |
| `js/mbsp-server.js` | The server engine. It doesn't depend on MIDI or storage: feed it SysEx with `handleMessage()` and it calls `send()` |
| `js/mbsp-store.js` | Record storage: `IndexedDbStore` for the page, `MemoryStore` for tests |
| `js/mbsp-file.js` | The `.mbsp` database file format |
| `js/mbsp-selftest.js` | A virtual client that tests a server over an in-memory loopback |
| `js/app.js` | Page wiring: Web MIDI, GUI, settings |
| `test/run-tests.js` | Runs the self-test under Node: `node test/run-tests.js` |
| `test/browser-test.html` | Tests the IndexedDB store, then runs the self-test, in a browser (serve over localhost) |

All scripts are plain classic scripts that share one `MBSP` global, so there's no build step and they load under `file://`.

## The GUI

- **Server:** go online or offline, set the name and access key, refuse Store/Delete (read-only), refuse Delete, require that only the owning device may delete, set beacon mode, and change timing. Settings are saved in this browser.
- **Records:** search across name, number, device and tag, and filter by type, device (Device Identity + SysEx ID) or tag. Click a row to see its metadata and a hex dump of the payload. From there you can download the raw payload or delete the record.
- **Transfers:** shows Stores and Retrieves in progress.
- **Activity:** a decoded log of every message. Turn on *Show blocks + ignored* for data blocks and messages addressed to other servers, and *Show hex* for raw bytes.
- **Database:** export, import (merge or replace), clear, and **Run self-test**. The self-test runs against a separate in-memory server, so it never touches your records.

Deleting from the GUI is an admin action. It skips the protocol's Delete rules (read-only, owner check).

## How this server reads the spec

The spec leaves some details open. This server does the following:

| Topic | Behaviour |
|---|---|
| Message checksum | Roland: `(128 - (sum & 0x7F)) & 0x7F` over every byte after `F0` up to, but not including, the checksum byte |
| Full Payload Checksum | CRC-32 (IEEE 802.3 / zlib) over the re-assembled payload bytes, sent as five 7-bit bytes, LSB first |
| Payload encoding | Payload bytes are stored exactly as received. They are 7-bit because they travel inside SysEx. The spec leaves encoding to each device. |
| Malformed or non-v1 headers | Ignored silently, as the spec requires, except that DiscoverServers of any version is answered. A malformed MBSP header is logged as a warning. |
| OnlineServer | Lists Protocol Version 1, Policy Flags taken from the switches (read-only, Delete, owner check, firmware, Access Key), a Max Store Block Size of 16383 and Free Space from the browser's storage estimate (`0FFFFFFF`, not reported, in the self-test's memory store). Always sent as version 1. |
| Server-to-client messages (types 1, 2, 12, 21, 22, 31) | Ignored, so other servers' traffic and MIDI loopbacks are harmless |
| Addressing | Requests must be sent to this server's MUID. Messages for other MUIDs, and broadcast messages other than DiscoverServers, are ignored silently. Replies go from the server's MUID to the requesting Client's MUID. |
| MUID | Drawn at random when the page loads (a new one every time). A message that arrives with the server's own MUID as its Source, and isn't an echo of something the server sent in the last 3 s, is a collision: the server abandons open transfers, draws a new MUID, logs a warning and broadcasts OnlineServer. |
| Default name | `WebMBSP-` plus 4 random hex digits, saved with the settings, so two copies of the page on one network don't clash |
| Payload fails validation | Status 8, Invalid Request. This includes trailing bytes, out-of-range lengths, non-printable ASCII, Payload Type `7F` in a Store, NumBlocks 0, a Payload Size that can't fit in NumBlocks blocks of the Max Store Block Size, Device Match Mode above 3, and Max Results 0. |
| Payload Size | Store_Header and Retrieve_Header carry the payload's size. A Store whose blocks add up to more or less gets Status 8, Invalid Request. When the store reports its free space and the payload can't fit, the header is answered at once with Status 6, Storage Full, before any block is sent. |
| Unknown Message Type | Ignored silently (logged as a warning), as the spec requires |
| Replace Record ID | Store_Header field. Non-zero replaces that record: Not Found if it doesn't exist, Refused when read-only, Delete is switched off, or the owner check is on and the requester isn't the owner. The new payload and metadata are swapped in, in one database transaction, only after the last block passes its CRC-32, and the record keeps its ID. A Retrieve already in progress keeps sending the old version. |
| Lost final Status | The final Status of every Store (OK or error) is remembered for 10 s, up to 64 Stores. A block for a remembered Store, such as a Client resending its last block, gets the same Status again, with the same Record ID. |
| Data Block for an unknown transaction | Status 9, Unknown Transaction, when no open or remembered Store matches. |
| Store block larger than Max Store Block Size | Status 8, Invalid Request |
| A second Store Header with the same MUID + TID | Starts the transaction again and discards the earlier blocks |
| Status for Store errors | The Request Message Type is always 10 (Store Header), including for errors caused by a data block |
| Access Key | Applies to Store, Retrieve, Query and Delete, and is checked on the request that opens a transaction. Compared exactly (case and spaces count). With no key configured, any key is accepted. A wrong key gets Status 2 (Refused). DiscoverServers is always answered. Replies carry an empty access key. |
| Record IDs | Start at 1 and only ever count up: they are never reused after a Delete, a Clear or an import. They run up to `1FFFFF`; when they run out, Store gets Storage Full. Every Status for a replacing Store carries the Replace Record ID. |
| Retrieve block size | The smaller of the client's Max Block Size and the server's *Max block* setting. An empty payload is sent as one zero-length block. A Max Block Size so small that the payload would need more than 16383 blocks gets Status 8, Invalid Request. |
| Query results | In ascending Record ID order. A page with no results gets Status 1 (Not Found). Total Matches is capped at 16383. |
| Payload Types | Any type except `7F` (Any) and Category `3F` (reserved) can be stored, including reserved (`0F`-`2F`) and manufacturer-defined (`30`-`3E`) Categories, which are kept as opaque data. Query type filters match the whole byte, Collection bit included. |
| Firmware / OS (Category `0E`) | Refused (Status 2) unless **Accept firmware / OS stores** is switched on |
| Delete owner check | When on, the request's Device Identity (all 7 bytes) and SysEx ID must match the stored record's exactly |
| Flow control | Store: the server sends Store_Block_Ack ("send block n") after the header and after every block except the last, which gets the final Status. A repeat of the last accepted block gets the same ack again instead of an error. Retrieve: the server sends the header, then each block only when the client's Retrieve_Block_Ack asks for it; the client's ack for block NumBlocks closes the transfer. With no ack for 1 s the server resends its last message, up to 3 times, then gives up with Status 5 (Transaction Timeout). Query_Results are not acknowledged; *Result delay* paces them. |
| Concurrency | Up to 8 Stores and 4 Retrieves at once. Beyond that, the request gets Status 7 (Busy). |

## The .mbsp file

A binary, little-endian file holding the whole database. It's described field by field at the top of `js/mbsp-file.js`. In short:

- A header with the `MBSPDB` signature, format version 2, the export time, the next Record ID and the record count.
- Every record's metadata and payload.
- A CRC-32 over everything before it.

Format version 2 stores each record's CRC-32 Full Payload Checksum and checks it against the payload on import. Version 1 files (from before the CRC-32 change, with a 7-bit checksum) can still be imported: the CRC-32 is computed from the payload. Records saved in the browser before the change have no stored CRC-32, so the server computes it when they're retrieved.

The page refuses a file with a bad signature, an unknown version, a CRC mismatch or out-of-range fields, and leaves the database unchanged.

- **Import + replace:** the database becomes the file's contents, with the same Record IDs. New records continue after the highest Record ID either the file or this server has used.
- **Import + merge:** every imported record is added with a new Record ID, so IDs that clients already hold never point at different data.

## Known limits

- IndexedDB belongs to this browser profile and site. Clearing site data deletes the database, so export regularly.
- The tab must stay open for the server to answer. Browsers may slow timers in background tabs, which can trip the client's own timeouts during long Retrieves.
- MBSP uses the placeholder SysEx sub-ID `6A`, which is waiting on an MMA assignment.

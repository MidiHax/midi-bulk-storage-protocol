# MBSP Studio Client

A Node script that emulates a studio of 10 MIDI devices acting as MBSP clients. Each device randomly stores, queries, retrieves and deletes patches on an MBSP server, and every reply is checked against the protocol.

It reuses the codec in `../sample-server/js/mbsp-protocol.js`.

## Setup

```
npm install
npm run ports        # list the MIDI ports Node can see
npm start            # 100 random operations
node mbsp-studio.js --help
```

The MIDI library, `@julusian/midi`, ships prebuilt binaries for Windows, macOS and Linux, so you don't need a compiler.

## Wiring with Windows MIDI Services loopback

The `Loopback (A)` / `Loopback (B)` pair is cross-connected: whatever is sent on output A arrives on input B, and the reverse.

| | Sends on | Listens on |
|---|---|---|
| This client (defaults) | `Loopback (A)` | `Loopback (A)` |
| Server page | `Loopback (B)` | `Loopback (B)` |

On the server page, enable **only** `Loopback (B)` under both Inputs and Outputs. If the server has more than one input carrying the same traffic, it receives every request twice. Multi-block Stores then fail with `BLOCK_SEQUENCE_ERROR`, because the server rightly rejects the duplicate block. Any other enabled output also gets every reply, including outputs connected to real instruments.

## The studio

| Device | Manufacturer ID | SysEx ID | What it stores |
|---|---|---|---|
| Prophet A | 01 | 00 | Patches, tunings, calibration data |
| Prophet B | 01 (same model) | 01 | Patches, banks of patches. Tests telling two units of one model apart. |
| Juno-X | 41 | 10 | Patches, performances, banks of performances, system settings |
| Korg (no name) | 42 | not provided | Patches, combinations (Performance). Sends no Device Name and no SysEx ID. |
| DX7 II | 43 | 00 | Voices, 4 KB voice banks, performances, micro tunings, operator presets (manufacturer-defined Category `30`) |
| Digitakt | 00 20 3C | not provided | Drum kits, patterns, samples, global settings, 8-30 KB project files |
| Peak | 00 20 29 | 00 | Patches, tuning tables |
| Sub 37 | 04 | not provided | Patches, calibration data |
| Blofeld | 3E | 00 | Patches, multis, multi banks, wavetables |
| KeyStep Pro | 00 20 6B | not provided | Sequences, chains (Song), controller templates, set lists, config |

The manufacturer IDs are the real assigned ones. The family and model codes are made up. Between them the devices use every standard Payload Type Category except Unknown, Effects Program and Firmware. They use the Collection bit for banks and one manufacturer-defined Category.

## What it exercises

| Operation | Share | Checks |
|---|---|---|
| Store | 26% | Random sizes and block sizes (no larger than the Max Store Block Size from the server's OnlineServer), sent one block at a time as the server acks them (resent after 1 s of silence, up to 3 times). Expects OK and a Record ID. |
| Query | 24% | Nine filter variants: own unit, model, manufacturer, tag, name, type, number, paging, no-match. Every result must match the filter, indexes must be contiguous and IDs ascending. |
| Replace | 8% | Saves a new version (new bytes, new tags) over one of the device's own records with Replace Record ID. Expects OK with the same Record ID; later Retrieves check the new bytes. |
| Retrieve | 20% | Random Max Block Size. Acks the header and every block (and repeats the ack for a resent block). Checks the block size limit, that every block comes from the server's MUID, and the CRC-32, and for records stored by this run, every byte and every metadata field. |
| Delete | 10% | Own records (expects OK, then sometimes confirms with a Retrieve that returns NOT_FOUND) and other devices' records (expects REFUSED) |
| Faults | 7% | Bad payload checksum, a skipped block, retrieving a missing record, a request sent to a MUID nobody has (expects no reply), Max Results 0 (expects INVALID_REQUEST), a firmware Store (expects REFUSED, or OK if the server's OnlineServer Policy Flags say it accepts firmware), a Store_Data_Block with no open Store (expects UNKNOWN_TRANSACTION), an unknown Message Type (expects no reply), a lost final Status (resends the last block of a finished Store and expects the same OK and Record ID) |
| Discover | 5% | The target server answers under the same MUID. If its MUID has changed (the server page was reloaded), a WARN is reported and the client follows the new MUID. |

Each result is one of three:

- **PASS:** the reply was what the protocol requires.
- **WARN:** a legitimate answer caused by server settings, such as Busy, Refused because the server is read-only, or a foreign Delete allowed because the owner check is off.
- **FAIL:** a protocol violation or no reply.

The exit code is 1 if anything failed.

## Useful options

- `--ops 0` runs until Ctrl+C.
- `--concurrency 6` has more devices talking at the same time.
- `--seed N` repeats a run's random choices. The seed is printed at the end. With `--concurrency 1` the run repeats closely; with more devices at once, timing changes the order a little.
- `--cleanup` deletes everything this run stored.
- `--verbose` logs every message.

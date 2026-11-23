# MBSP Snapshot Panel (TouchOSC demo)

A TouchOSC panel with a handful of generic controls that saves snapshots of their positions to MBSP servers and loads them back. The controls do nothing else; the panel exists to show a small MBSP Client.

- **Controls:** 4 faders, 4 knobs, an XY pad, 4 toggles and a 4-way mode selector.
- **Discover:** finds every MBSP server on the MIDI connection and lists up to four. The panel also runs a discovery when it opens.
- **Server buttons:** pick which server Save and Load use. When only one server answers, it's chosen automatically. With two or more, you choose; that's what the spec asks of a Client.
- **SAVE:** snapshots the controls and stores them as a new record on the chosen server, named "Snapshot *n*" and numbered `001`, `002`, and so on.
- **LOAD:** lists the panel's snapshots on the chosen server, six at a time, with **Prev** and **Next**. Tap one to restore it.

## Files

| File | What it is |
|---|---|
| `MBSP-Snapshot-Panel.tosc` | The TouchOSC layout. Open it in TouchOSC. |
| `mbsp-panel.lua` | The panel's root script: all of the MBSP logic. It's embedded in the `.tosc`. |
| `build-panel.js` | Generates the `.tosc` from a layout table and `mbsp-panel.lua`. Run `npm run build` after editing either. |
| `test/run-panel-test.js` | Runs `mbsp-panel.lua` under a Lua VM (fengari) with a mock of the TouchOSC API, against two in-process MBSP servers. |

## Setup with two servers

1. Open the server page twice, as separate instances. Each instance gets its own database, settings, name and MUID:
   - `sample-server/index.html?instance=A`
   - `sample-server/index.html?instance=B`

   Without `?instance=`, two tabs of the page would share one database and one name, so they would not be two servers.
2. In each instance, connect MIDI and enable **Loopback (B)** as both input and output.
3. In TouchOSC, open `MBSP-Snapshot-Panel.tosc`. Under **Connections > MIDI**, set one connection to send to **Loopback (A)** and receive from **Loopback (A)**. With the Windows MIDI Services loopback pair, what TouchOSC sends on A arrives at the servers on B, and their replies on B arrive back on A. This is the same wiring the studio client uses.
4. Switch to play mode. The panel discovers both servers. Tap one, move some controls and tap **SAVE**.

The servers show the panel's records with Device Identity `7D / 0001 / 0001`. Manufacturer ID 7Dh is the MIDI ID reserved for non-commercial and educational use. The device name is "TouchOSC Panel", the type is Patch and the tag is "TouchOSC".

## How the script uses MBSP

- **MUID:** drawn at random when the panel opens. If a message arrives with the panel's own MUID as its source and isn't an echo of something the panel sent, the panel draws a new MUID.
- **Save:** a Query with Max Results 1 reads how many snapshots the panel already has, to number the new one. A Store then sends the snapshot, waiting for each Store_Block_Ack and resending after 1 s of silence, up to 3 times. The snapshot is 32 bytes, so it's always one block.
- **Load:** a Query filtered on this exact model and type Patch, six results per page. Tapping a row runs a Retrieve, acknowledging the header and every block. The CRC-32 is checked before anything is applied.
- **Snapshot format:** a format byte (1), a count, then one 14-bit value per control. Fader, knob, XY and toggle values are stored as 0-16383 for 0-1; the mode selector is stored as its index.
- **Lua 5.1 only:** TouchOSC's Lua has no bitwise operators, so CRC-32 and the 7-bit packing are done with arithmetic. 32-bit constants are written as floats.

## Testing

```
npm install
npm test
```

`npm test` rebuilds the `.tosc` and runs seven checks:
- discovery of both servers;
- Save to one server only, with the right metadata;
- a lost Store ack recovered by resending;
- Load and restore, comparing every control value;
- that the two servers are separate, plus paging through 8 snapshots;
- that every control the script refers to exists in the layout;
- that the `.tosc` file is valid zlib + XML.

The test checks the script and the protocol, but not TouchOSC itself. The `.tosc` file is generated from what is known about TouchOSC's file format and hasn't been opened in TouchOSC here. If a property doesn't come through as expected, such as a toggle behaving as a momentary button or a label's text size, adjust it in TouchOSC's editor; the script doesn't depend on those details.

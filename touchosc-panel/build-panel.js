// Builds MBSP-Snapshot-Panel.tosc: a TouchOSC layout with generic controls and the MBSP
// snapshot script (mbsp-panel.lua) as its root script.
//
//   node build-panel.js
//
// A .tosc file is zlib-compressed XML ("lexml" version 3). The layout is described as data
// below, so the panel can be regenerated after editing the script.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const W = 1280, H = 800;

// ---------- colours ----------
const C = {
  bg: [0.07, 0.08, 0.10, 1], panel: [0.12, 0.14, 0.17, 1], text: [0.85, 0.90, 0.95, 1], dim: [0.55, 0.62, 0.70, 1],
  fader: [0.20, 0.60, 0.95, 1], knob: [0.95, 0.60, 0.20, 1], xy: [0.70, 0.40, 0.95, 1], toggle: [0.25, 0.80, 0.45, 1],
  radio: [0.95, 0.80, 0.25, 1], action: [0.10, 0.75, 0.55, 1], quiet: [0.22, 0.26, 0.30, 1],
};

// A momentary button that tells the root script about a tap.
const notifyScript = (action, index) => `function onValueChanged(key)
  if key == "x" and self.values.x == 1 then root:notify("${action}"${index !== undefined ? ', ' + index : ''}) end
end`;

// ---------- layout ----------
function layout() {
  const nodes = [];
  const add = (type, name, frame, extra = {}) => { nodes.push({ type, name, frame, ...extra }); };
  const label = (name, frame, text, size = 18, color = C.text) => add('LABEL', name, frame, { text, textSize: size, textColor: color, interactive: false });
  // A button with a text label on top of it.
  const button = (name, frame, text, action, index, color = C.quiet) => {
    add('BUTTON', name, frame, { color, buttonType: 0, script: notifyScript(action, index) });
    label(name + 'Label', [frame[0] + 6, frame[1], frame[2] - 12, frame[3]], text, 18);
  };

  label('title', [20, 10, 560, 40], 'MBSP SNAPSHOT PANEL  (demo)', 24);
  label('muidLabel', [520, 10, 160, 40], 'MUID', 14, C.dim);

  // Generic controls: their values are what a snapshot captures.
  for (let i = 0; i < 4; i++) {
    add('FADER', `fader${i + 1}`, [20 + i * 85, 70, 70, 380], { color: C.fader, value: 0.5 });
    label(`fader${i + 1}Caption`, [20 + i * 85, 452, 70, 26], `F${i + 1}`, 14, C.dim);
  }
  for (let i = 0; i < 4; i++) {
    const x = 380 + (i % 2) * 150, y = 70 + Math.floor(i / 2) * 170;
    add('RADIAL', `knob${i + 1}`, [x, y, 130, 130], { color: C.knob, value: 0.5 });
    label(`knob${i + 1}Caption`, [x, y + 132, 130, 26], `K${i + 1}`, 14, C.dim);
  }
  add('XY', 'xy', [380, 410, 280, 250], { color: C.xy, value: 0.5, value2: 0.5 });
  for (let i = 0; i < 4; i++) add('BUTTON', `toggle${i + 1}`, [20 + i * 85, 500, 70, 60], { color: C.toggle, buttonType: 1 });
  label('toggleCaption', [20, 562, 340, 24], 'TOGGLES', 14, C.dim);
  add('RADIO', 'mode', [20, 600, 340, 60], { color: C.radio, steps: 4 });
  label('modeCaption', [20, 662, 340, 24], 'MODE', 14, C.dim);
  label('status', [20, 700, 400, 80], 'Starting...', 18, C.text);
  // Offers from a server: shown in the button labels only while one waits for an answer.
  button('accept', [430, 710, 120, 60], '', 'accept', undefined, C.action);
  button('decline', [560, 710, 120, 60], '', 'decline');

  // MBSP: servers, save / load, snapshot list.
  add('BOX', 'mbspPanel', [690, 50, 580, 740], { color: C.panel, interactive: false });
  label('serversHeading', [705, 58, 300, 36], 'SERVERS', 18, C.dim);
  button('discover', [1100, 58, 155, 36], 'Discover', 'discover');
  for (let i = 0; i < 4; i++) button(`server${i + 1}`, [705, 102 + i * 48, 550, 42], '', 'server', i + 1);
  button('save', [705, 300, 270, 60], 'SAVE', 'save', undefined, C.action);
  button('load', [985, 300, 270, 60], 'LOAD', 'load', undefined, C.action);
  label('snapshotsHeading', [705, 372, 300, 36], 'SNAPSHOTS', 18, C.dim);
  label('pageLabel', [1000, 372, 255, 36], '', 16, C.dim);
  for (let i = 0; i < 6; i++) button(`row${i + 1}`, [705, 414 + i * 48, 550, 42], '', 'row', i + 1);
  button('prev', [705, 712, 270, 50], '< Prev', 'prev');
  button('next', [985, 712, 270, 50], 'Next >', 'next');
  return nodes;
}

// ---------- lexml writer ----------
const cdata = s => `<![CDATA[${String(s).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
const prop = {
  s: (k, v) => `<property type='s'><key>${cdata(k)}</key><value>${cdata(v)}</value></property>`,
  b: (k, v) => `<property type='b'><key>${cdata(k)}</key><value>${v ? 1 : 0}</value></property>`,
  i: (k, v) => `<property type='i'><key>${cdata(k)}</key><value>${v}</value></property>`,
  f: (k, v) => `<property type='f'><key>${cdata(k)}</key><value>${v}</value></property>`,
  c: (k, [r, g, b, a]) => `<property type='c'><key>${cdata(k)}</key><value><r>${r}</r><g>${g}</g><b>${b}</b><a>${a}</a></value></property>`,
  r: (k, [x, y, w, h]) => `<property type='r'><key>${cdata(k)}</key><value><x>${x}</x><y>${y}</y><w>${w}</w><h>${h}</h></value></property>`,
};
const value = (k, def) => `<value><key>${cdata(k)}</key><locked>0</locked><lockedDefaultCurrent>0</lockedDefaultCurrent><default>${cdata(def)}</default><defaultPull>0</defaultPull></value>`;
const uuid = () => crypto.randomUUID();

function nodeXml(n) {
  const p = [prop.s('name', n.name), prop.r('frame', n.frame)];
  if (n.color) p.push(prop.c('color', n.color));
  if (n.interactive === false) p.push(prop.b('interactive', false));
  if (n.type === 'LABEL') p.push(prop.b('background', false)); // labels sit on top of buttons: don't hide their colour
  if (n.buttonType !== undefined) p.push(prop.i('buttonType', n.buttonType));
  if (n.steps !== undefined) p.push(prop.i('steps', n.steps));
  if (n.textSize !== undefined) p.push(prop.i('textSize', n.textSize));
  if (n.textColor) p.push(prop.c('textColor', n.textColor));
  if (n.script) p.push(prop.s('script', n.script));
  const v = [];
  if (n.type === 'LABEL') v.push(value('text', n.text || ''));
  else if (n.type !== 'BOX') {
    v.push(value('touch', 'false'));
    v.push(value('x', n.type === 'RADIO' ? '0' : String(n.value ?? 0)));
    if (n.type === 'XY') v.push(value('y', String(n.value2 ?? 0)));
  }
  return `<node ID='${uuid()}' type='${n.type}'><properties>${p.join('')}</properties><values>${v.join('')}</values><messages></messages><children></children></node>`;
}

function buildXml(script) {
  const rootProps = [prop.s('name', 'root'), prop.r('frame', [0, 0, W, H]), prop.c('color', C.bg), prop.b('background', true), prop.s('script', script)];
  const children = layout().map(nodeXml).join('');
  return `<?xml version='1.0' encoding='UTF-8'?><lexml version='3'><node ID='${uuid()}' type='GROUP'><properties>${rootProps.join('')}</properties><values></values><messages></messages><children>${children}</children></node></lexml>`;
}

if (require.main === module) {
  const script = fs.readFileSync(path.join(__dirname, 'mbsp-panel.lua'), 'utf8');
  const xml = buildXml(script);
  const out = path.join(__dirname, 'MBSP-Snapshot-Panel.tosc');
  fs.writeFileSync(out, zlib.deflateSync(Buffer.from(xml, 'utf8')));
  console.log(`Wrote ${out} (${layout().length} controls, ${xml.length} bytes of XML)`);
}

module.exports = { layout, buildXml };

// Runs the MBSP self-test under Node: node test/run-tests.js
'use strict';
const path = require('path');
for (const f of ['mbsp-protocol.js', 'mbsp-store.js', 'mbsp-file.js', 'mbsp-server.js', 'mbsp-selftest.js']) {
  require(path.join(__dirname, '..', 'js', f));
}
const MBSP = globalThis.MBSP;

MBSP.runSelfTest({ log: e => console.log(e.text) }).then(({ failed }) => {
  process.exitCode = failed ? 1 : 0;
});

// Runs every *.test.js in this directory in numeric order. Each test is
// spawned as a fresh Node process so wasm/worker_threads state stays
// isolated.
//
// Exit codes:
//   0  all tests passed
//   1  one or more tests failed (exit code 1 from the test)
//   2  one or more tests skipped because the dist is stale (exit code 2)
//
// Run with `npm test` after `npm install` here.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {runAll} = require('./lib/runner');

function main() {
  const files = fs.readdirSync(__dirname)
      .filter((f) => /^\d+-.*\.test\.js$/.test(f))
      .sort()
      .map((f) => path.join(__dirname, f));

  if (files.length === 0) {
    console.error('No *.test.js files found in', __dirname);
    process.exit(1);
  }

  console.log(`Running ${files.length} tests…\n`);
  const exit = runAll(files);
  process.exit(exit);
}

main();

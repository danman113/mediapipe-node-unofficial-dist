// Tiny zero-dep test runner. Each test file is a Node script that:
//   const t = require('./lib/runner').create('Test name');
//   t.assert(condition, 'message');
//   t.finish();   // exits with 0 on pass, 1 on fail
//
// `runAll` (used by run-all.js) spawns each *.test.js script as a child
// process and tallies pass/fail across the suite — keeps each test in
// its own process so wasm modules and worker threads don't share state.

'use strict';

const {spawnSync} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

function create(name) {
  const start = Date.now();
  let pass = 0;
  let fail = 0;
  const failures = [];

  function log(msg) {
    process.stdout.write(`  ${msg}\n`);
  }

  function assert(cond, msg) {
    if (cond) {
      pass++;
      log(`✓ ${msg}`);
    } else {
      fail++;
      failures.push(msg);
      log(`✗ ${msg}`);
    }
  }

  function fatal(msg, err) {
    fail++;
    failures.push(msg);
    log(`✗ ${msg}`);
    if (err) log(`  ${err.stack || err.message || err}`);
  }

  function finish() {
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    const status = fail === 0 ? 'PASS' : 'FAIL';
    console.log(
        `\n${status} — ${name}  (${pass} pass, ${fail} fail, ${elapsed}s)`);
    if (fail > 0) {
      console.log('Failures:');
      for (const f of failures) console.log('  - ' + f);
    }
    process.exit(fail === 0 ? 0 : 1);
  }

  console.log(`── ${name} ${'─'.repeat(Math.max(4, 60 - name.length))}`);
  return {assert, fatal, log, finish};
}

// Path resolution helpers — every test calls these so behavior is
// consistent and the messages identical when a fixture is missing.
function fixturesDir() {
  return path.join(__dirname, '..', 'fixtures');
}

function modelPath() {
  return process.env.MP_MODEL ||
      path.join(fixturesDir(), 'hand_landmarker.task');
}

function imagePath() {
  return process.env.MP_IMAGE ||
      path.join(fixturesDir(), 'pointing_up.jpg');
}

/**
 * Returns {model, image} after checking they exist. Calls
 * `process.exit(2)` with instructions if either is missing — exit code
 * 2 distinguishes "test infra problem" from "test failure" (exit 1).
 */
function requireFixtures() {
  const model = modelPath();
  const image = imagePath();
  const missing = [];
  if (!fs.existsSync(model)) missing.push(`model:  ${model}`);
  if (!fs.existsSync(image)) missing.push(`image:  ${image}`);
  if (missing.length > 0) {
    console.error('\nMissing fixtures:');
    for (const m of missing) console.error('  ' + m);
    console.error(
        '\nSee fixtures/README.md for how to obtain the model + a test image.');
    console.error('Or set MP_MODEL=/abs/path.task MP_IMAGE=/abs/path.jpg');
    process.exit(2);
  }
  return {model, image};
}

/**
 * Spawns child test scripts. Used by run-all.js.
 * Returns {name, code, durationMs} per child.
 */
function runAll(testFiles) {
  const results = [];
  for (const file of testFiles) {
    const start = Date.now();
    // Pass through env so MP_MODEL/MP_IMAGE/MP_NODE_FLAGS reach the child.
    // V8 flag for relaxed-simd on Node <22; harmless on Node 22+.
    const nodeArgs = ['--experimental-wasm-relaxed-simd', file];
    const result = spawnSync('node', nodeArgs, {stdio: 'inherit', env: process.env});
    results.push({
      name: path.basename(file, '.test.js'),
      code: result.status ?? 1,
      durationMs: Date.now() - start,
    });
  }
  const w = Math.max(...results.map((r) => r.name.length));
  const passed = results.filter((r) => r.code === 0).length;
  const failed = results.length - passed;
  console.log('\n────────── summary ──────────');
  for (const r of results) {
    const tag = r.code === 0 ? 'PASS' : r.code === 2 ? 'SKIP' : 'FAIL';
    console.log(`  [${tag}] ${r.name.padEnd(w + 2)}${(r.durationMs / 1000).toFixed(2)}s`);
  }
  console.log(`\n${passed} passed, ${failed} failed of ${results.length}`);
  return failed === 0 ? 0 : 1;
}

module.exports = {create, runAll, requireFixtures, modelPath, imagePath};

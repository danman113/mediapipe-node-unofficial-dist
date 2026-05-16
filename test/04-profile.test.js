// Verifies the profile API:
//   - setProfileEnabled toggles correctly
//   - getProfileStats returns the expected shim phases after some
//     detect() calls
//   - resetProfileStats clears them
//
// The API is a no-op when not enabled, so it's safe to leave imported.

'use strict';

const fs = require('node:fs');
const {create, requireFixtures} = require('./lib/runner');
const mp = require('@danman113/mediapipe-node');

async function main() {
  const t = create('profile');
  const {model, image} = requireFixtures();

  if (typeof mp.setProfileEnabled !== 'function' ||
      typeof mp.getProfileStats !== 'function' ||
      typeof mp.resetProfileStats !== 'function') {
    console.error('\nProfile API is not exported from this dist build.');
    console.error('Rebuild the dist:  node ../build.js');
    process.exit(2);
  }
  t.assert(true, 'profile API exported (set/get/reset)');

  let detector;
  try {
    // Off by default — running detect shouldn't record anything.
    mp.setProfileEnabled(false);
    mp.resetProfileStats();
    t.assert(mp.isProfileEnabled() === false, 'profile starts disabled');

    const fileset = await mp.FilesetResolver.forVisionTasks();
    detector = await mp.createHandLandmarker(fileset, {
      baseOptions: {modelAssetPath: model},
      numHands: 2,
      runningMode: 'IMAGE',
    });
    const imageData = await mp.decodeImageBuffer(fs.readFileSync(image));

    // Warmup with profiling off, sanity-check buckets are empty
    detector.detect(imageData);
    let stats = mp.getProfileStats();
    t.assert(stats.length === 0,
             `no stats accumulated when disabled (got ${stats.length})`);

    // Now enable and run a few frames
    mp.setProfileEnabled(true);
    t.assert(mp.isProfileEnabled() === true, 'profile enabled after setProfileEnabled(true)');
    mp.resetProfileStats();
    const N = 5;
    for (let i = 0; i < N; i++) detector.detect(imageData);

    stats = mp.getProfileStats();
    t.assert(stats.length >= 3,
             `at least 3 phases recorded (got ${stats.length})`);

    const names = stats.map((r) => r.phase);
    const expectedPhases = ['shim.malloc', 'shim.heapCopy', 'shim.wasmPush', 'shim.free'];
    let missingShim = 0;
    for (const p of expectedPhases) {
      if (!names.includes(p)) missingShim++;
    }
    t.assert(missingShim === 0,
             `all four shim phases present (missing ${missingShim} of ${expectedPhases.length})`);

    for (const r of stats) {
      t.log(`${r.phase.padEnd(20)}  count=${r.count}  mean=${(r.meanMicros / 1000).toFixed(3)}ms`);
      t.assert(r.count === N || r.phase === 'shim.wasmPush' || r.count > 0,
               `${r.phase}: count > 0`);
    }

    // Reset should clear
    mp.resetProfileStats();
    stats = mp.getProfileStats();
    t.assert(stats.length === 0,
             `stats empty after resetProfileStats (got ${stats.length})`);
  } catch (err) {
    t.fatal('exception during profile run', err);
  } finally {
    if (detector) {
      try { detector.close(); } catch (_) {}
    }
    try { mp.setProfileEnabled(false); } catch (_) {}
  }

  t.finish();
}

main();

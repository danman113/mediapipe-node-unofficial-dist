// Verifies the `numThreads` option on createHandLandmarker:
//   (a) is wired through (no crash, detector still works)
//   (b) actually changes inference latency (more threads = lower p50)
//   (c) produces the same landmarks regardless of thread count
//
// Skips with a clear note if the wasm bundle predates the Tier-11
// thread-override export (i.e. dist is stale — rerun `node ../build.js`).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {create, requireFixtures} = require('./lib/runner');
const mp = require('@danman113/mediapipe-node');

function stats(timings) {
  const sorted = [...timings].sort((a, b) => a - b);
  return {
    min: sorted[0],
    p50: sorted[Math.floor(sorted.length * 0.5)],
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
  };
}

async function runAt(numThreads, model, imageData) {
  const fileset = await mp.FilesetResolver.forVisionTasks();
  const detector = await mp.createHandLandmarker(fileset, {
    baseOptions: {modelAssetPath: model},
    numHands: 2,
    runningMode: 'IMAGE',
    numThreads,
  });
  try {
    // 3 warmup + 20 timed runs — small enough to be quick, large enough
    // to show the threading delta clearly.
    for (let i = 0; i < 3; i++) detector.detect(imageData);
    const timings = [];
    let lastResult = null;
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      lastResult = detector.detect(imageData);
      timings.push(performance.now() - t0);
    }
    return {stats: stats(timings), result: lastResult};
  } finally {
    detector.close();
  }
}

function landmarksClose(a, b, tol = 1e-4) {
  if (!a || !b) return false;
  if (a.landmarks.length !== b.landmarks.length) return false;
  let max = 0;
  for (let h = 0; h < a.landmarks.length; h++) {
    for (let i = 0; i < a.landmarks[h].length; i++) {
      max = Math.max(max,
          Math.abs(a.landmarks[h][i].x - b.landmarks[h][i].x),
          Math.abs(a.landmarks[h][i].y - b.landmarks[h][i].y),
          Math.abs(a.landmarks[h][i].z - b.landmarks[h][i].z));
    }
  }
  return max <= tol;
}

async function main() {
  const t = create('num-threads');
  const {model, image} = requireFixtures();
  const imageData = await mp.decodeImageBuffer(fs.readFileSync(image));

  try {
    const one = await runAt(1, model, imageData);
    const four = await runAt(4, model, imageData);

    t.log(`numThreads=1  min=${one.stats.min.toFixed(1)}ms  p50=${one.stats.p50.toFixed(1)}ms`);
    t.log(`numThreads=4  min=${four.stats.min.toFixed(1)}ms  p50=${four.stats.p50.toFixed(1)}ms`);

    t.assert(one.result.landmarks.length >= 1,
             '1-thread run detected a hand');
    t.assert(four.result.landmarks.length >= 1,
             '4-thread run detected a hand');

    // 4-thread p50 should be strictly less than 1-thread p50. We give it
    // a generous tolerance — even an absurdly contended host should show
    // 4 threads being at least 1.3× faster than 1 thread on this model.
    const speedup = one.stats.p50 / four.stats.p50;
    t.log(`p50 speedup 1→4 threads: ${speedup.toFixed(2)}×`);
    t.assert(speedup > 1.3,
             `4 threads should be >1.3× faster than 1 (got ${speedup.toFixed(2)}×)`);

    // Landmarks must agree across thread counts — XNNPack is deterministic.
    t.assert(landmarksClose(one.result, four.result, 1e-4),
             'landmarks match across thread counts within 1e-4');
  } catch (err) {
    if (/numThreads/i.test(String(err)) ||
        /_setNodeXnnpackNumThreads/i.test(String(err))) {
      console.error('\nNumber-of-threads override is not in this wasm bundle.');
      console.error('Rebuild the dist:  node ../build.js');
      process.exit(2);
    }
    t.fatal('exception during num-threads run', err);
  }

  t.finish();
}

main();

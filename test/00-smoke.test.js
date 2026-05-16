// Baseline: load the model, decode an image, detect once. If this passes,
// the package's basic happy path works. If it fails, nothing else will.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {create, requireFixtures} = require('./lib/runner');
const mp = require('@danman113/mediapipe-node');

async function main() {
  const t = create('smoke');
  const {model, image} = requireFixtures();

  t.assert(typeof mp.FilesetResolver === 'function' ||
               typeof mp.FilesetResolver === 'object',
           'mp.FilesetResolver exported');
  t.assert(typeof mp.createHandLandmarker === 'function',
           'mp.createHandLandmarker exported');
  t.assert(typeof mp.decodeImageBuffer === 'function',
           'mp.decodeImageBuffer exported');

  let detector;
  try {
    const fileset = await mp.FilesetResolver.forVisionTasks();
    t.assert(!!fileset, 'forVisionTasks returns a fileset');

    detector = await mp.createHandLandmarker(fileset, {
      baseOptions: {modelAssetPath: model},
      numHands: 2,
      runningMode: 'IMAGE',
    });
    t.assert(!!detector, 'createHandLandmarker returns a detector');
    t.assert(typeof detector.detect === 'function', 'detector has .detect()');

    const buf = fs.readFileSync(image);
    const imageData = await mp.decodeImageBuffer(buf);
    t.assert(imageData && imageData.data && imageData.width && imageData.height,
             'decodeImageBuffer returns ImageData shape');

    const result = detector.detect(imageData);
    t.assert(!!result, 'detect returns a result');
    t.assert(Array.isArray(result.landmarks),
             'result.landmarks is an array');
    t.assert(result.landmarks.length >= 1,
             `detected >=1 hand (got ${result.landmarks.length})`);

    if (result.landmarks.length >= 1) {
      const lm = result.landmarks[0];
      t.assert(lm.length === 21, `first hand has 21 landmarks (got ${lm.length})`);
      const inRange = lm.every(
          (p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
      t.assert(inRange, 'all x,y landmarks within [0,1] normalized range');
    }
  } catch (err) {
    t.fatal('exception during smoke run', err);
  } finally {
    if (detector) {
      try { detector.close(); } catch (_) {}
    }
  }

  t.finish();
}

main();

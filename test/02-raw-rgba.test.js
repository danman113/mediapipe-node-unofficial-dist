// Verifies createImageData (raw-RGBA passthrough). This API lets callers
// who already have pixels in RGBA memory (ffmpeg `-pix_fmt rgba`, sharp,
// camera frame buffer, etc.) skip the node-canvas PNG/JPEG decode path.
//
// Tests:
//   (a) export exists
//   (b) shape-mismatch input throws
//   (c) round-trip through node-canvas decode + createImageData wrap is
//       bit-identical (same RGBA bytes → same landmarks → max delta 0)
//   (d) raw wrap is significantly faster than the decode path

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {create, requireFixtures} = require('./lib/runner');
const mp = require('@danman113/mediapipe-node');

async function main() {
  const t = create('raw-rgba');
  const {model, image} = requireFixtures();

  if (typeof mp.createImageData !== 'function') {
    console.error(
        '\nmp.createImageData is not exported from this dist build.');
    console.error('Rebuild the dist:  node ../build.js');
    process.exit(2);
  }
  t.assert(true, 'mp.createImageData exported');

  // (b) shape-mismatch input
  try {
    mp.createImageData(new Uint8ClampedArray(10), 4, 4);
    t.fatal('expected length-mismatch to throw');
  } catch (err) {
    t.assert(/length/i.test(String(err)),
             'length-mismatch throws with a useful message');
  }

  // (c) bit-identical landmarks through both paths
  let detector;
  try {
    const fileset = await mp.FilesetResolver.forVisionTasks();
    detector = await mp.createHandLandmarker(fileset, {
      baseOptions: {modelAssetPath: model},
      numHands: 2,
      runningMode: 'IMAGE',
    });

    const buf = fs.readFileSync(image);
    const decoded = await mp.decodeImageBuffer(buf);
    const decodedResult = detector.detect(decoded);

    const wrapped = mp.createImageData(decoded.data, decoded.width,
                                        decoded.height);
    t.assert(wrapped.width === decoded.width && wrapped.height === decoded.height,
             'wrap preserves width/height');
    t.assert(wrapped.data.length === decoded.data.length,
             'wrap preserves data length');

    const wrappedResult = detector.detect(wrapped);
    t.assert(wrappedResult.landmarks.length === decodedResult.landmarks.length,
             'same hand count via both paths');

    let maxDelta = 0;
    for (let h = 0; h < decodedResult.landmarks.length; h++) {
      for (let i = 0; i < decodedResult.landmarks[h].length; i++) {
        const a = decodedResult.landmarks[h][i];
        const b = wrappedResult.landmarks[h][i];
        maxDelta = Math.max(maxDelta,
                            Math.abs(a.x - b.x),
                            Math.abs(a.y - b.y),
                            Math.abs(a.z - b.z));
      }
    }
    t.log(`landmark max delta (decoded vs raw-wrap): ${maxDelta.toExponential(3)}`);
    t.assert(maxDelta === 0,
             'createImageData produces bit-identical landmarks (delta 0)');

    // (d) timing
    const N = 30;
    let tDecode = 0, tWrap = 0;
    const rgbaCopy = new Uint8ClampedArray(decoded.data);
    for (let i = 0; i < N; i++) {
      const a = performance.now();
      await mp.decodeImageBuffer(buf);
      tDecode += performance.now() - a;
      const b = performance.now();
      mp.createImageData(rgbaCopy, decoded.width, decoded.height);
      tWrap += performance.now() - b;
    }
    const decodeMs = tDecode / N;
    const wrapMs = tWrap / N;
    t.log(`decodeImageBuffer mean : ${decodeMs.toFixed(2)}ms`);
    t.log(`createImageData mean   : ${wrapMs.toFixed(3)}ms`);
    t.log(`savings per frame      : ${(decodeMs - wrapMs).toFixed(2)}ms`);
    t.assert(wrapMs < decodeMs * 0.1,
             `raw wrap is >10× faster than decode (${(decodeMs/wrapMs).toFixed(1)}×)`);
  } catch (err) {
    t.fatal('exception during raw-rgba run', err);
  } finally {
    if (detector) {
      try { detector.close(); } catch (_) {}
    }
  }

  t.finish();
}

main();

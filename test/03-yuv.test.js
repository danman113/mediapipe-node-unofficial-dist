// Verifies decodeYuvBuffer — libyuv-backed YUV→RGBA conversion that runs
// inside the wasm. This is the input path for video pipelines that have
// NV12 / NV21 / I420 frames (ffmpeg `-pix_fmt nv12`, hardware H.264
// decode, WebRTC, mobile cameras) without paying the cost of a JS-side
// conversion loop.
//
// Tests:
//   (a) export exists
//   (b) NV12 round-trip lands within YUV chroma quantization tolerance
//   (c) supports all three documented formats (nv12, nv21, i420)
//   (d) odd width/height rejected with a useful error

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {create, requireFixtures} = require('./lib/runner');
const mp = require('@danman113/mediapipe-node');

// BT.601 limited-range RGBA → NV12 (matches what ffmpeg's `-pix_fmt nv12`
// produces). Used as the encode side of the round-trip — libyuv decodes
// on the other side.
function rgbaToNv12(rgba, width, height) {
  const yLen = width * height;
  const out = new Uint8Array(yLen * 3 / 2);
  // Y
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const Y = (0.257 * rgba[i] + 0.504 * rgba[i + 1] + 0.098 * rgba[i + 2] + 16) | 0;
      out[y * width + x] = Y < 0 ? 0 : Y > 255 ? 255 : Y;
    }
  }
  // UV, averaged over 2x2
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      let rSum = 0, gSum = 0, bSum = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const i = ((y + dy) * width + (x + dx)) * 4;
          rSum += rgba[i]; gSum += rgba[i + 1]; bSum += rgba[i + 2];
        }
      }
      const r = rSum / 4, g = gSum / 4, b = bSum / 4;
      const U = (-0.148 * r - 0.291 * g + 0.439 * b + 128) | 0;
      const V = (0.439 * r - 0.368 * g - 0.071 * b + 128) | 0;
      const uvIdx = yLen + (y / 2) * width + x;
      out[uvIdx] = U < 0 ? 0 : U > 255 ? 255 : U;
      out[uvIdx + 1] = V < 0 ? 0 : V > 255 ? 255 : V;
    }
  }
  return out;
}

// NV21 = NV12 with V and U swapped in the chroma plane.
function nv12ToNv21(nv12, width, height) {
  const out = new Uint8Array(nv12);
  const yLen = width * height;
  for (let i = yLen; i < out.length; i += 2) {
    const u = out[i]; out[i] = out[i + 1]; out[i + 1] = u;
  }
  return out;
}

// I420 = NV12's UV plane de-interleaved into separate U and V planes.
function nv12ToI420(nv12, width, height) {
  const yLen = width * height;
  const uvW = width / 2;
  const uvH = height / 2;
  const out = new Uint8Array(nv12.length);
  out.set(nv12.subarray(0, yLen), 0);
  const uOff = yLen;
  const vOff = yLen + uvW * uvH;
  for (let y = 0; y < uvH; y++) {
    for (let x = 0; x < uvW; x++) {
      const srcIdx = yLen + y * width + x * 2;
      out[uOff + y * uvW + x] = nv12[srcIdx];
      out[vOff + y * uvW + x] = nv12[srcIdx + 1];
    }
  }
  return out;
}

function maxLandmarkDelta(a, b) {
  if (a.landmarks.length !== b.landmarks.length) return Infinity;
  let max = 0;
  for (let h = 0; h < a.landmarks.length; h++) {
    for (let i = 0; i < a.landmarks[h].length; i++) {
      const la = a.landmarks[h][i], lb = b.landmarks[h][i];
      max = Math.max(max,
                     Math.abs(la.x - lb.x),
                     Math.abs(la.y - lb.y),
                     Math.abs(la.z - lb.z));
    }
  }
  return max;
}

async function main() {
  const t = create('yuv');
  const {model, image} = requireFixtures();

  if (typeof mp.decodeYuvBuffer !== 'function') {
    console.error('\nmp.decodeYuvBuffer is not exported from this dist build.');
    console.error('Rebuild the dist:  node ../build.js');
    process.exit(2);
  }
  t.assert(true, 'mp.decodeYuvBuffer exported');

  let detector;
  try {
    const fileset = await mp.FilesetResolver.forVisionTasks();
    detector = await mp.createHandLandmarker(fileset, {
      baseOptions: {modelAssetPath: model},
      numHands: 2,
      runningMode: 'IMAGE',
    });

    // Decode the JPEG to RGBA via node-canvas (reference).
    const buf = fs.readFileSync(image);
    let rgbaRef = await mp.decodeImageBuffer(buf);
    // 4:2:0 chroma subsampling requires even dimensions; crop if needed.
    if (rgbaRef.width & 1 || rgbaRef.height & 1) {
      const w = rgbaRef.width & ~1, h = rgbaRef.height & ~1;
      const cropped = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        cropped.set(rgbaRef.data.subarray(y * rgbaRef.width * 4,
                                          y * rgbaRef.width * 4 + w * 4),
                    y * w * 4);
      }
      rgbaRef = mp.createImageData(cropped, w, h);
    }

    const refResult = detector.detect(rgbaRef);
    t.assert(refResult.landmarks.length >= 1,
             'reference (RGBA) path detected a hand');

    // (d) odd-dimensions rejection
    try {
      mp.decodeYuvBuffer(detector, new Uint8Array(15), 3, 2, 'nv12');
      t.fatal('expected odd-dimensions to throw');
    } catch (err) {
      t.assert(/even|odd|width|height/i.test(String(err)),
               'odd width/height throws with a useful message');
    }

    // (b) NV12 round-trip
    const nv12 = rgbaToNv12(rgbaRef.data, rgbaRef.width, rgbaRef.height);
    const nv12Img = mp.decodeYuvBuffer(detector, nv12, rgbaRef.width,
                                        rgbaRef.height, 'nv12');
    t.assert(nv12Img.width === rgbaRef.width && nv12Img.height === rgbaRef.height,
             'NV12 decode preserves dimensions');
    const nv12Result = detector.detect(nv12Img);
    const nv12Delta = maxLandmarkDelta(refResult, nv12Result);
    t.log(`landmark max delta NV12 vs reference: ${nv12Delta.toExponential(3)}`);
    // YUV 4:2:0 chroma subsampling is lossy by design — half the chroma
    // bandwidth. 5e-3 is the realistic tolerance for hand_landmarker.
    t.assert(nv12Delta < 5e-3, `NV12 round-trip within 5e-3 (got ${nv12Delta.toExponential(2)})`);

    // (c) NV21
    const nv21 = nv12ToNv21(nv12, rgbaRef.width, rgbaRef.height);
    const nv21Img = mp.decodeYuvBuffer(detector, nv21, rgbaRef.width,
                                        rgbaRef.height, 'nv21');
    const nv21Result = detector.detect(nv21Img);
    const nv21Delta = maxLandmarkDelta(nv12Result, nv21Result);
    t.log(`landmark max delta NV12 vs NV21: ${nv21Delta.toExponential(3)}`);
    t.assert(nv21Delta < 1e-3,
             `NV12 and NV21 should give the same landmarks (got ${nv21Delta.toExponential(2)})`);

    // (c) I420
    const i420 = nv12ToI420(nv12, rgbaRef.width, rgbaRef.height);
    const i420Img = mp.decodeYuvBuffer(detector, i420, rgbaRef.width,
                                        rgbaRef.height, 'i420');
    const i420Result = detector.detect(i420Img);
    const i420Delta = maxLandmarkDelta(nv12Result, i420Result);
    t.log(`landmark max delta NV12 vs I420: ${i420Delta.toExponential(3)}`);
    t.assert(i420Delta < 1e-3,
             `NV12 and I420 should give the same landmarks (got ${i420Delta.toExponential(2)})`);

    // Quick timing sample
    const N = 20;
    let total = 0;
    for (let i = 0; i < N; i++) {
      const a = performance.now();
      mp.decodeYuvBuffer(detector, nv12, rgbaRef.width, rgbaRef.height, 'nv12');
      total += performance.now() - a;
    }
    t.log(`decodeYuvBuffer mean over ${N} calls: ${(total / N).toFixed(3)}ms (${rgbaRef.width}x${rgbaRef.height} NV12)`);
  } catch (err) {
    t.fatal('exception during yuv run', err);
  } finally {
    if (detector) {
      try { detector.close(); } catch (_) {}
    }
  }

  t.finish();
}

main();

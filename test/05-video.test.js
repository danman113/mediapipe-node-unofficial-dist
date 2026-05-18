// Verifies the native video API: openVideo (async iterator),
// detectVideoFile (one-call helper), and resolveFfmpegBinary.
//
// The test synthesizes a 1-second 30 fps MP4 from the existing hand JPEG
// fixture, so no extra video file is needed. ffmpeg-static is used both
// to synthesize the fixture and as the library's ffmpeg source.
//
// Tests:
//   (a) exports exist (otherwise SKIP — dist is stale)
//   (b) resolveFfmpegBinary returns a usable path
//   (c) openVideo() iterator yields the expected frame count, each with
//       the right dimensions, monotonic tsMs, and ImageData shape
//   (d) detectVideoFile() returns one result per frame; landmarks match
//       the reference RGBA path within YUV chroma quantization tolerance
//   (e) breaking early out of the iterator doesn't hang
//   (f) Readable stream input yields the same frame count
//   (g) opening a non-existent path throws

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {create, requireFixtures} = require('./lib/runner');
const mp = require('@danman113/mediapipe-node');

const TARGET_FRAMES = 30;     // 1s @ 30fps
const TARGET_FPS = 30;

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

/**
 * Builds a short MP4 from `imagePath` by looping the still image for
 * `frames` frames at `fps`. Uses ffmpeg-static directly (not the
 * library's openVideo) — we want the test fixture build to be independent
 * of the API under test.
 */
function synthesizeVideo(ffmpegBinary, imagePath, frames, fps, outPath) {
  const args = [
    '-y',
    '-loglevel', 'error',
    '-loop', '1',
    '-i', imagePath,
    '-t', String(frames / fps),
    '-r', String(fps),
    // h264 / yuv420p requires even dimensions; this scale filter clamps
    // odd dimensions down by one pixel to keep ffmpeg happy regardless of
    // the source image size.
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264',
    outPath,
  ];
  const result = spawnSync(ffmpegBinary, args, {encoding: 'utf8'});
  if (result.status !== 0) {
    throw new Error(
        `ffmpeg failed to synthesize ${outPath}\n` +
        `args: ${args.join(' ')}\nstderr:\n${result.stderr}`);
  }
}

async function main() {
  const t = create('video');
  const {model, image} = requireFixtures();

  // (a) exports — if missing, the dist hasn't been rebuilt with the
  // video API. Mirror the SKIP convention from 03-yuv / 04-profile.
  const missingExports =
      ['openVideo', 'detectVideoFile', 'resolveFfmpegBinary']
          .filter((name) => typeof mp[name] !== 'function');
  if (missingExports.length > 0) {
    console.error(
        '\nmissing video API exports: ' + missingExports.join(', '));
    console.error('Rebuild the dist:  node ../build.js');
    process.exit(2);
  }
  t.assert(true, 'openVideo / detectVideoFile / resolveFfmpegBinary exported');

  // ffmpeg-static is an optional peer for the library, but mandatory for
  // this test because we synthesize a video fixture from the JPEG.
  let ffmpegBinary;
  try {
    ffmpegBinary = require('ffmpeg-static');
    if (typeof ffmpegBinary !== 'string') {
      ffmpegBinary = ffmpegBinary && ffmpegBinary.default;
    }
  } catch (err) {
    // ignored — fall through to skip
  }
  if (!ffmpegBinary || !fs.existsSync(ffmpegBinary)) {
    console.error(
        '\nffmpeg-static is not installed in this test dir.');
    console.error('Run:  npm install ffmpeg-static');
    process.exit(2);
  }

  // (b) resolveFfmpegBinary path resolution
  const resolved = mp.resolveFfmpegBinary();
  t.assert(typeof resolved === 'string' && resolved.length > 0,
           `resolveFfmpegBinary() returns "${resolved}"`);
  t.assert(mp.resolveFfmpegBinary('/totally/bogus/ffmpeg') === '/totally/bogus/ffmpeg',
           'resolveFfmpegBinary honours the override argument');

  // Build the per-test fixture in OS tmpdir (cleaned up on process exit).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-video-test-'));
  const videoPath = path.join(tmpDir, 'synth.mp4');
  try {
    synthesizeVideo(ffmpegBinary, image, TARGET_FRAMES, TARGET_FPS, videoPath);
  } catch (err) {
    t.fatal('failed to synthesize test video', err);
    t.finish();
    return;
  }
  t.log(`synthesized ${TARGET_FRAMES}-frame fixture: ${videoPath}`);

  let detector;
  try {
    const fileset = await mp.FilesetResolver.forVisionTasks();
    detector = await mp.createHandLandmarker(fileset, {
      baseOptions: {modelAssetPath: model},
      numHands: 2,
      runningMode: 'VIDEO',
    });

    // Reference detection through the existing RGBA path. This is what
    // every video frame should approximately match (within YUV chroma
    // quantization tolerance, since openVideo's default goes through NV12).
    const referenceDetector = await mp.createHandLandmarker(fileset, {
      baseOptions: {modelAssetPath: model},
      numHands: 2,
      runningMode: 'IMAGE',
    });
    const buf = fs.readFileSync(image);
    let refImage = await mp.decodeImageBuffer(buf);
    // The scale filter above may have shaved a pixel off odd dims; crop
    // the reference to the same dimensions for an apples-to-apples diff.
    if (refImage.width & 1 || refImage.height & 1) {
      const w = refImage.width & ~1, h = refImage.height & ~1;
      const cropped = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        cropped.set(refImage.data.subarray(y * refImage.width * 4,
                                            y * refImage.width * 4 + w * 4),
                    y * w * 4);
      }
      refImage = mp.createImageData(cropped, w, h);
    }
    const refResult = referenceDetector.detect(refImage);
    referenceDetector.close();
    t.assert(refResult.landmarks.length >= 1,
             'reference (RGBA) detected a hand in the source image');

    // (c) iterator: frame count, dims, monotonic timestamps, ImageData shape
    let count = 0;
    let prevTs = -1;
    let firstFrame = null;
    let badDim = 0, badTs = 0, badShape = 0;
    for await (const frame of mp.openVideo(videoPath, {detector})) {
      count++;
      if (frame.width !== refImage.width || frame.height !== refImage.height) {
        badDim++;
      }
      if (!(frame.tsMs > prevTs)) badTs++;
      prevTs = frame.tsMs;
      if (!frame.imageData ||
          frame.imageData.data.length !== frame.width * frame.height * 4) {
        badShape++;
      }
      if (!firstFrame) firstFrame = frame;
    }
    t.assert(count === TARGET_FRAMES,
             `iterator yielded ${TARGET_FRAMES} frames (got ${count})`);
    t.assert(badDim === 0,
             `all frames have w=${refImage.width} h=${refImage.height} (${badDim} mismatches)`);
    t.assert(badTs === 0, `timestamps strictly monotonic (${badTs} regressions)`);
    t.assert(badShape === 0,
             `ImageData shape correct on every frame (${badShape} mismatches)`);
    if (firstFrame) {
      const expectedStep = 1000 / TARGET_FPS;
      // First frame should be at tsMs=0; nth at n*step. Loose tolerance
      // because the iterator computes from index, not PTS.
      t.assert(Math.abs(firstFrame.tsMs - 0) < 1e-6,
               `first frame tsMs is 0 (got ${firstFrame.tsMs})`);
      const lastExpected = (TARGET_FRAMES - 1) * expectedStep;
      t.assert(Math.abs(prevTs - lastExpected) < 1e-6,
               `last frame tsMs is ${lastExpected} (got ${prevTs.toFixed(3)})`);
    }

    // (d) detectVideoFile correctness — N results, hand detected on each,
    // landmark diff vs reference within YUV chroma tolerance.
    const results = await mp.detectVideoFile(detector, videoPath, {
      fps: TARGET_FPS,
    });
    t.assert(results.length === TARGET_FRAMES,
             `detectVideoFile returned ${TARGET_FRAMES} results (got ${results.length})`);
    const frameWithHands = results.filter((r) => r.landmarks.length >= 1).length;
    t.assert(frameWithHands === TARGET_FRAMES,
             `every frame detected a hand (${frameWithHands}/${TARGET_FRAMES})`);
    const videoDelta = maxLandmarkDelta(refResult, results[0]);
    t.log(`landmark max delta video[0] vs RGBA reference: ${videoDelta.toExponential(3)}`);
    // Same tolerance as 03-yuv.test.js — NV12 chroma subsampling is lossy
    // by design plus h264 quantization adds a bit more noise.
    t.assert(videoDelta < 2e-2,
             `video[0] vs reference within 2e-2 (got ${videoDelta.toExponential(2)})`);

    // (e) cancellation — break early, ensure no hang
    let earlySeen = 0;
    const breakAt = 3;
    const tStart = Date.now();
    for await (const _frame of mp.openVideo(videoPath, {detector})) {
      void _frame;
      earlySeen++;
      if (earlySeen >= breakAt) break;
    }
    const breakElapsed = Date.now() - tStart;
    t.assert(earlySeen === breakAt,
             `early break stopped at ${breakAt} frames (got ${earlySeen})`);
    t.log(`early break + teardown took ${breakElapsed}ms`);

    // (f) Readable stream input
    let streamCount = 0;
    for await (const _frame of mp.openVideo(fs.createReadStream(videoPath),
                                            {detector})) {
      void _frame;
      streamCount++;
    }
    t.assert(streamCount === TARGET_FRAMES,
             `Readable stream input yielded ${TARGET_FRAMES} frames (got ${streamCount})`);

    // (g) helpful error on missing path
    let threw = false;
    try {
      // tslint:disable-next-line:no-unused-expression
      for await (const _frame of mp.openVideo('/no/such/video.mp4',
                                              {detector})) {
        void _frame;
      }
    } catch (err) {
      threw = true;
      t.log(`non-existent input threw: ${String(err).split('\n')[0]}`);
    }
    t.assert(threw, 'openVideo on non-existent path throws');

    // RGBA fallback path (no detector): library asks ffmpeg for rgba
    // directly and bypasses libyuv. Verifies the alternate code path.
    let rgbaCount = 0;
    for await (const frame of mp.openVideo(videoPath, {pixelFormat: 'rgba'})) {
      rgbaCount++;
      if (rgbaCount === 1) {
        t.assert(frame.imageData.data.length === frame.width * frame.height * 4,
                 'rgba-mode frame has w*h*4 bytes');
      }
    }
    t.assert(rgbaCount === TARGET_FRAMES,
             `rgba-mode iterator yielded ${TARGET_FRAMES} frames (got ${rgbaCount})`);
  } catch (err) {
    t.fatal('exception during video run', err);
  } finally {
    if (detector) {
      try { detector.close(); } catch (_) {}
    }
    try { fs.rmSync(tmpDir, {recursive: true, force: true}); } catch (_) {}
  }

  t.finish();
}

main();

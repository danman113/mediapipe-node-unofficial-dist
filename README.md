# @mediapipe/tasks-vision-node

Stage 1 (POC) Node.js target for MediaPipe Vision Tasks. Currently exposes
`HandLandmarker` against the upstream-prebuilt `vision_wasm_internal.wasm`,
running under Node via:

- [`gl`](https://www.npmjs.com/package/gl) (headless-gl) for the WebGL2
  surface MediaPipe's GPU calculators expect.
- [`canvas`](https://www.npmjs.com/package/canvas) for decoding PNG/JPEG
  buffers into `ImageData`.

This package is a feasibility gate before the Stage 2 source build that
adds Emscripten toolchain wiring and Node-aware C++ guards. See
[NODE_TARGET_PLAN.md](../../../../NODE_TARGET_PLAN.md) at the repo root.

## Install

```sh
npm install @mediapipe/tasks-vision-node gl canvas
# optional, only if you want to feed videos directly to the library:
npm install ffmpeg-static
```

`gl` and `canvas` are peer dependencies because they ship native bindings
that benefit from the host's C++ toolchain at install time. `ffmpeg-static`
is an *optional* peer used by the [video API](#video-input); if it isn't
installed, the library falls back to the `ffmpeg` binary on `$PATH`.

## Usage

```js
const {readFile} = require('node:fs/promises');
const {
  FilesetResolver,
  createHandLandmarker,
  decodeImageBuffer,
} = require('@mediapipe/tasks-vision-node');

async function main() {
  const fileset = await FilesetResolver.forVisionTasks();
  const detector = await createHandLandmarker(fileset, {
    baseOptions: {modelAssetPath: 'hand_landmarker.task'},
    numHands: 2,
    runningMode: 'IMAGE',
  });

  const png = await readFile('hand.png');
  const imageData = await decodeImageBuffer(png);
  const result = detector.detect(imageData);
  console.log(result.landmarks);
}

main();
```

## Video input

Feed a video directly — no pre-pass through `ffmpeg` to a PNG directory, no
temp files. The library spawns `ffmpeg` itself, streams raw NV12 frames over
a pipe, and converts to RGBA in-WASM via the SIMD libyuv path. Steady-state
memory is one frame (~1.4MB at 720p).

```js
const {createReadStream} = require('node:fs');
const {
  FilesetResolver,
  createHandLandmarker,
  openVideo,
  detectVideoFile,
} = require('@mediapipe/tasks-vision-node');

async function main() {
  const fileset = await FilesetResolver.forVisionTasks();
  const detector = await createHandLandmarker(fileset, {
    baseOptions: {modelAssetPath: 'hand_landmarker.task'},
    numHands: 2,
    runningMode: 'VIDEO',
  });

  // Low-level: iterator. Use this when you want per-frame control (early
  // exit, async work between frames, custom timestamping, etc.).
  for await (const {imageData, tsMs} of openVideo('clip.mp4', {detector})) {
    const result = detector.detectForVideo(imageData, tsMs);
    // … do something with result
  }

  // High-level: one call, returns everything (also accepts onFrame callback).
  const results = await detectVideoFile(detector, 'clip.mp4');

  // Stream input — e.g. piping bytes from S3 or HTTP without touching disk.
  const piped = await detectVideoFile(detector, createReadStream('clip.mp4'));
}
```

Inputs accepted: file path (`string`), `Buffer`/`Uint8Array`, or any Node
`Readable` stream. For Buffer/stream input you may need to pass
`{width, height, fps}` explicitly if the ffmpeg banner can't parse a
container header — see [video_decoder.ts](./video_decoder.ts) for the
options reference.

## Limitations (Stage 1)

- Only `HandLandmarker` is exposed.
- The WASM binary is the upstream browser build. Some WebGL2 entry points
  may hit unimplemented `headless-gl` calls; failures here motivate Stage
  2 (source-built Node WASM with an injected GL context).
- No GPU acceleration via CUDA/Metal — `headless-gl` is software (OSMesa /
  SwiftShader on most platforms).

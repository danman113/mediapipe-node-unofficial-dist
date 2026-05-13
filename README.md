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
```

`gl` and `canvas` are peer dependencies because they ship native bindings
that benefit from the host's C++ toolchain at install time.

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

## Limitations (Stage 1)

- Only `HandLandmarker` is exposed.
- The WASM binary is the upstream browser build. Some WebGL2 entry points
  may hit unimplemented `headless-gl` calls; failures here motivate Stage
  2 (source-built Node WASM with an injected GL context).
- No GPU acceleration via CUDA/Metal — `headless-gl` is software (OSMesa /
  SwiftShader on most platforms).

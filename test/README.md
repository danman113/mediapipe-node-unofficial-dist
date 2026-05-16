# `@danman113/mediapipe-node` test suite

Self-contained Node test scripts that exercise every public API the
package exposes. Each test runs in its own child process so wasm state
is isolated between tests.

## Setup

```sh
# From this directory:
npm install
```

`npm install` pulls `canvas`, `gl`, and the parent dist directory as a
local file dependency (`file:..`).

## Fixtures

The tests need two files:

- **Model**: `fixtures/hand_landmarker.task` (~7 MB). Download from the
  MediaPipe model garden:
  ```sh
  mkdir -p fixtures
  curl -L \
    https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task \
    -o fixtures/hand_landmarker.task
  ```
- **Image**: `fixtures/pointing_up.jpg` — any photo of a hand on a clear
  background. ~640×480 JPEG works.

Both paths can be overridden via env vars:

```sh
MP_MODEL=/abs/path/hand_landmarker.task MP_IMAGE=/abs/path/hand.jpg npm test
```

If a fixture is missing the runner exits with code `2` and tells you what
to do.

## Run

```sh
npm test                  # runs all tests, summarizes pass/fail
npm run test:smoke        # 00-smoke.test.js
npm run test:threads      # 01-num-threads.test.js
npm run test:rgba         # 02-raw-rgba.test.js
npm run test:yuv          # 03-yuv.test.js
npm run test:profile      # 04-profile.test.js
```

## What each test covers

| File | Verifies |
|------|----------|
| `00-smoke.test.js` | Package loads, detector creates, `detect()` returns 21 landmarks per hand within `[0,1]`. |
| `01-num-threads.test.js` | `numThreads` option is wired, scales latency (`4 threads > 1.3× faster than 1 thread`), produces identical landmarks across thread counts. |
| `02-raw-rgba.test.js` | `createImageData` produces **bit-identical** landmarks vs `decodeImageBuffer` (delta=0), and is >10× faster. |
| `03-yuv.test.js` | `decodeYuvBuffer` supports NV12, NV21, I420; round-trip through RGBA→YUV→RGBA lands within YUV chroma quantization tolerance (5e-3). |
| `04-profile.test.js` | Profile API toggles on/off, records four shim phases (`shim.malloc`, `shim.heapCopy`, `shim.wasmPush`, `shim.free`), reset clears them. |

## Exit codes

- `0` — all tests passed.
- `1` — at least one test failed (an assertion failed or threw).
- `2` — a test was skipped because the API it tests isn't in the wasm
  bundle. This usually means the dist is stale; rebuild it:
  ```sh
  node ../build.js
  ```

## Notes

- The runner spawns each child with `--experimental-wasm-relaxed-simd` —
  Node 20 requires the V8 flag for the relaxed-SIMD opcodes the dist ships
  with by default. Node 22+ has it on and the flag is a harmless no-op.
- The 1-thread perf in `01-num-threads.test.js` is ~50ms on a typical
  laptop CPU. If you see numbers wildly off, host load may be skewing the
  measurement — the speedup ratio assertion is permissive (>1.3×) to
  tolerate it.

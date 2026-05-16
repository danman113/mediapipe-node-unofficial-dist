# test/fixtures

Drop the test inputs here:

- `hand_landmarker.task` — official MediaPipe model:
  ```sh
  curl -L \
    https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task \
    -o hand_landmarker.task
  ```
- `pointing_up.jpg` — any photo of a hand on a clean background.

Both files are gitignored — see `.gitignore` in the test directory.

Override the default paths with env vars:

```sh
MP_MODEL=/abs/path/hand_landmarker.task \
MP_IMAGE=/abs/path/hand.jpg \
  npm test
```

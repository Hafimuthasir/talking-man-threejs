# Talking Man — three.js viewer

A browser-based 3D viewer for the `talking_man` character (exported from
Blender). Upload an mp3 of a voice clip, click **Click to Talk**, and the
character's jaw moves in sync with the audio's volume.

## Running it

Browsers block loading 3D models and JavaScript modules directly from
`file://`, so this needs to be served over a local web server. Two ways to
do that:

### Option A — double-click launcher (macOS)

Double-click **start.command** in this folder. It starts a local server and
opens the viewer in your browser automatically. Press `Ctrl+C` in the
terminal window that opens to stop the server when you're done.

If macOS won't run it because it's not marked executable, open Terminal,
`cd` into this folder, and run:

```
chmod +x start.command
./start.command
```

### Option B — manual

```
cd "<this folder>"
python3 -m http.server 8000
```

Then open http://localhost:8000 in your browser.

## Using it

1. Wait for the character to finish loading (status text at the bottom).
2. Click **Upload voice (mp3)** and choose an audio file.
3. Click **Click to Talk**. The jaw animates based on the audio's
   loudness; click **Stop** to stop playback early.
4. Drag with the mouse to orbit the camera, scroll to zoom.

## Notes / things you can tune

- `main.js` has a small config block near the top (`JAW_BONE_NAME`,
  `JAW_AXIS`, `JAW_SIGN`, `JAW_MAX_ANGLE`, etc.) controlling the jaw
  animation. If the mouth opens in a way that looks wrong, try flipping
  `JAW_SIGN` to `-1`, or try `JAW_AXIS = 'x'`.
- The character was exported with its full skeleton (191 bones) and all
  original shape keys as morph targets, so more expressive
  animation (blinking, smiling, visemes) can be added later by driving
  additional bones or `morphTargetInfluences` on the meshes.
- The model file (`models/talking_man.glb`) is ~16 MB, so first load may
  take a few seconds depending on your connection (it's a local file, so
  this is mostly disk + parse time).

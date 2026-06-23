// ── Password gate ─────────────────────────────────────────────────────
(function () {
  const gate     = document.getElementById('gate');
  const input    = document.getElementById('gate-input');
  const btn      = document.getElementById('gate-btn');
  const errorEl  = document.getElementById('gate-error');

  function attempt() {
    if (input.value === 'letmein!') {
      gate.style.transition = 'opacity 0.4s';
      gate.style.opacity = '0';
      setTimeout(() => gate.remove(), 420);
      input.focus();
    } else {
      errorEl.textContent = 'Wrong password. Try again.';
      input.classList.remove('shake');
      void input.offsetWidth; // reflow to restart animation
      input.classList.add('shake');
      input.value = '';
    }
  }

  btn.addEventListener('click', attempt);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') attempt(); });
  input.focus();
})();

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ------------------------------------------------------------------
   Jaw animation tuning.

   The character's jaw hinge bone is "JawRoot_040". Based on inspecting
   the bone's rest orientation in Blender, the hinge (left/right) axis
   is the bone's local Z axis. If, after testing, the mouth appears to
   open the wrong way (or not at all), flip JAW_SIGN to -1, or try
   JAW_AXIS 'x' instead.

   Important: this bone's own keyframes barely move (checked directly
   in Blender — its rotation_quaternion track is nearly flat across the
   whole clip), and its bind pose alone renders as an open mouth. The
   actual mouth-closing/talking motion in the baked clip comes from its
   68 facial morph targets instead. So the talk-driven rotation below is
   applied ADDITIVELY on top of whatever the mixer already set the bone
   to that frame — never replacing it — otherwise the mouth gets stuck
   open in the bind pose whenever audio isn't playing.
------------------------------------------------------------------- */
const JAW_BONE_NAME = 'JawRoot_040';
const JAW_AXIS = 'z';        // local axis to rotate around: 'x' | 'y' | 'z'
const JAW_SIGN = 1;          // flip to -1 if the jaw opens the wrong way
const JAW_MAX_ANGLE = THREE.MathUtils.degToRad(18); // max mouth-open angle
const AMPLITUDE_SENSITIVITY = 3.2; // multiplier applied to mic-style RMS amplitude
const SMOOTHING = 0.35;      // 0..1, higher = snappier, lower = smoother
const SILENCE_THRESHOLD = 0.02;

/* ------------------------------------------------------------------
   Lightweight "lip-sync" heuristic.

   The character's 68 facial morph targets lost their real names
   somewhere before this project started (Blender shows them as generic
   target_0..target_67), so there's no safe way to tell which one shapes
   "ee" vs "oh" vs a closed "f" — driving an unidentified one risks
   distorting the face in some unrelated way (a brow or cheek morph,
   say). Real word-level lip-sync (matching exact mouth shapes to exact
   sounds) would need a separate phoneme-alignment pass over the audio
   plus that morph-target identification work — out of scope for now.

   This is a cheaper, safe approximation that still uses only the one
   lever already proven to work (the jaw bone): rather than opening the
   jaw purely in proportion to volume, it also looks at *where* the
   audio's energy sits in the frequency spectrum each frame. Vowels
   ("ah", "oh") concentrate energy in the lower formants and call for a
   wide-open jaw; sibilants/fricatives ("s", "sh", "f", "t") skew much
   higher in frequency and are spoken with the jaw nearly closed. Biasing
   the jaw's openness by that low/high energy balance — on top of the
   existing volume-driven amount — reads as noticeably less "robotic
   bobbing" and more like actual speech, without touching any unlabeled
   morph target.
------------------------------------------------------------------- */
// Frequency bin ranges below assume the AnalyserNode's default 48kHz/44.1kHz
// sample rate with fftSize 512 (see ensureAudioGraph) — frequencyBinCount
// 256 bins spanning 0..~22-24kHz, roughly 86-94Hz per bin.
const VOWEL_BAND_END = 24;       // ~0–2.1kHz: voice fundamental + vowel formants
const SIBILANT_BAND_START = 45;  // ~3.9kHz: where fricative/sibilant energy picks up
const SIBILANT_BAND_END = 110;   // ~9.6kHz: upper edge of useful sibilant energy
const VOWEL_FACTOR_SMOOTHING = 0.2; // slower than jaw SMOOTHING — spectrum is noisier frame-to-frame
const CONSONANT_JAW_FLOOR = 0.45;   // jaw still opens this fraction even on pure consonant energy (never fully clamps shut)

/* ------------------------------------------------------------------
   Body animation.

   The character's source Blender file ships with a baked mocap clip
   ("CC3_Base_Plus_TempMotion", ~26-32s). Its root bone drifts under
   5cm in real-world terms over the whole clip (checked against the
   rig's armature scale) — negligible, so it loops in place without
   the character walking out of frame. It's exported into
   talking_man.glb and played back via THREE.AnimationMixer for all
   body movement (weight shifts, breathing, head turns, hand
   gestures) AND facial motion (mouth/visemes via morph targets). The
   jaw bone gets a small, additive, audio-amplitude-driven rotation
   layered on top of that every frame for extra lip-sync emphasis.
------------------------------------------------------------------- */
let mixer = null;
// The baked clip's AnimationAction. Paused by default (frame 0 = relaxed
// idle pose) and only resumed while audio is actually playing — see
// startTalking()/stopTalking() below.
let talkAction = null;
const clock = new THREE.Clock();

// Mid-speech pause detection. Audio playing != audio making sound right
// now — a clip can have real silent gaps in the middle (a breath, a pause
// between sentences) while isTalking stays true the whole time. Without
// this, the baked clip's body gestures and morph-target mouth shapes keep
// looping straight through those gaps. breakSilence/pausedForBreak (used
// in animate() below) track that and freeze talkAction in place once a
// gap has held long enough to read as a real pause, resuming exactly
// where it left off — no reset — the moment sound returns.
const BREAK_HOLD_SECONDS = 0.35;
let breakSilence = 0;
let pausedForBreak = false;

const statusEl  = document.getElementById('status');
const startBtn   = document.getElementById('startBtn');
const btnLabel   = document.getElementById('btn-label');
const resetViewBtn = document.getElementById('resetViewBtn');
const audioEl    = document.getElementById('audioEl');
const viewerEl   = document.getElementById('viewer');

let setStatus = (text) => { statusEl.textContent = text; };

// Button state machine: idle | listening | thinking | speaking
const BTN_ICONS = {
  default: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
  speaking: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`,
};

function setBtnState(state) {
  startBtn.className = state === 'idle' ? '' : state;
  const labels = { idle: 'Start', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…' };
  btnLabel.textContent = labels[state] || 'Start';
  document.getElementById('btn-icon').innerHTML =
    state === 'speaking' ? BTN_ICONS.speaking : BTN_ICONS.default;
}

/* ------------------------------------------------------------------
   Scene setup
------------------------------------------------------------------- */
const scene = new THREE.Scene();
// The HDRI studio photo (Poly Haven studio_small_08) that used to be both
// scene.background and scene.environment has been dropped now that the
// character stands inside real dining-room geometry. With no ceiling and
// an open front wall on that room, the HDRI was still visible through
// those gaps and was also flooding every wall/floor surface with flat,
// shadowless image-based light — that combination is what was reading as
// "too white" with no visible contact shadow. A plain dark color now
// shows through the room's gaps instead (reads as a dim doorway/opening
// rather than a mismatched studio backdrop), and lighting is handled
// entirely by the three local lights below.
scene.background = new THREE.Color(0x14161a);

const camera = new THREE.PerspectiveCamera(
  50,
  window.innerWidth / window.innerHeight,
  0.01,
  1000
);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
// Brought back up slightly from 0.85 now that the HDRI's flat ambient
// fill is gone entirely (rather than just dimmed) — without it the scene
// relies only on the three lights below, so exposure needs to sit a bit
// higher than the HDRI-flooded version did, but still below the original
// 1.05 tuned for a single small character against a flat backdrop.
renderer.toneMappingExposure = 1.05;
// Needed for the ground contact shadow below — without this, the key
// light's castShadow flag and the ground plane's receiveShadow flag are
// both no-ops.
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewerEl.appendChild(renderer.domElement);

// Now the only source of ambient fill (the HDRI environment that used to
// share this job is gone). 0.6 still left the side/back walls reading as
// near-black since they only catch this flat ambient term (the directional
// lights below mostly hit the character and floor, not walls facing
// sideways/away from them) — raised further so the room itself is visible
// without redoing the wash-out the HDRI caused.
const hemi = new THREE.HemisphereLight(0xffffff, 0x404048, 0.9);
scene.add(hemi);

const keyLight = new THREE.DirectionalLight(0xffffff, 1.3);
keyLight.position.set(1.5, 2.5, 3);
// Casts the contact shadow that grounds the character's feet (see the
// ground plane added in the loader callback below). The shadow camera's
// frustum is sized tight around the character (he's ~1.6m tall) rather
// than left at the ±5 default, so the shadow map's resolution isn't
// wasted on empty space.
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
keyLight.shadow.camera.left = -2;
keyLight.shadow.camera.right = 2;
keyLight.shadow.camera.top = 2;
keyLight.shadow.camera.bottom = -2;
keyLight.shadow.camera.near = 0.1;
keyLight.shadow.camera.far = 10;
keyLight.shadow.bias = -0.001;
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xffffff, 0.45);
fillLight.position.set(-2, 1, -2);
scene.add(fillLight);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.05;
controls.maxDistance = 50;
// The backdrop is just an HDRI image wrapped around the scene, not real
// room geometry — there's no floor or ceiling for the character to
// stand on, so swinging the camera to a near-overhead or near-underneath
// angle exposes that (the character ends up "floating" against a flat,
// featureless patch of the panorama, since equirectangular images
// stretch out heavily at their top/bottom poles). Clamping the orbit to
// a believable walk-around-the-subject range avoids that.
controls.minPolarAngle = THREE.MathUtils.degToRad(50);
controls.maxPolarAngle = THREE.MathUtils.degToRad(130);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ------------------------------------------------------------------
   Load the character
------------------------------------------------------------------- */
let jawBone = null;
const hingeAxis = new THREE.Vector3(
  JAW_AXIS === 'x' ? 1 : 0,
  JAW_AXIS === 'y' ? 1 : 0,
  JAW_AXIS === 'z' ? 1 : 0
);

// Frame the camera using a bounding-sphere fit, centered on the whole
// model — this is robust to whatever axis convention the Blender export
// ended up using, since it only relies on a distance-from-center
// calculation, not which axis is "up". Pulled out into its own function
// (rather than inline one-off code in the loader callback below) so the
// "Reset View" button can call it again on demand — orbiting with
// OrbitControls has no built-in way back to the original framing, so
// users who drag themselves into an awkward angle need an explicit way
// to snap back.
let currentModel = null;

function frameCameraOnModel(model) {
  const box = new THREE.Box3().setFromObject(model);
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  const center = sphere.center;
  const radius = sphere.radius || 1;
  const fovRad = THREE.MathUtils.degToRad(camera.fov / 2);

  // Padding factor; 1.0 = sphere exactly touches top/bottom of frame.
  // 1.2 (20% margin) is the value verified against a live render to
  // produce a correct, right-side-up full-body view — smaller values
  // were tested and produced a flipped/upside-down result instead, so
  // this margin is intentionally left as-is rather than tightened.
  const distance = (radius / Math.sin(fovRad)) * 1.2;

  // The glb is already standard Y-up (see the loader callback below for
  // why no model rotation is applied), so the camera can use plain
  // defaults — up vector untouched, offset along +Z from the target.
  controls.target.copy(center);
  camera.position.set(center.x, center.y, center.z + distance);
  camera.near = Math.max(distance / 1000, 0.001);
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  camera.lookAt(center);
  controls.update();
}

const loader = new GLTFLoader();
loader.load(
  'models/talking_man.glb',
  (gltf) => {
    const model = gltf.scene;
    currentModel = model;
    scene.add(model);

    // NOTE: no axis-correction rotation is applied here. Checked directly
    // in Blender: the character's armature already stands upright along
    // world +Z there (height ~1.58m along Blender's Z-up axis), and
    // Blender's glTF exporter auto-converts Z-up to the glTF/three.js
    // Y-up convention on export — so talking_man.glb already comes in
    // standing correctly on three.js's standard +Y-up axes, with no
    // extra rotation needed.
    //
    // An earlier pass added `model.rotation.x = Math.PI / 2` here, on the
    // theory that the export's axes didn't match three.js convention. That
    // diagnosis was wrong: it took an already-correct Y-up model and
    // rotated it another 90° on top, which swapped the character's "up"
    // onto world Z — so the bounding-sphere camera (offset along world Z
    // in frameCameraOnModel) ended up sitting directly above the model's
    // head looking straight down, instead of in front of it. That's what
    // caused the "Reset View snaps to a top-down view" bug. Removing the
    // extra rotation lets the camera's default +Z offset land in front of
    // the character at eye height, as intended.

    // Force a full matrixWorld update down the whole hierarchy (bones
    // included) before measuring the model — otherwise Box3.setFromObject
    // can run against stale/identity matrices (matrixWorld is normally
    // only refreshed inside renderer.render(), which hasn't run yet).
    model.updateMatrixWorld(true);

    jawBone = model.getObjectByName(JAW_BONE_NAME);
    if (!jawBone) {
      console.warn(`Bone "${JAW_BONE_NAME}" not found — jaw animation disabled.`);
    }

    // Load the model's own baked mocap clip, but hold it paused on its
    // first frame until the user is actually playing audio. Running
    // mixer.update(0) immediately (before the camera-framing box below)
    // snaps the model straight to that first frame, so the bind T-pose
    // never shows on screen.
    if (gltf.animations && gltf.animations.length) {
      const clip = gltf.animations[0];
      // Every track is kept, including the 68 facial morph-target
      // ("target_N") channels — those are what actually open/close the
      // mouth over the course of the clip. (An earlier pass stripped them
      // on the theory that they fought the jaw-bone lip-sync override
      // below, but checking the bone's own keyframes directly in Blender
      // showed JawRoot_040 barely moves on its own — its bind pose alone
      // renders open-mouthed — so removing the morphs just left the jaw
      // stuck open with nothing closing it. The talk-driven rotation in
      // animate() is layered additively on top of this baked motion
      // instead of replacing it outright, so it no longer fights the bone
      // for control.)
      //
      // This whole clip is a talking performance (body gestures AND mouth
      // movement together) — left running on a loop, the character looks
      // like he's talking nonstop regardless of whether any audio is
      // actually playing. talkAction is paused right after snapping to
      // frame 0 below, and only resumed by startTalking()/stopTalking()
      // in sync with real audio playback.
      mixer = new THREE.AnimationMixer(model);
      talkAction = mixer.clipAction(clip);
      talkAction.play();
      mixer.update(0);
      model.updateMatrixWorld(true);
      talkAction.paused = true;
      // The render loop's clock has been running since page load (it's
      // created at module scope), so without this, the model load time
      // itself (however long that took) would be fed into the next
      // mixer.update() as one giant first delta. Flush that backlog now
      // so playback (once a talk action actually resumes) advances
      // smoothly from frame 0 instead of snapping.
      clock.getDelta();
    } else {
      console.warn('No baked animation found in the glb — body will stay in its bind pose.');
    }

    // Ground contact shadow. The HDRI backdrop is just an image with no
    // real floor geometry, so without something to anchor his feet to,
    // the character reads as floating over the panorama's blurred floor
    // patch. A ShadowMaterial plane is invisible except where a shadow
    // actually falls on it, so it adds that grounding cue without
    // needing any real floor texture or geometry to match the HDRI.
    model.traverse((node) => {
      if (node.isMesh) node.castShadow = true;
    });
    const groundBox = new THREE.Box3().setFromObject(model);
    const groundRadius =
      Math.max(groundBox.max.x - groundBox.min.x, groundBox.max.z - groundBox.min.z) * 3;
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(groundRadius, 32),
      new THREE.ShadowMaterial({ opacity: 0.35 })
    );
    ground.rotation.x = -Math.PI / 2;
    // Nudged a hair below the character's feet (rather than exactly at
    // groundBox.min.y) so it doesn't z-fight with the dining room's real
    // floor mesh loaded below — both can receive the contact shadow
    // without flickering.
    ground.position.y = groundBox.min.y - 0.005;
    ground.receiveShadow = true;
    scene.add(ground);

    // (Verified against a live render: a closer, jaw-bone-centered
    // "portrait" framing landed the camera inside the geometry instead —
    // this whole-model framing is the one confirmed to render correctly.)
    frameCameraOnModel(model);

    setStatus('Press Start to speak with the assistant.');
  },
  (progress) => {
    if (progress.total) {
      const pct = Math.round((progress.loaded / progress.total) * 100);
      setStatus(`Loading character… ${pct}%`);
    }
  },
  (error) => {
    console.error('Failed to load model', error);
    setStatus('Failed to load character model. See console for details.');
  }
);

/* ------------------------------------------------------------------
   Load the dining room backdrop.

   Real architecture (floor, walls, table, chairs) replacing the flat
   HDRI-only backdrop, exported from a CGTrader "Dining Room" model that
   was appended into the same talking_man.blend scene the character lives
   in, then repositioned in Blender so the character stands in an opened
   doorway with the table behind him.

   No offset/scale is applied here on the three.js side — both glbs were
   exported straight from that one shared Blender world space, and the
   character's glb was never recentered to its own local origin (its feet
   already sat near world Z=0 in Blender), so the two models' native
   transforms already line up correctly when loaded together as-is.

   The room came from CGTrader without a ceiling and with its front wall
   cut open (see the Blender wall-removal step). The HDRI that used to
   show through those gaps has since been dropped entirely (see the plain
   scene.background color set above) — the gaps now just read as a dim
   doorway/opening, with the three local lights doing all the lighting.
------------------------------------------------------------------- */
const roomLoader = new GLTFLoader();
roomLoader.load(
  'models/dining_room.glb',
  (gltf) => {
    const room = gltf.scene;
    room.traverse((node) => {
      if (node.isMesh) {
        // Furniture casts onto the floor; the floor/walls catch the
        // character's contact shadow too.
        node.castShadow = true;
        node.receiveShadow = true;
      }
    });
    scene.add(room);
  },
  undefined,
  (error) => {
    console.error('Failed to load dining room backdrop', error);
  }
);

/* ------------------------------------------------------------------
   Audio: file upload + Web Audio analysis
------------------------------------------------------------------- */
let audioCtx = null;
let analyser = null;
let sourceNode = null;
let dataArray = null;
let freqDataArray = null; // frequency-domain buffer for the vowel/consonant heuristic (see getVowelFactor)
let hasAudioFile = false;
let isTalking = false;
let smoothedAmplitude = 0;
let smoothedVowelFactor = 1; // 1 = full jaw openness allowed; only pulled down by consonant-heavy audio

resetViewBtn.addEventListener('click', () => {
  if (currentModel) frameCameraOnModel(currentModel);
});

function ensureAudioGraph() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  sourceNode = audioCtx.createMediaElementSource(audioEl);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.7;
  dataArray = new Uint8Array(analyser.fftSize);
  // getByteFrequencyData wants its own buffer sized to frequencyBinCount
  // (fftSize / 2 = 256) — it can't share dataArray with the time-domain
  // read above.
  freqDataArray = new Uint8Array(analyser.frequencyBinCount);

  sourceNode.connect(analyser);
  analyser.connect(audioCtx.destination);
}

function startTalking() {
  ensureAudioGraph();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  audioEl.currentTime = 0;
  audioEl.play();
  isTalking = true;
  setBtnState('speaking');
  setStatus('');
  if (talkAction) {
    talkAction.reset();
    talkAction.play();
    talkAction.paused = false;
  }
  breakSilence = 0;
  pausedForBreak = false;
}

function stopTalking() {
  audioEl.pause();
  audioEl.currentTime = 0;
  isTalking = false;
  setBtnState('idle');
  setStatus('Press Start to speak with the assistant.');
  if (talkAction) {
    talkAction.paused = true;
    talkAction.time = 0;
    if (mixer) mixer.update(0);
  }
  breakSilence = 0;
  pausedForBreak = false;
}

audioEl.addEventListener('ended', stopTalking);

function getCurrentAmplitude() {
  if (!isTalking || !analyser) return 0;
  analyser.getByteTimeDomainData(dataArray);
  let sumSquares = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const normalized = (dataArray[i] - 128) / 128;
    sumSquares += normalized * normalized;
  }
  const rms = Math.sqrt(sumSquares / dataArray.length);
  return rms < SILENCE_THRESHOLD ? 0 : rms;
}

// Returns a 0..1 multiplier for how wide the jaw is allowed to open this
// frame, based on where the audio's energy sits in the spectrum (see the
// lip-sync heuristic comment near the top of the file). 1 = vowel-heavy,
// wide open; CONSONANT_JAW_FLOOR = sibilant/fricative-heavy, mostly closed.
function getVowelFactor() {
  if (!isTalking || !analyser) return 1;
  analyser.getByteFrequencyData(freqDataArray);

  let vowelEnergy = 0;
  for (let i = 0; i < VOWEL_BAND_END; i++) {
    vowelEnergy += freqDataArray[i];
  }
  vowelEnergy /= VOWEL_BAND_END;

  let sibilantEnergy = 0;
  for (let i = SIBILANT_BAND_START; i < SIBILANT_BAND_END; i++) {
    sibilantEnergy += freqDataArray[i];
  }
  sibilantEnergy /= (SIBILANT_BAND_END - SIBILANT_BAND_START);

  // Share of the (vowel + sibilant) energy that's coming from the vowel
  // band. The +1 keeps this stable during near-silent frames that still
  // happen to clear SILENCE_THRESHOLD, instead of dividing by ~0.
  const vowelShare = vowelEnergy / (vowelEnergy + sibilantEnergy + 1);
  return CONSONANT_JAW_FLOOR + (1 - CONSONANT_JAW_FLOOR) * vowelShare;
}

/* ------------------------------------------------------------------
   Render loop
------------------------------------------------------------------- */
const tmpQuat = new THREE.Quaternion();

function animate() {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();

  const rawAmp = getCurrentAmplitude();
  smoothedAmplitude = THREE.MathUtils.lerp(smoothedAmplitude, rawAmp, SMOOTHING);

  const rawVowelFactor = getVowelFactor();
  smoothedVowelFactor = THREE.MathUtils.lerp(
    smoothedVowelFactor,
    rawVowelFactor,
    VOWEL_FACTOR_SMOOTHING
  );

  // See the breakSilence/pausedForBreak comment near talkAction's
  // declaration: this catches silent gaps *within* an active talking
  // session (isTalking stays true the whole time audio.play() is active),
  // which the original startTalking()/stopTalking() gating didn't cover.
  if (isTalking && talkAction) {
    if (smoothedAmplitude < SILENCE_THRESHOLD) {
      breakSilence += delta;
      if (breakSilence > BREAK_HOLD_SECONDS && !talkAction.paused) {
        talkAction.paused = true;
        pausedForBreak = true;
      }
    } else {
      breakSilence = 0;
      if (pausedForBreak) {
        talkAction.paused = false;
        pausedForBreak = false;
      }
    }
  }

  if (mixer) mixer.update(delta);

  if (jawBone) {
    const angle = THREE.MathUtils.clamp(
      smoothedAmplitude * AMPLITUDE_SENSITIVITY,
      0,
      1
    ) * smoothedVowelFactor * JAW_MAX_ANGLE * JAW_SIGN;

    // Additive, not a replace: jawBone.quaternion already holds whatever
    // this frame's mixer.update() (above) drove it to from the baked
    // clip. When angle is 0 (silence), this is a no-op rotation and the
    // baked motion shows through untouched; while talking, it rotates the
    // jaw further open on top of that baseline, scaled down a bit by
    // smoothedVowelFactor during consonant/sibilant-heavy moments so the
    // mouth doesn't gape open uniformly on every sound.
    tmpQuat.setFromAxisAngle(hingeAxis, angle);
    jawBone.quaternion.multiply(tmpQuat);
  }

  controls.update();
  renderer.render(scene, camera);
}

animate();

/* ------------------------------------------------------------------
   AI Chat
------------------------------------------------------------------- */
const chatPanel     = document.getElementById('chat-panel');
const chatMessages  = document.getElementById('chat-messages');
const chatInput     = document.getElementById('chatInput');
const sendBtn       = document.getElementById('sendBtn');
const chatToggleBtn = document.getElementById('chatToggleBtn');

// Rolling conversation history — trimmed oldest-first to stay under
// MAX_HISTORY_CHARS before each API call; always keeps the last exchange.
const conversationHistory = [];
const MAX_HISTORY_CHARS = 2500;

function getTrimmedHistory() {
  let total = 0;
  const trimmed = [];
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const chars = conversationHistory[i].content.length;
    if (total + chars > MAX_HISTORY_CHARS && trimmed.length >= 2) break;
    total += chars;
    trimmed.unshift(conversationHistory[i]);
  }
  return trimmed;
}

function appendMessage(text, role) {
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

let currentBlobUrl = null;

async function askAssistant(message) {
  message = message.trim();
  if (!message) return;

  appendMessage(message, 'user');
  chatInput.value = '';
  sendBtn.disabled = true;
  setBtnState('thinking');

  const thinking = appendMessage('Thinking…', 'thinking');

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history: getTrimmedHistory() }),
    });

    if (!res.ok) throw new Error(`API error ${res.status}`);

    const replyText = decodeURIComponent(res.headers.get('X-Reply-Text') || '');
    thinking.remove();
    appendMessage(replyText || '…', 'assistant');

    conversationHistory.push({ role: 'user',      content: message });
    conversationHistory.push({ role: 'assistant', content: replyText });

    const blob = await res.blob();
    if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = URL.createObjectURL(blob);

    if (isTalking) stopTalking();
    audioEl.src = currentBlobUrl;
    hasAudioFile = true;
    startTalking();
  } catch (err) {
    console.error(err);
    thinking.remove();
    appendMessage('Sorry, I could not connect to the assistant.', 'assistant');
    setBtnState('idle');
    setStatus('Press Start to speak with the assistant.');
  } finally {
    sendBtn.disabled = false;
  }
}

// Text input send
sendBtn.addEventListener('click', () => askAssistant(chatInput.value));
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') askAssistant(chatInput.value);
});

// Chat panel toggle
chatToggleBtn.addEventListener('click', () => {
  const open = chatPanel.classList.toggle('visible');
  chatToggleBtn.classList.toggle('active', open);
  if (open) chatInput.focus();
});

// ── Main Start button with SpeechRecognition ──────────────────────────
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (SpeechRecognition) {
  const recognition = new SpeechRecognition();
  recognition.lang = 'en-US';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    // Mirror spoken question into the chat panel (open if closed)
    if (!chatPanel.classList.contains('visible')) {
      chatPanel.classList.add('visible');
      chatToggleBtn.classList.add('active');
    }
    askAssistant(transcript);
  };

  recognition.onerror = () => setBtnState('idle');
  recognition.onend = () => {
    if (startBtn.classList.contains('listening')) setBtnState('idle');
  };

  startBtn.addEventListener('click', () => {
    if (isTalking || startBtn.classList.contains('speaking')) {
      stopTalking();
      return;
    }
    if (startBtn.classList.contains('thinking')) return;
    if (startBtn.classList.contains('listening')) {
      recognition.stop();
      setBtnState('idle');
      return;
    }
    setBtnState('listening');
    recognition.start();
  });
} else {
  // No SpeechRecognition — Start opens the text chat instead
  startBtn.addEventListener('click', () => {
    if (isTalking) { stopTalking(); return; }
    chatPanel.classList.add('visible');
    chatToggleBtn.classList.add('active');
    chatInput.focus();
  });
}

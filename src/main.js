// Pocket Pitch — WebAR tabletop rugby flick game.
//  • Android Chrome: real WebXR (immersive-ar) with hit-test surface detection.
//  • Everything else: "camera mode" — live camera feed + gyroscope (rotation only).
//  • Desktop: preview mode with a fixed camera so the game is still testable.

import * as THREE from 'three';
import {
  Game,
  CHALLENGES,
  WORLD,
  flickToVelocity,
  yawForForward,
  phiFromLocalDir,
} from './logic.js';
import { PlaneTracker, coverCrop, procSize, quatToMat, grayFromRGBA } from './tracker.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONFIG = {
  // Shown on the result screen. Set ctaUrl to '' to hide it.
  ctaUrl: 'https://www.englandrugby.com',
  ctaText: 'Discover the real thing →',
  defaultScale: 0.75, // pitch scale: 1 = 0.56 m x 0.90 m
  fallbackDrop: 0.5, // camera-mode: assumed metres from phone down to the table
  sizes: { S: 0.55, M: 0.75, L: 1.0 },
  fovY: 64, // vertical FOV of the virtual camera in camera mode (also used by the surface-lock tracker)
};

const COLORS = { navy: 0x12305a, red: 0xc8102e, white: 0xffffff, gold: 0xffc72c };

const $ = (id) => document.getElementById(id);
const el = {
  cam: $('cam'),
  gl: $('gl'),
  overlay: $('overlay'),
  touch: $('touch'),
  hud: $('hud'),
  hudTitle: $('hud-title'),
  hudBalls: $('hud-balls'),
  hudScore: $('hud-score'),
  hudTimer: $('hud-timer'),
  hudMult: $('hud-mult'),
  hudHint: $('hud-hint'),
  coach: $('coach'),
  toast: $('toast'),
  toastTitle: $('toast-title'),
  toastText: $('toast-text'),
  landing: $('screen-landing'),
  placing: $('screen-placing'),
  placeTitle: $('place-title'),
  placeSub: $('place-sub'),
  placeTop: document.querySelector('.place-top'),
  result: $('screen-result'),
  btnStart: $('btn-start'),
  btnAlt: $('btn-alt'),
  capNote: $('cap-note'),
  hudTrack: $('hud-track'),
  placeTrack: $('place-track'),
  btnTrack: $('btn-track'),
};

const S = {
  mode: null, // 'xr' | 'fallback'
  screen: 'landing', // landing | placing | playing | result
  xrSupported: false,
  xrSession: null,
  hitSource: null,
  hitValid: false,
  placed: false,
  scale: CONFIG.defaultScale,
  drop: CONFIG.fallbackDrop,
  level: 0,
  coachDone: false,
  grab: false,
  lastHint: 0,
  hasGyro: false,
  stream: null,
  orient: { alpha: 0, beta: 0, gamma: 0 },
};

// ---------------------------------------------------------------------------
// Sound (tiny WebAudio synth — no assets to load)
// ---------------------------------------------------------------------------
class Sfx {
  constructor() {
    this.ctx = null;
    this.on = true;
    this.noiseBuf = null;
  }
  unlock() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) this.ctx = new AC();
      }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    } catch (_) { /* audio is optional */ }
  }
  _tone(freq, dur, { type = 'sine', vol = 0.15, to = null, delay = 0 } = {}) {
    if (!this.on || !this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(vol, 0.0002), t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  }
  _noise(dur, vol = 0.1, { freq = 1200, delay = 0 } = {}) {
    if (!this.on || !this.ctx) return;
    const ctx = this.ctx;
    if (!this.noiseBuf) {
      this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(vol, 0.0002), t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(ctx.destination);
    src.start(t0);
    src.stop(t0 + dur + 0.03);
  }
  launch(p) {
    this._noise(0.2, 0.1 + 0.12 * p, { freq: 500 + 900 * p });
    this._tone(180, 0.16, { type: 'triangle', to: 460, vol: 0.07 });
  }
  bounce(s = 0.5) {
    this._tone(140 + 60 * s, 0.08, { vol: 0.04 + 0.12 * s, to: 70 });
  }
  score(mult = 1) {
    [523.25, 659.25, 783.99].forEach((f, i) => this._tone(f, 0.16, { type: 'triangle', vol: 0.13, delay: i * 0.07 }));
    if (mult > 1) this._tone(1046.5, 0.28, { type: 'triangle', vol: 0.12, delay: 0.23 });
    if (mult > 2) this._tone(1318.5, 0.3, { type: 'triangle', vol: 0.1, delay: 0.3 });
  }
  tackle() {
    this._noise(0.14, 0.2, { freq: 320 });
    this._tone(95, 0.14, { to: 50, vol: 0.2 });
  }
  miss() {
    this._tone(240, 0.28, { type: 'sawtooth', to: 110, vol: 0.05 });
  }
  fanfare(stars) {
    const seq = stars >= 3 ? [523, 659, 784, 1047, 1319] : stars >= 1 ? [523, 659, 784, 1047] : [392, 330, 262];
    seq.forEach((f, i) => this._tone(f, 0.22, { type: 'triangle', vol: 0.13, delay: i * 0.11 }));
  }
}
const sfx = new Sfx();
const haptic = (ms) => {
  try { navigator.vibrate && navigator.vibrate(ms); } catch (_) { /* unsupported */ }
};

// ---------------------------------------------------------------------------
// three.js scene
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas: el.gl, antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(CONFIG.fovY, window.innerWidth / window.innerHeight, 0.01, 20);
scene.add(camera);
scene.add(new THREE.HemisphereLight(0xffffff, 0x4a5a6a, 2.0)); // r160 uses physical light units, hence the larger numbers

const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

// ----- pitch group (everything in pitch-local metres; group is scaled/rotated/positioned) -----
const pitch = new THREE.Group();
pitch.visible = false;
scene.add(pitch);

const sun = new THREE.DirectionalLight(0xffffff, 2.8);
sun.position.set(0.45, 1.3, 0.55);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -0.7, right: 0.7, top: 0.7, bottom: -0.7, near: 0.1, far: 3 });
sun.shadow.camera.updateProjectionMatrix(); // required after resizing the shadow frustum
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.001;
pitch.add(sun, sun.target);

function makePitchTexture() {
  const w = 560, h = 900;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const n = 10;
  for (let i = 0; i < n; i++) {
    g.fillStyle = i % 2 ? '#2a9a55' : '#238c4a';
    g.fillRect(0, (i * h) / n, w, h / n + 1);
  }
  // in-goal areas: red at the far end, navy at the player's end
  g.fillStyle = 'rgba(200,16,46,.55)'; g.fillRect(0, 0, w, 110);
  g.fillStyle = 'rgba(18,48,90,.6)'; g.fillRect(0, h - 110, w, 110);
  g.strokeStyle = 'rgba(255,255,255,.95)';
  g.lineWidth = 6;
  g.strokeRect(14, 14, w - 28, h - 28);
  const line = (y, dash) => {
    g.setLineDash(dash || []);
    g.beginPath(); g.moveTo(14, y); g.lineTo(w - 14, y); g.stroke();
  };
  line(110); line(h - 110); line(h / 2); line(300); line(h - 300);
  line(h / 2 - 90, [16, 14]); line(h / 2 + 90, [16, 14]);
  g.setLineDash([]);
  g.fillStyle = 'rgba(255,255,255,.7)';
  g.font = '900 54px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('ENGLAND', w / 2, h - 55);
  g.save();
  g.translate(w / 2, 55);
  g.rotate(Math.PI);
  g.font = '900 30px system-ui, sans-serif';
  g.fillText('POCKET PITCH', 0, 0);
  g.restore();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

const slab = new THREE.Mesh(
  new THREE.BoxGeometry(WORLD.W + 0.03, 0.02, WORLD.L + 0.03),
  new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 })
);
slab.position.y = -0.01;
slab.castShadow = true;
slab.receiveShadow = true;
pitch.add(slab);

const turf = new THREE.Mesh(
  new THREE.PlaneGeometry(WORLD.W, WORLD.L),
  new THREE.MeshStandardMaterial({ map: makePitchTexture(), roughness: 0.95 })
);
turf.rotation.x = -Math.PI / 2;
turf.position.y = 0.0006;
turf.receiveShadow = true;
pitch.add(turf);

// invisible plane that only shows shadows, so the pitch feels "on" the real table
const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4), new THREE.ShadowMaterial({ opacity: 0.28 }));
shadowCatcher.rotation.x = -Math.PI / 2;
shadowCatcher.position.y = -0.0205;
shadowCatcher.receiveShadow = true;
pitch.add(shadowCatcher);

// ----- goalposts -----
const posts = new THREE.Group();
{
  const P = WORLD.post;
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.2 });
  const upright = new THREE.CylinderGeometry(P.barR, P.barR, P.uprightH, 12);
  for (const sx of [-1, 1]) {
    const m = new THREE.Mesh(upright, mat);
    m.position.set(sx * P.hw, P.uprightH / 2, P.z);
    m.castShadow = true;
    posts.add(m);
  }
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(P.barR, P.barR, P.hw * 2, 12), mat);
  bar.rotation.z = Math.PI / 2;
  bar.position.set(0, P.barY, P.z);
  bar.castShadow = true;
  posts.add(bar);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(P.barR * 1.4, P.barR * 1.4, P.barY, 12), mat);
  stem.position.set(0, P.barY / 2, P.z);
  stem.castShadow = true;
  posts.add(stem);
}
posts.visible = false;
pitch.add(posts);

// ----- ball -----
function makeBallTexture() {
  // White rugby-union ball in England colours: grip dimples, navy seams/tips, red trim, "ENGLAND" lettering.
  const W = 512, H = 256;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#f5f5f2';
  g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(0,0,0,0.08)';
  for (let i = 0; i < 2200; i++) {
    g.beginPath();
    g.arc(Math.random() * W, Math.random() * H, 1.1 + Math.random() * 0.6, 0, Math.PI * 2);
    g.fill();
  }
  // navy tips and red trim bands (u runs around the ball, v runs along its length)
  g.fillStyle = '#12305a';
  g.fillRect(0, 0, W, H * 0.1);
  g.fillRect(0, H * 0.9, W, H * 0.1);
  g.fillStyle = '#c8102e';
  g.fillRect(0, H * 0.1, W, 9);
  g.fillRect(0, H * 0.9 - 9, W, 9);
  // four panel seams
  g.fillStyle = '#12305a';
  for (let i = 0; i < 4; i++) g.fillRect(i * (W / 4) - 2.5, 0, 5, H);
  // lettering along the length of two opposite panels
  g.fillStyle = '#12305a';
  g.font = '900 30px system-ui, -apple-system, "Segoe UI", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const u of [W * 0.125, W * 0.625]) {
    g.save();
    g.translate(u, H / 2);
    g.rotate(-Math.PI / 2);
    g.fillText('ENGLAND', 0, 0);
    g.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}
const ballGroup = new THREE.Group(); // long axis = local +z
{
  // Superellipse profile: ~19 cm wide x ~29 cm long, with blunt rounded ends (not pointed like a gridiron ball).
  const prof = [];
  const N = 40, n = 2.3, Rb = 0.0245, Lb = 0.037;
  for (let i = 0; i <= N; i++) {
    const t = -1 + (2 * i) / N;
    prof.push(new THREE.Vector2(Rb * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(t), n)), 1 / n), t * Lb));
  }
  const body = new THREE.Mesh(
    new THREE.LatheGeometry(prof, 36),
    new THREE.MeshStandardMaterial({ map: makeBallTexture(), roughness: 0.5 })
  );
  body.rotation.x = Math.PI / 2; // lathe axis (y) laid along z
  ballGroup.add(body);
}
ballGroup.visible = false;
pitch.add(ballGroup);

const ballBlob = new THREE.Mesh(
  new THREE.CircleGeometry(0.03, 24),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false })
);
ballBlob.rotation.x = -Math.PI / 2;
ballBlob.position.y = 0.0016;
ballBlob.visible = false;
pitch.add(ballBlob);

const startRing = new THREE.Mesh(
  new THREE.RingGeometry(0.04, 0.05, 40),
  new THREE.MeshBasicMaterial({ color: COLORS.gold, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide })
);
startRing.rotation.x = -Math.PI / 2;
startRing.position.set(WORLD.start.x, 0.002, WORLD.start.z);
startRing.visible = false;
pitch.add(startRing);

// ----- targets (rebuilt per challenge) -----
const targetsGroup = new THREE.Group();
pitch.add(targetsGroup);
const T = { bins: [], dummies: [], postLabel: null };

function makeTextSprite(lines, scaleW = 0.2) {
  const c = document.createElement('canvas');
  c.width = 400; c.height = lines.length > 1 ? 240 : 140;
  const g = c.getContext('2d');
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  const step = c.height / lines.length;
  lines.forEach((ln, i) => {
    g.font = `900 ${ln.size || 80}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    g.lineWidth = 16;
    g.strokeStyle = '#0b1f3a';
    g.strokeText(ln.text, 200, step * (i + 0.5));
    g.fillStyle = ln.color || '#fff';
    g.fillText(ln.text, 200, step * (i + 0.5));
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(scaleW, (scaleW * c.height) / c.width, 1);
  sp.renderOrder = 20;
  return sp;
}

function makeBinMesh(b) {
  const g = new THREE.Group();
  const col = b.color === 'navy' ? COLORS.navy : COLORS.red;
  const wallMat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.45, metalness: 0.1, side: THREE.DoubleSide });
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(b.rOut, b.rOut * 0.94, b.h, 40, 1, true), wallMat);
  wall.position.y = b.h / 2;
  wall.castShadow = true;
  wall.receiveShadow = true;
  g.add(wall);
  const liner = new THREE.Mesh(
    new THREE.CylinderGeometry(b.rIn, b.rIn * 0.94, b.h - 0.004, 40, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.9, side: THREE.BackSide })
  );
  liner.position.y = b.h / 2;
  g.add(liner);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(b.rIn * 0.94, 32), new THREE.MeshStandardMaterial({ color: 0x0c0e11 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.007;
  g.add(floor);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(b.rOut * 0.978, b.rOut * 0.978, 0.022, 40, 1, true), white);
  band.position.y = b.h * 0.55;
  g.add(band);
  const rim = new THREE.Mesh(new THREE.TorusGeometry((b.rIn + b.rOut) / 2, b.tube, 10, 40), white);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = b.h;
  rim.castShadow = true;
  g.add(rim);
  const label = makeTextSprite([{ text: '+' + b.points, size: 96, color: '#ffc72c' }], 0.12);
  label.position.y = b.h + 0.07;
  g.add(label);
  return g;
}

function makeDummyMesh(d) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(d.r, d.h - 2 * d.r, 6, 20),
    new THREE.MeshStandardMaterial({ color: COLORS.navy, roughness: 0.75 })
  );
  body.position.y = d.h / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);
  const band = new THREE.Mesh(
    new THREE.CylinderGeometry(d.r * 1.02, d.r * 1.02, 0.03, 24, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 })
  );
  band.position.y = d.h * 0.5;
  g.add(band);
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(d.r * 1.02, d.r * 1.02, 0.018, 24, 1, true),
    new THREE.MeshStandardMaterial({ color: COLORS.red, roughness: 0.7 })
  );
  cap.position.y = d.h * 0.8;
  g.add(cap);
  const holder = new THREE.Group(); // positioned at the base; tilt is applied here
  holder.add(g);
  const label = makeTextSprite([{ text: '+' + d.points, size: 96, color: '#ffc72c' }], 0.1);
  label.position.y = d.h + 0.06;
  const outer = new THREE.Group();
  outer.add(holder, label);
  outer.userData.holder = holder;
  outer.userData.label = label;
  return outer;
}

function disposeTree(obj) {
  obj.traverse((o) => {
    if (o.geometry && !o.isSprite) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
    }
  });
}

function buildTargets(world) {
  for (const child of [...targetsGroup.children]) {
    targetsGroup.remove(child);
    disposeTree(child);
  }
  T.bins = [];
  T.dummies = [];
  for (const b of world.bins) {
    const mesh = makeBinMesh(b);
    targetsGroup.add(mesh);
    T.bins.push({ data: b, mesh });
  }
  for (const d of world.dummies) {
    const mesh = makeDummyMesh(d);
    targetsGroup.add(mesh);
    T.dummies.push({ data: d, mesh });
  }
  if (T.postLabel) { posts.remove(T.postLabel); disposeTree(T.postLabel); T.postLabel = null; }
  posts.visible = !!world.posts;
  if (world.posts) {
    T.postLabel = makeTextSprite([{ text: 'DROP GOAL +' + world.posts.points, size: 56, color: '#ffc72c' }], 0.16);
    T.postLabel.position.set(0, WORLD.post.uprightH + 0.05, WORLD.post.z);
    posts.add(T.postLabel);
  }
}

// ----- reticle (placement) -----
const reticle = new THREE.Group();
reticle.visible = false;
scene.add(reticle);
const footprint = new THREE.Group();
{
  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD.W, WORLD.L),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, depthWrite: false })
  );
  fill.rotation.x = -Math.PI / 2;
  const hw = WORLD.W / 2, hl = WORLD.L / 2;
  const pts = [new THREE.Vector3(-hw, 0, -hl), new THREE.Vector3(hw, 0, -hl), new THREE.Vector3(hw, 0, hl), new THREE.Vector3(-hw, 0, hl)];
  const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffffff }));
  // arrow showing which way the ball will fly (towards the far end)
  const arrowPts = [new THREE.Vector3(-0.06, 0, -hl + 0.15), new THREE.Vector3(0, 0, -hl + 0.06), new THREE.Vector3(0.06, 0, -hl + 0.15)];
  const arrow = new THREE.Line(new THREE.BufferGeometry().setFromPoints(arrowPts), new THREE.LineBasicMaterial({ color: COLORS.gold }));
  footprint.add(fill, outline, arrow);
}
const reticleRing = new THREE.Mesh(
  new THREE.RingGeometry(0.03, 0.04, 36),
  new THREE.MeshBasicMaterial({ color: COLORS.gold, side: THREE.DoubleSide, depthWrite: false })
);
reticleRing.rotation.x = -Math.PI / 2;
reticle.add(footprint, reticleRing);

// ----- FX: score popups + confetti -----
const fxGroup = new THREE.Group();
pitch.add(fxGroup);
const popups = [];
const confetti = [];
const confettiGeo = new THREE.PlaneGeometry(0.012, 0.007);
const confettiMats = [COLORS.red, COLORS.white, 0x2a5fb0, COLORS.red, COLORS.white].map(
  (c) => new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide })
);

function spawnPopup(label, pts, mult, pos) {
  const lines = [
    { text: label, size: 66, color: '#ffffff' },
    { text: '+' + pts + (mult > 1 ? '  x' + mult : ''), size: 88, color: '#ffc72c' },
  ];
  const sp = makeTextSprite(lines, 0.26);
  sp.position.set(pos.x, pos.y + 0.08, pos.z);
  fxGroup.add(sp);
  popups.push({ sp, age: 0, life: 1.4, y0: sp.position.y, bw: sp.scale.x, bh: sp.scale.y });
}

function spawnConfetti(pos, n = 28) {
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(confettiGeo, confettiMats[i % confettiMats.length]);
    m.position.set(pos.x, pos.y, pos.z);
    m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    fxGroup.add(m);
    const a = Math.random() * Math.PI * 2;
    const sp = 0.25 + Math.random() * 0.45;
    confetti.push({
      m,
      vx: Math.cos(a) * sp,
      vz: Math.sin(a) * sp,
      vy: 0.7 + Math.random() * 0.9,
      spin: (Math.random() - 0.5) * 18,
      age: 0,
      life: 1.1 + Math.random() * 0.5,
    });
  }
}

function updateFx(dt) {
  for (let i = popups.length - 1; i >= 0; i--) {
    const p = popups[i];
    p.age += dt;
    const k = p.age / p.life;
    const rise = 1 - Math.pow(1 - Math.min(k, 1), 3);
    p.sp.position.y = p.y0 + 0.14 * rise;
    const pop = k < 0.12 ? 0.6 + (k / 0.12) * 0.4 : 1;
    p.sp.scale.set(p.bw * pop, p.bh * pop, 1);
    p.sp.material.opacity = k < 0.7 ? 1 : Math.max(0, 1 - (k - 0.7) / 0.3);
    if (p.age >= p.life) {
      fxGroup.remove(p.sp);
      disposeTree(p.sp);
      popups.splice(i, 1);
    }
  }
  for (let i = confetti.length - 1; i >= 0; i--) {
    const c = confetti[i];
    c.age += dt;
    c.vy -= 3.2 * dt;
    c.m.position.x += c.vx * dt;
    c.m.position.y += c.vy * dt;
    c.m.position.z += c.vz * dt;
    c.m.rotation.x += c.spin * dt;
    c.m.rotation.y += c.spin * 0.7 * dt;
    if (c.m.position.y < 0.002) { c.m.position.y = 0.002; c.vy = 0; c.vx *= 0.9; c.vz *= 0.9; }
    if (c.age >= c.life) {
      fxGroup.remove(c.m);
      confetti.splice(i, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Orientation helpers
// ---------------------------------------------------------------------------
const _f = new THREE.Vector3();
const _u = new THREE.Vector3();
const _d = new THREE.Vector3();
/** Horizontal world direction that "up the screen" corresponds to on the table. */
function tableForward(out) {
  _f.set(0, 0, -1).applyQuaternion(camera.quaternion);
  _u.set(0, 1, 0).applyQuaternion(camera.quaternion);
  out.set(_f.x + _u.x, 0, _f.z + _u.z);
  if (out.lengthSq() < 1e-6) out.set(0, 0, -1);
  return out.normalize();
}
function camPhi() {
  tableForward(_d);
  _d.applyAxisAngle(Y, -pitch.rotation.y);
  return phiFromLocalDir(_d.x, _d.z);
}

// Device-orientation -> quaternion (same maths as three's old DeviceOrientationControls)
const _eul = new THREE.Euler();
const _q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const _q0 = new THREE.Quaternion();
const _qTarget = new THREE.Quaternion();
const _qDesktop = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.62, 0, 0));
function gyroQuaternion(out) {
  const o = S.orient;
  const screenAngle = ((screen.orientation && screen.orientation.angle) || window.orientation || 0) * (Math.PI / 180);
  _eul.set(o.beta * (Math.PI / 180), o.alpha * (Math.PI / 180), -o.gamma * (Math.PI / 180), 'YXZ');
  out.setFromEuler(_eul);
  out.multiply(_q1);
  out.multiply(_q0.setFromAxisAngle(Z, -screenAngle));
  return out;
}
function onDeviceOrientation(e) {
  if (e.alpha == null || e.beta == null) return;
  if (!S.hasGyro) { S.hasGyro = true; updateTrackUi(); }
  S.hasGyro = true;
  S.orient.alpha = e.alpha;
  S.orient.beta = e.beta;
  S.orient.gamma = e.gamma || 0;
}

// ---------------------------------------------------------------------------
// Surface lock (camera mode): estimate phone *translation* from the video so the pitch stays put.
// The gyroscope supplies rotation; src/tracker.js tracks table texture to recover movement.
// ---------------------------------------------------------------------------
const TRACK = {
  tracker: null,
  canvas: null,
  ctx: null,
  gray: null,
  w: 0,
  h: 0,
  lastT: 0,
  R: new Float64Array(9),
  target: new THREE.Vector3(),
  quality: 'off', // off | good | weak | lost
  on: true,
};
const _qRaw = new THREE.Quaternion();

function initTracker() {
  const { w, h } = procSize(window.innerWidth / window.innerHeight);
  const keep = TRACK.tracker ? { ...TRACK.tracker.pos } : { x: camera.position.x, y: camera.position.y, z: camera.position.z };
  TRACK.canvas = TRACK.canvas || document.createElement('canvas');
  TRACK.canvas.width = w;
  TRACK.canvas.height = h;
  TRACK.ctx = TRACK.canvas.getContext('2d', { willReadFrequently: true });
  TRACK.gray = new Uint8Array(w * h);
  TRACK.w = w;
  TRACK.h = h;
  TRACK.tracker = new PlaneTracker({ width: w, height: h, fovY: CONFIG.fovY, planeY: -S.drop });
  TRACK.tracker.pos = keep;
  TRACK.target.set(keep.x, keep.y, keep.z);
  TRACK.quality = 'weak';
  updateTrackUi();
}

function stopTracker() {
  TRACK.tracker = null;
  TRACK.quality = 'off';
  TRACK.target.set(0, 0, 0);
  camera.position.set(0, 0, 0);
  updateTrackUi();
}

/** Feed one grayscale frame + the camera->world rotation (row-major 3x3). Used by the video loop and by tests. */
function feedTracker(gray, R) {
  if (!TRACK.tracker) return null;
  const st = TRACK.tracker.update(gray, R);
  TRACK.target.set(st.pos.x, st.pos.y, st.pos.z);
  if (st.quality !== TRACK.quality) {
    TRACK.quality = st.quality;
    updateTrackUi();
  }
  return st;
}

function trackerStep(time) {
  if (!TRACK.tracker || !TRACK.on || !S.stream || !S.hasGyro) return;
  if (time - TRACK.lastT < 30) return; // ~30 fps is plenty
  const v = el.cam;
  if (v.readyState < 2 || !v.videoWidth) return;
  TRACK.lastT = time;
  const c = coverCrop(v.videoWidth, v.videoHeight, window.innerWidth / window.innerHeight); // same crop as object-fit: cover
  TRACK.ctx.drawImage(v, c.sx, c.sy, c.sw, c.sh, 0, 0, TRACK.w, TRACK.h);
  grayFromRGBA(TRACK.ctx.getImageData(0, 0, TRACK.w, TRACK.h).data, TRACK.gray);
  gyroQuaternion(_qRaw); // unsmoothed rotation for the frame
  quatToMat(_qRaw, TRACK.R);
  feedTracker(TRACK.gray, TRACK.R);
}

const TRACK_TEXT = {
  good: 'Surface lock: good',
  weak: 'Surface lock: weak \u2014 move slowly',
  lost: 'Surface lock lost \u2014 aim at the table',
  off: 'Surface lock: off',
};
function updateTrackUi() {
  const active = !!TRACK.tracker && S.hasGyro && S.mode === 'fallback';
  const q = TRACK.on ? TRACK.quality : 'off';
  for (const n of [el.hudTrack, el.placeTrack]) {
    n.hidden = !active;
    n.className = 'track ' + q;
    n.textContent = TRACK_TEXT[q] || '';
  }
  el.btnTrack.hidden = !active;
  el.btnTrack.textContent = TRACK.on ? 'Lock on' : 'Lock off';
}

// ---------------------------------------------------------------------------
// Game wiring
// ---------------------------------------------------------------------------
const POP_LABEL = { bin: 'TRY!', dummy: 'TACKLED!', goal: 'DROP GOAL!' };
const game = new Game(onGameEvent);
let ballPop = 1;
let ballSpin = 0;
let bobT = 0;
const ballQuat = new THREE.Quaternion();
const _dir = new THREE.Vector3();
const _qa = new THREE.Quaternion();
const _qs = new THREE.Quaternion();
const _lastDir = new THREE.Vector3(0, 0, -1);
let resultTimer = 0;

function onGameEvent(type, d) {
  switch (type) {
    case 'start':
      buildTargets(d.world);
      el.hudTitle.textContent = d.def.title;
      showToast(d.def.title, d.def.blurb, 3200);
      Object.assign(lastHud, { score: -1, balls: -1, used: -1, time: -1, mult: -1 });
      break;
    case 'ready':
      ballPop = 0;
      ballSpin = 0;
      ballQuat.setFromUnitVectors(Z, _lastDir.set(0, 0.25, -1).normalize());
      if (!S.coachDone) el.coach.hidden = false;
      break;
    case 'launch':
      sfx.launch(d.power);
      haptic(12);
      S.coachDone = true;
      el.coach.hidden = true;
      break;
    case 'bounce':
      sfx.bounce(d.strength);
      break;
    case 'dummyHit':
      sfx.tackle();
      haptic(25);
      break;
    case 'score': {
      sfx.score(d.mult);
      haptic([30, 40, 30]);
      spawnPopup(POP_LABEL[d.kind] || 'NICE!', d.points, d.mult, { x: d.x, y: d.y, z: d.z });
      spawnConfetti({ x: d.x, y: d.y, z: d.z }, d.kind === 'dummy' ? 14 : 30);
      el.hudScore.classList.add('bump');
      setTimeout(() => el.hudScore.classList.remove('bump'), 220);
      break;
    }
    case 'throwEnd': {
      if (d.scored) break;
      sfx.miss();
      const now = performance.now();
      if (game.timed || now - S.lastHint < 2500) break;
      S.lastHint = now;
      const msg = d.farMiss
        ? 'Too far — try a softer flick'
        : d.short
          ? 'Too short — flick a bit harder'
          : d.touched
            ? 'So close! Go again'
            : 'Aim for a target and flick';
      showHint(msg, 1900);
      break;
    }
    case 'complete':
      sfx.fanfare(d.stars);
      resultTimer = 0.9;
      pendingResult = d;
      break;
    default:
  }
}
let pendingResult = null;

function startChallenge(i) {
  S.level = i;
  el.result.hidden = true;
  setScreen('playing');
  game.startChallenge(i);
}

// ---------------------------------------------------------------------------
// Visual sync
// ---------------------------------------------------------------------------
const _axis = new THREE.Vector3();
function syncTargets() {
  for (const { data, mesh } of T.bins) mesh.position.set(data.x, 0, data.z);
  for (const { data, mesh } of T.dummies) {
    mesh.position.set(data.x, 0, data.z);
    _axis.set(data.tiltZ, 0, -data.tiltX);
    if (_axis.lengthSq() > 1e-8) mesh.userData.holder.quaternion.setFromAxisAngle(_axis.normalize(), data.tilt);
  }
}

function syncBall(dt) {
  const b = game.ball;
  const showBall = b && S.screen !== 'landing' && game.phase !== 'idle' && b.state !== 'lost' && b.y > -0.3;
  ballGroup.visible = !!showBall;
  ballBlob.visible = !!showBall;
  startRing.visible = !!b && game.phase === 'ready' && S.screen === 'playing';
  if (!showBall) return;

  bobT += dt;
  ballPop = Math.min(ballPop + dt / 0.3, 1);
  const c1 = 1.70158, c3 = c1 + 1;
  const pop = 1 + c3 * Math.pow(ballPop - 1, 3) + c1 * Math.pow(ballPop - 1, 2);

  if (game.phase === 'ready') {
    const lift = S.grab ? 0.03 : 0.012 + 0.008 * Math.sin(bobT * 3.2);
    ballGroup.position.set(b.x, b.y + lift, b.z);
    _dir.set(0, 0.25, -1).normalize();
    _qa.setFromUnitVectors(Z, _dir);
    ballQuat.slerp(_qa, 0.25);
    ballGroup.quaternion.copy(ballQuat);
    ballGroup.scale.setScalar(Math.max(pop, 0.001) * (S.grab ? 1.12 : 1));
    startRing.material.opacity = 0.5 + 0.35 * Math.sin(bobT * 4);
    startRing.scale.setScalar(1 + 0.06 * Math.sin(bobT * 4));
    ballBlob.position.set(b.x, 0.0016, b.z);
    ballBlob.scale.setScalar(0.9);
    ballBlob.material.opacity = 0.35;
    return;
  }

  ballGroup.position.set(b.x, b.y, b.z);
  ballGroup.scale.setScalar(1);
  const speed = Math.hypot(b.vx, b.vy, b.vz);
  if (b.state === 'flying' && speed > 0.15) {
    _dir.set(b.vx, b.vy, b.vz).normalize();
    const airborne = b.y > WORLD.ballR + 0.004;
    if (!airborne) {
      _dir.y = 0;
      if (_dir.lengthSq() < 1e-4) _dir.copy(_lastDir);
      _dir.normalize();
    }
    _lastDir.copy(_dir);
    _qa.setFromUnitVectors(Z, _dir);
    if (airborne) ballSpin += dt * 16; // spiral pass
    _qs.setFromAxisAngle(Z, ballSpin);
    _qa.multiply(_qs);
    ballQuat.slerp(_qa, airborne ? 0.6 : 0.25);
  }
  ballGroup.quaternion.copy(ballQuat);

  const onPitch = Math.abs(b.x) < WORLD.W / 2 + 0.01 && Math.abs(b.z) < WORLD.L / 2 + 0.01;
  ballBlob.visible = onPitch && b.state !== 'captured';
  const k = 1 / (1 + Math.max(b.y - WORLD.ballR, 0) * 7);
  ballBlob.position.set(b.x, 0.0016, b.z);
  ballBlob.scale.setScalar(0.9 * k);
  ballBlob.material.opacity = 0.38 * k;
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const lastHud = { score: -1, balls: -1, used: -1, time: -1, mult: -1 };
function updateHud() {
  if (game.score !== lastHud.score) {
    el.hudScore.textContent = String(game.score);
    lastHud.score = game.score;
  }
  if (game.timed) {
    el.hudBalls.hidden = true;
    el.hudTimer.hidden = false;
    const t = Math.ceil(game.timerStarted ? game.timeLeft : game.def.time);
    if (t !== lastHud.time) {
      el.hudTimer.textContent = t + 's';
      el.hudTimer.classList.toggle('low', game.timerStarted && t <= 8);
      lastHud.time = t;
    }
  } else {
    el.hudTimer.hidden = true;
    el.hudBalls.hidden = false;
    const total = game.def.balls;
    if (lastHud.balls !== total) {
      el.hudBalls.innerHTML = '';
      for (let i = 0; i < total; i++) el.hudBalls.appendChild(document.createElement('i'));
      lastHud.balls = total;
      lastHud.used = -1;
    }
    if (lastHud.used !== game.ballsUsed) {
      [...el.hudBalls.children].forEach((n, i) => n.classList.toggle('used', i < game.ballsUsed));
      lastHud.used = game.ballsUsed;
    }
  }
  const mult = game.streak >= 1 ? Math.min(3, 1 + game.streak) : 0;
  if (mult !== lastHud.mult) {
    el.hudMult.hidden = mult === 0;
    if (mult) {
      el.hudMult.textContent = 'x' + mult;
      el.hudMult.style.animation = 'none';
      void el.hudMult.offsetWidth;
      el.hudMult.style.animation = '';
    }
    lastHud.mult = mult;
  }
}

let toastTimer = 0;
function showToast(title, text, ms = 2500) {
  el.toastTitle.textContent = title;
  el.toastText.textContent = text;
  el.toast.hidden = false;
  el.toast.style.animation = 'none';
  void el.toast.offsetWidth;
  el.toast.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), ms);
}
let hintTimer = 0;
function showHint(text, ms = 2000) {
  el.hudHint.textContent = text;
  el.hudHint.hidden = false;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => (el.hudHint.hidden = true), ms);
}

function setScreen(name) {
  S.screen = name;
  el.landing.hidden = name !== 'landing';
  el.placing.hidden = name !== 'placing';
  el.hud.hidden = !(name === 'playing' || name === 'result');
  el.result.hidden = name !== 'result';
  if (name !== 'playing') {
    el.coach.hidden = true;
    el.hudHint.hidden = true;
    if (name !== 'result') el.toast.hidden = true;
  }
  if (name !== 'placing') el.touch.style.cursor = '';
}

function showResult(d) {
  setScreen('result');
  $('res-title').textContent = d.def.title;
  $('res-score').textContent = String(d.score);
  $('res-stars').innerHTML = [1, 2, 3].map((n) => `<span class="${d.stars >= n ? 'on' : ''}">★</span>`).join('');
  $('res-kicker').textContent = d.def.time ? 'Full time' : 'Challenge complete';
  $('res-msg').textContent =
    d.stars === 3 ? 'Pure class. That’s a perfect performance.' :
    d.stars === 2 ? 'Nicely done — one more push for three stars.' :
    d.stars === 1 ? 'You’re a natural. Can you beat it?' :
    'Not quite — have another go, you’ll nail it.';
  const next = $('btn-next');
  next.textContent = d.last ? 'Play from the start' : 'Next challenge';
  const nextIsPrimary = d.stars > 0 || d.last;
  next.className = 'btn ' + (nextIsPrimary ? 'primary' : 'ghost');
  $('btn-retry').className = 'btn ' + (nextIsPrimary ? 'ghost' : 'primary');
  const cta = $('btn-cta');
  if (CONFIG.ctaUrl && d.stars > 0) {
    cta.href = CONFIG.ctaUrl;
    cta.textContent = CONFIG.ctaText;
    cta.hidden = false;
  } else cta.hidden = true;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _hitPos = new THREE.Vector3();

function setPlaceState(valid) {
  if (valid === S.hitValid) return;
  S.hitValid = valid;
  el.placeTop.classList.toggle('ready', valid);
  el.placeTitle.textContent = valid ? 'Tap to place your pitch' : 'Scan your table';
  el.placeSub.textContent = valid
    ? 'The arrow shows which way you’ll flick. Pick a flat spot.'
    : 'Point your camera at a flat surface and move slowly.';
}

function updatePlacementXR(frame) {
  if (!frame || !S.hitSource) return;
  const results = frame.getHitTestResults(S.hitSource);
  let valid = false;
  if (results.length) {
    const pose = results[0].getPose(renderer.xr.getReferenceSpace());
    if (pose) {
      _m.fromArray(pose.transform.matrix);
      _m.decompose(_p, _q, _s);
      const upY = _u.set(0, 1, 0).applyQuaternion(_q).y;
      if (upY > 0.85) {
        valid = true;
        if (!reticle.visible) _hitPos.copy(_p);
        else _hitPos.lerp(_p, 0.35);
        reticle.position.copy(_hitPos);
      }
    }
  }
  reticle.visible = valid;
  setPlaceState(valid);
}

function updatePlacementFallback() {
  tableForward(_d);
  const dir = _f.set(0, 0, -1).applyQuaternion(camera.quaternion);
  const cp = camera.position;
  let x, z;
  if (dir.y < -0.12) {
    const t = Math.min((-S.drop - cp.y) / dir.y, 2.2);
    x = cp.x + dir.x * t;
    z = cp.z + dir.z * t;
  } else {
    x = cp.x + _d.x * 0.8;
    z = cp.z + _d.z * 0.8;
  }
  reticle.position.set(x, -S.drop, z);
  reticle.visible = true;
  setPlaceState(true);
}

function updateReticleVisual(time) {
  if (!reticle.visible) return;
  tableForward(_d);
  reticle.rotation.y = yawForForward(_d.x, _d.z);
  footprint.scale.setScalar(S.scale);
  reticleRing.scale.setScalar(1 + 0.12 * Math.sin(time / 220));
}

function placePitch() {
  pitch.position.copy(reticle.position);
  pitch.rotation.set(0, reticle.rotation.y, 0);
  pitch.scale.setScalar(S.scale);
  pitch.visible = true;
  reticle.visible = false;
  S.placed = true;
  stopHitTest();
  startChallenge(S.level);
}

function goPlacing() {
  S.placed = false;
  S.hitValid = false;
  pitch.visible = false;
  reticle.visible = false;
  ballGroup.visible = false;
  ballBlob.visible = false;
  el.placeTop.classList.remove('ready');
  el.placeTitle.textContent = S.mode === 'xr' ? 'Scan your table' : 'Aim at your table';
  el.placeSub.textContent =
    S.mode === 'xr'
      ? 'Point your camera at a flat surface and move slowly.'
      : 'Tilt your phone down at the table, then tap to drop the pitch.';
  $('seg-height-place').hidden = S.mode !== 'fallback';
  $('seg-height').hidden = S.mode !== 'fallback';
  game.phase = 'idle';
  setScreen('placing');
  if (S.mode === 'xr' && S.xrSession) startHitTest(S.xrSession);
}

async function startHitTest(session) {
  if (S.hitSource) return;
  try {
    const viewer = await session.requestReferenceSpace('viewer');
    S.hitSource = await session.requestHitTestSource({ space: viewer });
  } catch (err) {
    console.warn('hit-test unavailable', err);
    showToast('Surface detection failed', 'Try camera mode from the start screen.', 4000);
  }
}
function stopHitTest() {
  if (S.hitSource) {
    try { S.hitSource.cancel(); } catch (_) { /* already gone */ }
    S.hitSource = null;
  }
}

// ---------------------------------------------------------------------------
// Flick input
// ---------------------------------------------------------------------------
const drag = { active: false, id: null, x0: 0, y0: 0, t0: 0, samples: [] };
el.overlay.addEventListener('beforexrselect', (e) => e.preventDefault());

el.touch.addEventListener('pointerdown', (e) => {
  if (drag.active) return;
  drag.active = true;
  drag.id = e.pointerId;
  drag.x0 = e.clientX;
  drag.y0 = e.clientY;
  drag.t0 = e.timeStamp;
  drag.samples = [{ x: e.clientX, y: e.clientY, t: e.timeStamp }];
  try { el.touch.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  S.grab = S.screen === 'playing' && game.phase === 'ready';
  sfx.unlock();
});
el.touch.addEventListener('pointermove', (e) => {
  if (!drag.active || e.pointerId !== drag.id) return;
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  for (const ce of events.length ? events : [e]) drag.samples.push({ x: ce.clientX, y: ce.clientY, t: ce.timeStamp });
  if (drag.samples.length > 24) drag.samples.splice(0, drag.samples.length - 24);
});
const endDrag = (e, cancelled) => {
  if (!drag.active || e.pointerId !== drag.id) return;
  drag.active = false;
  S.grab = false;
  if (cancelled) return;
  const last = { x: e.clientX, y: e.clientY, t: e.timeStamp };
  drag.samples.push(last);
  const dist = Math.hypot(last.x - drag.x0, last.y - drag.y0);
  const dur = last.t - drag.t0;

  if (S.screen === 'placing') {
    if (dist < 16 && dur < 700 && (S.mode !== 'xr' || S.hitValid)) placePitch();
    return;
  }
  if (S.screen !== 'playing' || game.phase !== 'ready' || dist < 28) return;

  const cutoff = last.t - 90;
  let first = drag.samples.find((s) => s.t >= cutoff) || drag.samples[0];
  if (first === last) first = drag.samples[Math.max(0, drag.samples.length - 2)];
  const dt = Math.max(16, last.t - first.t) / 1000;
  const H = window.innerHeight;
  const swipe = { vx: (last.x - first.x) / dt / H, vy: (last.y - first.y) / dt / H };
  const v = flickToVelocity(swipe, camPhi());
  if (!v) {
    showHint('Flick upwards, towards the far end', 1800);
    return;
  }
  game.flick(v);
};
el.touch.addEventListener('pointerup', (e) => endDrag(e, false));
el.touch.addEventListener('pointercancel', (e) => endDrag(e, true));
el.touch.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------------------------------------------------------------------
// Session start / stop
// ---------------------------------------------------------------------------
function requestOrientationPermission() {
  const D = window.DeviceOrientationEvent;
  if (D && typeof D.requestPermission === 'function') {
    return D.requestPermission().then((r) => r === 'granted').catch(() => false);
  }
  return Promise.resolve(true);
}

async function startXR() {
  try {
    renderer.xr.setReferenceSpaceType('local');
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: el.overlay },
    });
    if (!session.domOverlayState) {
      // Without DOM overlay the HUD would be invisible, so don't pretend AR works.
      await session.end();
      el.capNote.textContent = 'This browser can’t show the game controls in AR — using camera mode.';
      return startFallback(true);
    }
    await renderer.xr.setSession(session);
    S.xrSession = session;
    S.mode = 'xr';
    session.addEventListener('end', onXREnd);
    goPlacing();
  } catch (err) {
    console.warn('WebXR failed, falling back', err);
    el.capNote.textContent = 'AR couldn’t start (' + (err && err.name ? err.name : 'error') + ') — using camera mode.';
    startFallback(true);
  }
}

function onXREnd() {
  stopHitTest();
  S.xrSession = null;
  S.mode = null;
  game.phase = 'idle';
  pitch.visible = false;
  reticle.visible = false;
  ballGroup.visible = false;
  ballBlob.visible = false;
  setScreen('landing');
  renderer.setSize(window.innerWidth, window.innerHeight);
}

async function startFallback(withCamera) {
  sfx.unlock();
  const orientP = requestOrientationPermission(); // must be called inside the user gesture (iOS)
  S.mode = 'fallback';
  camera.position.set(0, 0, 0);
  if (withCamera && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try {
      S.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      el.cam.srcObject = S.stream;
      await el.cam.play().catch(() => {});
      el.cam.classList.add('on');
      initTracker();
    } catch (err) {
      console.warn('camera unavailable', err);
      showToast('No camera', 'Running in preview mode instead.', 2600);
    }
  }
  const granted = await orientP;
  if (granted) window.addEventListener('deviceorientation', onDeviceOrientation);
  goPlacing();
}

function stopFallback() {
  window.removeEventListener('deviceorientation', onDeviceOrientation);
  stopTracker();
  S.hasGyro = false;
  if (S.stream) {
    S.stream.getTracks().forEach((t) => t.stop());
    S.stream = null;
  }
  el.cam.srcObject = null;
  el.cam.classList.remove('on');
}

function exitToLanding() {
  game.phase = 'idle';
  if (S.mode === 'xr' && S.xrSession) {
    S.xrSession.end(); // onXREnd takes it from here
    return;
  }
  stopFallback();
  S.mode = null;
  pitch.visible = false;
  reticle.visible = false;
  ballGroup.visible = false;
  ballBlob.visible = false;
  setScreen('landing');
}

// ---------------------------------------------------------------------------
// UI bindings
// ---------------------------------------------------------------------------
function bindSizeButtons(rootId) {
  $(rootId).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-s]');
    if (!b) return;
    S.scale = parseFloat(b.dataset.s);
    document.querySelectorAll('[data-s]').forEach((n) => n.classList.toggle('on', parseFloat(n.dataset.s) === S.scale));
    if (S.placed) pitch.scale.setScalar(S.scale);
    sfx.unlock();
  });
}
bindSizeButtons('seg-size');
bindSizeButtons('seg-size-place');

function nudgeHeight(dy) {
  S.drop = Math.min(1.2, Math.max(0.15, S.drop - dy));
  if (S.placed) pitch.position.y = -S.drop;
  if (TRACK.tracker) TRACK.tracker.setPlane(-S.drop);
}
$('h-up').addEventListener('click', () => nudgeHeight(0.04));
$('h-down').addEventListener('click', () => nudgeHeight(-0.04));
$('hp-up').addEventListener('click', () => nudgeHeight(0.04));
$('hp-down').addEventListener('click', () => nudgeHeight(-0.04));

$('btn-replace').addEventListener('click', () => {
  goPlacing();
});
$('btn-place-exit').addEventListener('click', exitToLanding);
$('btn-exit').addEventListener('click', exitToLanding);
el.btnTrack.addEventListener('click', () => {
  TRACK.on = !TRACK.on;
  if (TRACK.on && TRACK.tracker) {
    TRACK.tracker.pos = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
    TRACK.tracker.resetMap();
    TRACK.quality = 'weak';
  }
  updateTrackUi();
});
$('btn-sound').addEventListener('click', (e) => {
  sfx.on = !sfx.on;
  sfx.unlock();
  e.currentTarget.textContent = sfx.on ? 'Sound on' : 'Sound off';
});
$('btn-next').addEventListener('click', () => {
  const last = S.level >= CHALLENGES.length - 1;
  startChallenge(last ? 0 : S.level + 1);
});
$('btn-retry').addEventListener('click', () => startChallenge(S.level));

el.btnStart.addEventListener('click', () => {
  sfx.unlock();
  if (S.xrSupported) startXR();
  else startFallback(true);
});
el.btnAlt.addEventListener('click', () => {
  sfx.unlock();
  startFallback(S.xrSupported); // with XR available "camera mode"; otherwise "preview without camera"
});

async function detectCapabilities() {
  let xr = false;
  try {
    // Never let a slow or silent XR check leave the Start button disabled.
    const timeout = new Promise((resolve) => setTimeout(() => resolve(false), 1500));
    xr = !!(navigator.xr && (await Promise.race([navigator.xr.isSessionSupported('immersive-ar'), timeout])));
  } catch (_) { xr = false; }
  S.xrSupported = xr && window.isSecureContext;
  if (!window.isSecureContext) {
    el.capNote.textContent = 'AR needs HTTPS. Open the deployed link rather than a local file.';
  }
  if (S.xrSupported) {
    el.btnStart.textContent = 'Start AR';
    el.btnAlt.textContent = 'Use camera mode instead';
    el.btnAlt.hidden = false;
    el.capNote.textContent = 'Surface detection is available on this device.';
  } else {
    el.btnStart.textContent = 'Start (camera mode)';
    el.btnAlt.textContent = 'Preview without camera';
    el.btnAlt.hidden = false;
    if (window.isSecureContext)
      el.capNote.textContent =
        'True surface detection needs Chrome on a recent Android phone. Here you’ll get camera mode: the pitch is placed using your phone’s motion sensors.';
  }
  el.btnStart.disabled = false;
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
let lastT = 0;
renderer.setAnimationLoop((time, frame) => {
  const dt = Math.min(0.05, lastT ? (time - lastT) / 1000 : 0.016);
  lastT = time;

  if (S.mode === 'fallback') {
    if (S.hasGyro) camera.quaternion.slerp(gyroQuaternion(_qTarget), 0.35);
    else camera.quaternion.copy(_qDesktop);
    if (TRACK.tracker && TRACK.on) {
      trackerStep(time);
      camera.position.lerp(TRACK.target, 0.5); // light smoothing on top of the tracker output
    }
  }

  if (S.screen === 'placing') {
    if (S.mode === 'xr') updatePlacementXR(frame);
    else if (S.mode === 'fallback') updatePlacementFallback();
    updateReticleVisual(time);
  }

  if (S.screen === 'playing' || S.screen === 'result') {
    if (S.screen === 'playing') game.update(dt);
    syncTargets();
    syncBall(dt);
    updateFx(dt);
    if (S.screen === 'playing') updateHud();
    if (pendingResult && S.screen === 'playing') {
      resultTimer -= dt;
      if (resultTimer <= 0) {
        const r = pendingResult;
        pendingResult = null;
        showResult(r);
      }
    }
  }

  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  if (renderer.xr.isPresenting) return;
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  if (TRACK.tracker) initTracker();
});

setScreen('landing');
detectCapabilities();

// Handy for debugging from the console / remote inspector.
window.__pocketPitch = { game, S, scene, pitch, CHALLENGES, camera, TRACK, initTracker, feedTracker, updateTrackUi };

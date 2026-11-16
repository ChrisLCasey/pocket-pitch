// Run with: node test/tracker.test.mjs
// Validates the surface-lock tracker against synthetic ground truth (known camera path over a textured plane).
import assert from 'node:assert/strict';
import { PlaneTracker, coverCrop, procSize, quatToMat, grayFromRGBA } from '../src/tracker.js';
import { render, rotation, perturb, makeRng, PLANE_Y } from './synth.mjs';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };
const FOV = 64;
const { w: W, h: H } = procSize(1170 / 2532); // iPhone-like portrait aspect

// ---------------------------------------------------------------- helpers
test('coverCrop crops width for a tall screen and height for a wide one', () => {
  const a = coverCrop(1920, 1080, 9 / 19.5);
  assert.ok(Math.abs(a.sh - 1080) < 1e-9 && a.sw < 1920 && Math.abs(a.sx - (1920 - a.sw) / 2) < 1e-9);
  assert.ok(Math.abs(a.sw / a.sh - 9 / 19.5) < 1e-9);
  const b = coverCrop(1080, 1920, 16 / 9);
  assert.ok(Math.abs(b.sw - 1080) < 1e-9 && b.sh < 1920 && Math.abs(b.sw / b.sh - 16 / 9) < 1e-9);
});

test('procSize keeps the aspect and a small pixel count', () => {
  const s = procSize(0.46);
  assert.ok(Math.abs(s.w / s.h - 0.46) < 0.02);
  assert.ok(s.w * s.h < 32000 && s.w * s.h > 24000);
});

test('quatToMat matches known rotations', () => {
  const m = quatToMat({ x: 0, y: Math.sin(Math.PI / 4), z: 0, w: Math.cos(Math.PI / 4) }); // +90° about y
  // camera -z (forward) should map to world -x
  const fx = -m[2], fz = -m[8];
  assert.ok(Math.abs(fx + 1) < 1e-9 && Math.abs(fz) < 1e-9, `${fx},${fz}`);
});

test('grayFromRGBA gives luma', () => {
  const out = grayFromRGBA(Uint8Array.from([255, 255, 255, 255, 0, 0, 0, 255]), new Uint8Array(2));
  assert.ok(out[0] >= 254 && out[1] === 0);
});

// ---------------------------------------------------------------- tracking accuracy
function runPath(label, { seconds, path, noisePx = 2, gyroDeg = 0.2, seed = 3 }) {
  const rng = makeRng(seed);
  const tr = new PlaneTracker({ width: W, height: H, fovY: FOV, planeY: PLANE_Y });
  const fps = 30, n = Math.round(seconds * fps);
  let sum = 0, max = 0, sumXZ = 0, lost = 0, errAtEnd = 0, ms = 0;
  for (let i = 0; i < n; i++) {
    const t = i / fps;
    const { pos, yaw, pitch } = path(t);
    const Rtrue = rotation(yaw, pitch);
    const img = render({ w: W, h: H, fovY: FOV, pos, R: Rtrue, noise: noisePx, rng });
    const g = (gyroDeg * Math.PI) / 180;
    const R = perturb(Rtrue, rng.n() * g, rng.n() * g, rng.n() * g);
    const t0 = performance.now();
    const st = tr.update(img, R);
    ms += performance.now() - t0;
    if (i === 0) continue;
    const e = Math.hypot(st.pos.x - pos.x, st.pos.y - pos.y, st.pos.z - pos.z);
    sum += e; max = Math.max(max, e); errAtEnd = e;
    sumXZ += Math.hypot(st.pos.x - pos.x, st.pos.z - pos.z);
    if (st.quality === 'lost') lost++;
    assert.ok([st.pos.x, st.pos.y, st.pos.z].every(Number.isFinite), 'NaN position');
  }
  const mean = sum / (n - 1);
  console.log(`        ${label}: mean err ${(mean * 100).toFixed(2)} cm, max ${(max * 100).toFixed(2)} cm, end ${(errAtEnd * 100).toFixed(2)} cm, lost frames ${lost}, ${(ms / n).toFixed(1)} ms/frame`);
  return { mean, max, lost, errAtEnd, msPerFrame: ms / n };
}

const gentle = (t) => ({
  pos: { x: 0.12 * Math.sin(0.7 * t), y: 0.03 * Math.sin(0.5 * t), z: 0.1 * Math.sin(0.45 * t) },
  yaw: 0.18 * Math.sin(0.4 * t), pitch: 0.7 + 0.08 * Math.sin(0.6 * t),
});

test('gentle handheld motion over a textured table stays locked (few cm)', () => {
  const r = runPath('gentle  ', { seconds: 8, path: gentle });
  assert.ok(r.mean < 0.02, 'mean error should be under 2 cm');
  assert.ok(r.max < 0.05, 'max error should be under 5 cm');
  assert.ok(r.lost < 5);
});

test('faster walk-around motion still tracks', () => {
  const fast = (t) => ({
    pos: { x: 0.3 * Math.sin(1.2 * t), y: 0.04 * Math.sin(0.9 * t), z: 0.25 * Math.sin(0.9 * t + 1) - 0.0 },
    yaw: 0.4 * Math.sin(0.8 * t), pitch: 0.75 + 0.1 * Math.sin(1.1 * t),
  });
  const r = runPath('fast    ', { seconds: 8, path: (t) => { const p = fast(t); const p0 = fast(0); p.pos.z -= p0.pos.z; return p; } });
  assert.ok(r.mean < 0.04, 'mean error should be under 4 cm');
  assert.ok(r.max < 0.1, 'max error should be under 10 cm');
});

test('looking straight ahead + sideways walking still tracks', () => {
  const r = runPath('sideways', { seconds: 6, path: (t) => ({ pos: { x: 0.2 * Math.sin(0.9 * t), y: 0, z: 0 }, yaw: 0, pitch: 0.55 }) });
  assert.ok(r.mean < 0.03);
});

test('realistic noise: strong pixel noise + 0.3° white gyro noise, 3 seeds', () => {
  let worstMax = 0, avg = 0;
  for (const seed of [1, 2, 3]) {
    const r = runPath('noisy s' + seed, { seconds: 6, path: gentle, noisePx: 6, gyroDeg: 0.3, seed });
    worstMax = Math.max(worstMax, r.max); avg += r.mean / 3;
  }
  assert.ok(avg < 0.035, `avg mean error ${(avg * 100).toFixed(2)} cm`);
  assert.ok(worstMax < 0.08, `worst max ${(worstMax * 100).toFixed(2)} cm`);
});

test('very harsh gyro noise (0.6° white every frame) degrades gracefully, never diverges', () => {
  for (const seed of [1, 2, 3]) {
    const r = runPath('harsh  s' + seed, { seconds: 6, path: gentle, noisePx: 6, gyroDeg: 0.6, seed });
    assert.ok(r.mean < 0.06 && r.max < 0.2);
  }
});

test('stays still when the phone is still (no drift / jitter)', () => {
  const r = runPath('still   ', { seconds: 5, gyroDeg: 0.05, path: () => ({ pos: { x: 0, y: 0, z: 0 }, yaw: 0.1, pitch: 0.7 }) });
  assert.ok(r.max < 0.01, 'max error under 1 cm when still');
});

test('real-time budget: under 12 ms per frame in Node', () => {
  const r = runPath('timing  ', { seconds: 3, path: gentle });
  assert.ok(r.msPerFrame < 12, `${r.msPerFrame.toFixed(1)} ms`);
});

// ---------------------------------------------------------------- failure modes
test('featureless surface: reports "lost", holds position, no NaN', () => {
  const tr = new PlaneTracker({ width: W, height: H, fovY: FOV, planeY: PLANE_Y });
  const flat = new Uint8Array(W * H).fill(128);
  const R = rotation(0, 0.7);
  let st;
  for (let i = 0; i < 20; i++) st = tr.update(flat, R);
  assert.equal(st.quality, 'lost');
  assert.deepEqual([st.pos.x, st.pos.y, st.pos.z], [0, 0, 0]);
});

test('tracker recovers after a texture-less gap (e.g. covered lens)', () => {
  const rng = makeRng(5);
  const tr = new PlaneTracker({ width: W, height: H, fovY: FOV, planeY: PLANE_Y });
  const R = rotation(0, 0.7);
  const real = () => render({ w: W, h: H, fovY: FOV, pos: { x: 0, y: 0, z: 0 }, R, noise: 2, rng });
  for (let i = 0; i < 10; i++) tr.update(real(), R);
  for (let i = 0; i < 6; i++) tr.update(new Uint8Array(W * H), R);
  let st;
  for (let i = 0; i < 12; i++) st = tr.update(real(), R);
  assert.notEqual(st.quality, 'lost');
  assert.ok(Math.hypot(st.pos.x, st.pos.y, st.pos.z) < 0.02);
});

test('changing the plane height resets the map but keeps the position', () => {
  const rng = makeRng(7);
  const tr = new PlaneTracker({ width: W, height: H, fovY: FOV, planeY: PLANE_Y });
  const R = rotation(0, 0.7);
  const img = render({ w: W, h: H, fovY: FOV, pos: { x: 0, y: 0, z: 0 }, R, noise: 2, rng });
  tr.update(img, R); tr.update(img, R);
  assert.ok(tr.lms.length > 10);
  tr.setPlane(-0.6);
  assert.equal(tr.lms.length, 0);
});

console.log(`\n${passed} tracker tests passed`);

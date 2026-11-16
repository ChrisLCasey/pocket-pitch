// Synthetic "camera" used to validate the surface-lock tracker against known ground truth.
// Renders a procedurally textured horizontal plane as seen by a pinhole camera with a given pose.

export const PLANE_Y = -0.5;

function hash(ix, iz, seed) {
  let h = (ix * 374761393 + iz * 668265263 + seed * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}
function vnoise(x, z, scale, seed) {
  const gx = x / scale, gz = z / scale;
  const ix = Math.floor(gx), iz = Math.floor(gz);
  const fx = gx - ix, fz = gz - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz, seed), b = hash(ix + 1, iz, seed), c = hash(ix, iz + 1, seed), d = hash(ix + 1, iz + 1, seed);
  return (a * (1 - sx) + b * sx) * (1 - sz) + (c * (1 - sx) + d * sx) * sz;
}
/** Table-like texture: three octaves of value noise (3 cm … 16 cm features). */
export function planeTexture(x, z) {
  return 40 + 175 * (0.5 * vnoise(x, z, 0.03, 1) + 0.3 * vnoise(x, z, 0.07, 2) + 0.2 * vnoise(x, z, 0.16, 3));
}
/** Distant scenery (infinitely far, so it only moves with rotation). Used to create outliers. */
function sky(dx, dy, dz) {
  const l = Math.hypot(dx, dy, dz);
  return 60 + 140 * vnoise(Math.atan2(dx, -dz) * 10, (dy / l) * 10, 0.4, 9);
}

/** Row-major camera->world rotation for yaw (about +y) then pitch-down (about camera x). */
export function rotation(yaw, pitchDown) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(-pitchDown), sp = Math.sin(-pitchDown);
  // Ry * Rx(-pitchDown)
  return Float64Array.from([
    cy, sy * sp, sy * cp,
    0, cp, -sp,
    -sy, cy * sp, cy * cp,
  ]);
}

/** Small random rotation error (radians) applied on top of R — emulates gyro noise. */
export function perturb(R, rx, ry, rz) {
  const mul = (A, B) => {
    const o = new Float64Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[3 * i + j] = A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j];
    return o;
  };
  const E = Float64Array.from([1, -rz, ry, rz, 1, -rx, -ry, rx, 1]);
  return mul(E, R);
}

export function makeRng(seed = 1) {
  let s = seed >>> 0;
  const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const n = () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
  return { u, n };
}

export function render({ w, h, fovY, pos, R, noise = 0, rng = null }) {
  const f = h / 2 / Math.tan((fovY * Math.PI) / 360);
  const out = new Uint8Array(w * h);
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const cx = (u + 0.5 - w / 2) / f, cy = -(v + 0.5 - h / 2) / f, cz = -1;
      const dx = R[0] * cx + R[1] * cy + R[2] * cz;
      const dy = R[3] * cx + R[4] * cy + R[5] * cz;
      const dz = R[6] * cx + R[7] * cy + R[8] * cz;
      let val;
      const t = dy < -0.02 ? (PLANE_Y - pos.y) / dy : -1;
      if (t > 0 && t < 6) val = planeTexture(pos.x + t * dx, pos.z + t * dz);
      else val = sky(dx, dy, dz);
      if (noise && rng) val += rng.n() * noise;
      out[v * w + u] = Math.max(0, Math.min(255, val));
    }
  }
  return out;
}

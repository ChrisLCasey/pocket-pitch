// Pocket Pitch — "surface lock" for camera mode (iPhone / any browser without WebXR AR).
//
// The gyroscope tells us how the phone is ROTATING but nothing about how it MOVES, so a pitch placed
// with rotation alone slides around as soon as the phone translates. This module estimates the
// translation from the camera video:
//
//   1. Track texture points on the table with pyramidal Lucas-Kanade optical flow.
//      The gyro rotation is used to predict where each point should appear, so large turns are fine.
//   2. Each tracked point lives on the (horizontal) table plane, so its 3D position is known once it
//      has been seen from a known pose. We then solve for the camera position that best explains
//      where all points are observed (robust Gauss-Newton, Huber loss).
//
// Scale needs no calibration: the plane height is an assumption, and a wrong assumption only scales the
// camera motion consistently, which leaves the pitch visually locked to the real surface.
//
// Pure JS, no DOM, no three.js — it is unit-tested in Node (see test/tracker.test.mjs).

// ------------------------------------------------------------------ small helpers
/** Source rectangle of a w×h video that `object-fit: cover` shows on a screen of the given aspect (w/h). */
export function coverCrop(vw, vh, aspect) {
  if (vw / vh > aspect) {
    const sw = vh * aspect;
    return { sx: (vw - sw) / 2, sy: 0, sw, sh: vh };
  }
  const sh = vw / aspect;
  return { sx: 0, sy: (vh - sh) / 2, sw: vw, sh };
}

/** Processing resolution for a given screen aspect: ~28k pixels keeps tracking cheap on phones. */
export function procSize(aspect, pixels = 28000) {
  const w = Math.max(32, Math.round(Math.sqrt(pixels * aspect)));
  return { w, h: Math.max(32, Math.round(w / aspect)) };
}

/** Quaternion {x,y,z,w} (camera->world) to a row-major 3x3 matrix. */
export function quatToMat({ x, y, z, w }, out = new Float64Array(9)) {
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  out[0] = 1 - 2 * (yy + zz); out[1] = 2 * (xy - wz); out[2] = 2 * (xz + wy);
  out[3] = 2 * (xy + wz); out[4] = 1 - 2 * (xx + zz); out[5] = 2 * (yz - wx);
  out[6] = 2 * (xz - wy); out[7] = 2 * (yz + wx); out[8] = 1 - 2 * (xx + yy);
  return out;
}

/** RGBA bytes -> 8-bit luma. */
export function grayFromRGBA(rgba, out) {
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return out;
}

function buildPyramid(gray, w, h, levels) {
  const base = new Float32Array(w * h);
  for (let i = 0; i < base.length; i++) base[i] = gray[i];
  const pyr = [{ d: base, w, h }];
  for (let L = 1; L < levels; L++) {
    const p = pyr[L - 1];
    const nw = p.w >> 1, nh = p.h >> 1;
    const d = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const i = 2 * y * p.w + 2 * x;
        d[y * nw + x] = 0.25 * (p.d[i] + p.d[i + 1] + p.d[i + p.w] + p.d[i + p.w + 1]);
      }
    }
    pyr.push({ d, w: nw, h: nh });
  }
  return pyr;
}

function samp(img, x, y) {
  const w = img.w;
  if (x < 0) x = 0; else if (x > w - 1.001) x = w - 1.001;
  if (y < 0) y = 0; else if (y > img.h - 1.001) y = img.h - 1.001;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0, d = img.d;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + w] * (1 - fx) + d[i + w + 1] * fx) * fy;
}

// ------------------------------------------------------------------ Lucas-Kanade
const WIN = 4; // half-window => 9×9 patch
const NPIX = (2 * WIN + 1) * (2 * WIN + 1);
const _Ix = new Float32Array(NPIX), _Iy = new Float32Array(NPIX), _T = new Float32Array(NPIX);
const MIN_EIG = 12;

/** Track one point from `prev` to `cur` pyramids. (gx,gy) is the expected full-resolution displacement. */
function lkTrack(prev, cur, px, py, gx, gy, iters = 10) {
  const levels = prev.length;
  const top = 1 << (levels - 1);
  let dx = gx / top, dy = gy / top;
  for (let L = levels - 1; L >= 0; L--) {
    const P = prev[L], C = cur[L], s = 1 << L;
    const x = px / s, y = py / s;
    if (x < WIN + 2 || y < WIN + 2 || x > P.w - WIN - 3 || y > P.h - WIN - 3) {
      if (L === 0) return null;
      dx *= 2; dy *= 2;
      continue;
    }
    let Gxx = 0, Gxy = 0, Gyy = 0, k = 0;
    for (let j = -WIN; j <= WIN; j++) {
      for (let i = -WIN; i <= WIN; i++, k++) {
        const sx = x + i, sy = y + j;
        const ix = (samp(P, sx + 1, sy) - samp(P, sx - 1, sy)) * 0.5;
        const iy = (samp(P, sx, sy + 1) - samp(P, sx, sy - 1)) * 0.5;
        _Ix[k] = ix; _Iy[k] = iy; _T[k] = samp(P, sx, sy);
        Gxx += ix * ix; Gxy += ix * iy; Gyy += iy * iy;
      }
    }
    const det = Gxx * Gyy - Gxy * Gxy;
    const lam = (Gxx + Gyy) / 2 - Math.sqrt(((Gxx - Gyy) / 2) ** 2 + Gxy * Gxy);
    if (det < 1e-6 || lam < (L === 0 ? MIN_EIG : 1)) {
      if (L === 0) return null;
      dx *= 2; dy *= 2;
      continue;
    }
    for (let it = 0; it < iters; it++) {
      let bx = 0, by = 0;
      k = 0;
      for (let j = -WIN; j <= WIN; j++) {
        for (let i = -WIN; i <= WIN; i++, k++) {
          const e = _T[k] - samp(C, x + dx + i, y + dy + j);
          bx += e * _Ix[k]; by += e * _Iy[k];
        }
      }
      const ddx = (Gyy * bx - Gxy * by) / det;
      const ddy = (-Gxy * bx + Gxx * by) / det;
      dx += ddx; dy += ddy;
      if (!(Math.abs(dx) < 80 && Math.abs(dy) < 80)) return null;
      if (Math.abs(ddx) + Math.abs(ddy) < 0.02) break;
    }
    if (L === 0) {
      let err = 0;
      k = 0;
      for (let j = -WIN; j <= WIN; j++) for (let i = -WIN; i <= WIN; i++, k++) err += Math.abs(_T[k] - samp(C, x + dx + i, y + dy + j));
      return { x: px + dx, y: py + dy, err: err / NPIX };
    }
    dx *= 2; dy *= 2;
  }
  return null;
}

// ------------------------------------------------------------------ corner detection (Shi-Tomasi)
function minEigAt(d, w, x, y) {
  let a = 0, b = 0, c = 0;
  for (let j = -2; j <= 2; j++) {
    const row = (y + j) * w;
    for (let i = -2; i <= 2; i++) {
      const o = row + x + i;
      const ix = (d[o + 1] - d[o - 1]) * 0.5;
      const iy = (d[o + w] - d[o - w]) * 0.5;
      a += ix * ix; b += ix * iy; c += iy * iy;
    }
  }
  return (a + c) / 2 - Math.sqrt(((a - c) / 2) ** 2 + b * b);
}

function detectCorners(img, existing, want, minDist = 9) {
  const { d, w, h } = img;
  const margin = WIN + 4, cell = 12, cands = [];
  for (let cy = margin; cy < h - margin; cy += cell) {
    for (let cx = margin; cx < w - margin; cx += cell) {
      let best = 0, bx = -1, by = -1;
      for (let y = cy; y < Math.min(cy + cell, h - margin); y += 2) {
        for (let x = cx; x < Math.min(cx + cell, w - margin); x += 2) {
          const l = minEigAt(d, w, x, y);
          if (l > best) { best = l; bx = x; by = y; }
        }
      }
      if (bx >= 0) cands.push({ x: bx, y: by, l: best });
    }
  }
  if (!cands.length) return [];
  let maxL = 0;
  for (const c of cands) if (c.l > maxL) maxL = c.l;
  const thr = Math.max(60, 0.08 * maxL);
  cands.sort((p, q) => q.l - p.l);
  const out = [];
  const md2 = minDist * minDist;
  for (const c of cands) {
    if (c.l < thr || out.length >= want) break;
    let ok = true;
    for (const e of existing) if ((e.x - c.x) ** 2 + (e.y - c.y) ** 2 < md2) { ok = false; break; }
    if (ok) for (const o of out) if ((o.x - c.x) ** 2 + (o.y - c.y) ** 2 < md2) { ok = false; break; }
    if (ok) out.push(c);
  }
  return out;
}

// ------------------------------------------------------------------ the tracker
export class PlaneTracker {
  /**
   * @param {{width:number,height:number,fovY?:number,planeY?:number,maxPoints?:number,minPoints?:number}} o
   *   width/height: processing image size (see procSize). fovY: vertical field of view in degrees
   *   (must match the rendering camera). planeY: world height of the table plane.
   */
  constructor({ width, height, fovY = 64, planeY = -0.5, maxPoints = 70, minPoints = 30, maxAge = 200 } = {}) {
    this.w = width;
    this.h = height;
    this.f = height / 2 / Math.tan((fovY * Math.PI) / 360);
    this.cx = width / 2;
    this.cy = height / 2;
    this.planeY = planeY;
    this.maxPoints = maxPoints;
    this.minPoints = minPoints;
    this.maxAge = maxAge;
    this.pos = { x: 0, y: 0, z: 0 };
    this.lms = [];
    this.prev = null;
    this.quality = 'lost'; // good | weak | lost
    this.inliers = 0;
    this.frame = 0;
    this.levels = 3;
  }

  /** Change the table height (drops the map; the camera position is kept). */
  setPlane(y) {
    this.planeY = y;
    this.lms = [];
  }

  /** Forget tracked points (e.g. after the user moved the pitch). */
  resetMap() {
    this.lms = [];
  }

  _project(X, R, p) {
    const dx = X[0] - p.x, dy = X[1] - p.y, dz = X[2] - p.z;
    const xc = R[0] * dx + R[3] * dy + R[6] * dz;
    const yc = R[1] * dx + R[4] * dy + R[7] * dz;
    const zc = R[2] * dx + R[5] * dy + R[8] * dz;
    if (zc > -0.02) return null;
    return { u: this.cx - (this.f * xc) / zc, v: this.cy + (this.f * yc) / zc };
  }

  _backproject(u, v, R, p) {
    const cx = (u - this.cx) / this.f, cy = -(v - this.cy) / this.f, cz = -1;
    const wx = R[0] * cx + R[1] * cy + R[2] * cz;
    const wy = R[3] * cx + R[4] * cy + R[5] * cz;
    const wz = R[6] * cx + R[7] * cy + R[8] * cz;
    if (wy > -0.05) return null;
    const t = (this.planeY - p.y) / wy;
    if (!(t > 0.08 && t < 3)) return null;
    return [p.x + t * wx, this.planeY, p.z + t * wz];
  }

  _seed(img, R) {
    const existing = this.lms.map((l) => ({ x: l.u, y: l.v }));
    const want = this.maxPoints - this.lms.length;
    for (const c of detectCorners(img, existing, want * 2)) {
      if (this.lms.length >= this.maxPoints) break;
      const X = this._backproject(c.x, c.y, R, this.pos);
      if (X) this.lms.push({ X, u: c.x, v: c.y, mu: c.x, mv: c.y, age: 0 });
    }
  }

  /** Robust Gauss-Newton for the camera position given the rotation R. Returns the new position or null. */
  _solve(lms, R) {
    const p = { x: this.pos.x, y: this.pos.y, z: this.pos.z };
    const f = this.f, K = 1.5;
    let used = 0;
    for (let iter = 0; iter < 8; iter++) {
      const H = [0, 0, 0, 0, 0, 0, 0, 0, 0], g = [0, 0, 0];
      used = 0;
      for (const lm of lms) {
        const dx = lm.X[0] - p.x, dy = lm.X[1] - p.y, dz = lm.X[2] - p.z;
        const xc = R[0] * dx + R[3] * dy + R[6] * dz;
        const yc = R[1] * dx + R[4] * dy + R[7] * dz;
        const zc = R[2] * dx + R[5] * dy + R[8] * dz;
        if (zc > -0.02) continue;
        const eu = lm.mu - (this.cx - (f * xc) / zc);
        const ev = lm.mv - (this.cy + (f * yc) / zc);
        const r = Math.hypot(eu, ev);
        const wgt = r < K ? 1 : K / r;
        // d(u,v)/d(Xc), then dXc/dp = -R^T
        const a0 = -f / zc, a2 = (f * xc) / (zc * zc); // u row: [a0, 0, a2]
        const b1 = f / zc, b2 = (-f * yc) / (zc * zc); // v row: [0, b1, b2]
        const Ju = [0, 0, 0], Jv = [0, 0, 0];
        for (let c = 0; c < 3; c++) {
          // column c of R^T rows: R^T[i][c] = R[3*c + i]  =>  dXc_i/dp_c = -R[3c+i]
          Ju[c] = -(a0 * R[3 * c] + a2 * R[3 * c + 2]);
          Jv[c] = -(b1 * R[3 * c + 1] + b2 * R[3 * c + 2]);
        }
        for (let i = 0; i < 3; i++) {
          g[i] += wgt * (Ju[i] * eu + Jv[i] * ev);
          for (let j = 0; j < 3; j++) H[3 * i + j] += wgt * (Ju[i] * Ju[j] + Jv[i] * Jv[j]);
        }
        used++;
      }
      if (used < 8) return null;
      for (let i = 0; i < 3; i++) H[4 * i] += 1e-3 * (H[4 * i] + 1); // LM damping
      const dp = solve3(H, g);
      if (!dp) return null;
      p.x += dp[0]; p.y += dp[1]; p.z += dp[2];
      if (Math.abs(dp[0]) + Math.abs(dp[1]) + Math.abs(dp[2]) < 1e-5) break;
    }
    return p;
  }

  /**
   * Process one frame.
   * @param {Uint8Array|Uint8ClampedArray} gray  width*height luma
   * @param {ArrayLike<number>} R  row-major 3x3 camera->world rotation (from the gyroscope)
   */
  update(gray, R) {
    this.frame++;
    const pyr = buildPyramid(gray, this.w, this.h, this.levels);
    if (!this.prev) {
      this.prev = pyr;
      this._seed(pyr[0], R);
      return this._state();
    }

    // 1. track existing points, predicting their position from the gyro rotation + last position
    const tracked = [];
    for (const lm of this.lms) {
      const pr = this._project(lm.X, R, this.pos);
      if (!pr) continue;
      const res = lkTrack(this.prev, pyr, lm.u, lm.v, pr.u - lm.u, pr.v - lm.v);
      if (res && res.err < 20) {
        lm.mu = res.x; lm.mv = res.y;
        tracked.push(lm);
      }
    }

    // 2. solve for the camera position (hold the old one if the solution looks wrong)
    let moved = false;
    if (tracked.length >= 8) {
      const np = this._solve(tracked, R);
      if (np) {
        const step = Math.hypot(np.x - this.pos.x, np.y - this.pos.y, np.z - this.pos.z);
        if (step < 0.08) {
          this.pos = np;
          moved = true;
        }
      }
    }

    // 3. keep only points that agree with the solution
    const keep = [];
    for (const lm of tracked) {
      const pr = this._project(lm.X, R, this.pos);
      if (!pr) continue;
      if (Math.hypot(lm.mu - pr.u, lm.mv - pr.v) < 2.5 && lm.age < this.maxAge) {
        lm.u = lm.mu; lm.v = lm.mv; lm.age++;
        keep.push(lm);
      }
    }
    this.lms = keep;
    this.inliers = keep.length;
    this.solved = moved;

    // 4. top up the map from the current frame
    if (keep.length < this.minPoints) this._seed(pyr[0], R);
    this.prev = pyr;
    return this._state(moved);
  }

  _state(moved = true) {
    const n = this.inliers = this.lms.length;
    this.quality = !moved ? 'lost' : n >= 25 ? 'good' : n >= 12 ? 'weak' : 'lost';
    return { pos: this.pos, quality: this.quality, inliers: n };
  }
}

function solve3(H, g) {
  const [a, b, c, d, e, f, gg, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * gg), C = d * h - e * gg;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-12)) return null;
  const inv = [
    A, -(b * i - c * h), b * f - c * e,
    B, a * i - c * gg, -(a * f - c * d),
    C, -(a * h - b * gg), a * e - b * d,
  ].map((v) => v / det);
  return [
    inv[0] * g[0] + inv[1] * g[1] + inv[2] * g[2],
    inv[3] * g[0] + inv[4] * g[1] + inv[5] * g[2],
    inv[6] * g[0] + inv[7] * g[1] + inv[8] * g[2],
  ];
}

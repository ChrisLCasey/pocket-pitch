// Pocket Pitch — pure game logic (no DOM, no three.js).
// Everything here is in "pitch-local" metres at scale 1:
//   +x = right (from the player's end), +y = up, -z = towards the far end.
// The renderer scales the whole pitch group, so physics never changes with table size.

export const WORLD = {
  W: 0.56, // pitch width  (x)
  L: 0.9, // pitch length (z)
  ballR: 0.025,
  g: 5.5, // a touch floaty so arcs read well on a small table
  floorE: 0.42, // floor restitution
  rollDamp: 2.4,
  start: { x: 0, z: 0.36 },
  post: { z: -0.43, hw: 0.075, barY: 0.12, barR: 0.006, uprightH: 0.4 },
  bin: { rOut: 0.088, rIn: 0.078, h: 0.12, tube: 0.006 },
  dummy: { r: 0.045, h: 0.14 },
};

const ELEV = (38 * Math.PI) / 180; // launch elevation

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------
export const CHALLENGES = [
  {
    id: 'kickoff',
    title: 'Kick-Off',
    blurb: 'Flick the ball into the bin to score a try. Quicker swipe = further.',
    balls: 5,
    assist: 0.55, // gentle magnetism towards the (static) bin so a first flick feels good
    stars: [5, 15, 30],
    bins: [{ x: 0, z: -0.22, points: 5, color: 'red' }],
    dummies: [],
    posts: false,
  },
  {
    id: 'movers',
    title: 'Moving Bins',
    blurb: 'These bins won’t sit still. Time your flick.',
    balls: 6,
    stars: [7, 21, 42],
    bins: [
      { x: 0, z: -0.14, amp: 0.15, speed: 1.2, phase: 0, points: 7, color: 'navy' },
      { x: 0, z: -0.34, amp: 0.12, speed: 1.9, phase: 1.6, points: 7, color: 'red' },
    ],
    dummies: [],
    posts: false,
  },
  {
    id: 'posts',
    title: 'Through the Posts',
    blurb: 'Hit the tackle bags, or land a drop goal over the bar.',
    balls: 6,
    stars: [6, 16, 30],
    bins: [{ x: 0, z: -0.3, amp: 0.1, speed: 0.8, phase: 0.5, points: 5, color: 'navy' }],
    dummies: [
      { x: -0.1, z: -0.1, amp: 0.1, speed: 1.4, phase: 0, points: 2 },
      { x: 0.1, z: -0.2, amp: 0.1, speed: 1.0, phase: 2.2, points: 2 },
    ],
    posts: { points: 3 },
  },
  {
    id: 'whistle',
    title: 'Final Whistle',
    blurb: '40 seconds. Tries, tackles, drop goals \u2014 streaks multiply.',
    balls: Infinity,
    time: 40,
    between: 0.35,
    stars: [15, 35, 60],
    bins: [{ x: 0, z: -0.2, amp: 0.14, speed: 1.5, phase: 0, points: 6, color: 'red' }],
    dummies: [{ x: 0.0, z: -0.08, amp: 0.15, speed: 1.9, phase: 1, points: 2 }],
    posts: { points: 3 },
  },
];

// ---------------------------------------------------------------------------
// Input -> velocity
// ---------------------------------------------------------------------------

/**
 * Convert a screen flick into a pitch-local launch velocity.
 * @param {{vx:number, vy:number}} swipe  velocity in screen-heights per second (+x right, +y DOWN)
 * @param {number} camPhi  yaw of the camera's "table-forward" direction relative to the pitch's
 *                         forward (-z) axis, radians (see phiFromLocalDir).
 * @returns {{vx:number,vy:number,vz:number,power:number,range:number}|null}
 */
export function flickToVelocity({ vx, vy }, camPhi = 0) {
  const fwd = -vy; // upward swipe = forward
  if (!(fwd > 0.2)) return null;
  const speed = Math.hypot(vx, vy);
  const power = clamp((speed - 1.0) / 5.0, 0, 1);
  // Range is linear in power so the flick "feels" proportional.
  const range = lerp(0.2, 1.45, power);
  const s = Math.sqrt((range * WORLD.g) / Math.sin(2 * ELEV));
  const ang = clamp(Math.atan2(vx, fwd) * 0.7, -0.8, 0.8); // damp sideways aim
  const a = Math.sin(ang); // camera-right component
  const b = Math.cos(ang); // camera-forward component
  const lx = a * Math.cos(camPhi) - b * Math.sin(camPhi);
  const lz = -a * Math.sin(camPhi) - b * Math.cos(camPhi);
  const sh = s * Math.cos(ELEV);
  return { vx: sh * lx, vy: s * Math.sin(ELEV), vz: sh * lz, power, range };
}

/** Yaw (about +y) that makes a group's local -z axis point along world dir (dx, dz). */
export function yawForForward(dx, dz) {
  return Math.atan2(-dx, -dz);
}

/** Angle of a pitch-local horizontal direction measured from -z (used as camPhi). */
export function phiFromLocalDir(lx, lz) {
  return Math.atan2(-lx, -lz);
}

// ---------------------------------------------------------------------------
// World / targets
// ---------------------------------------------------------------------------
export function buildWorld(def) {
  const bins = (def.bins || []).map((b, i) => ({
    id: 'bin' + i,
    baseX: b.x || 0,
    x: b.x || 0,
    z: b.z,
    amp: b.amp || 0,
    speed: b.speed || 0,
    phase: b.phase || 0,
    points: b.points || 5,
    color: b.color || 'red',
    rOut: WORLD.bin.rOut,
    rIn: WORLD.bin.rIn,
    h: WORLD.bin.h,
    tube: WORLD.bin.tube,
  }));
  const dummies = (def.dummies || []).map((d, i) => ({
    id: 'dummy' + i,
    baseX: d.x || 0,
    x: d.x || 0,
    z: d.z,
    amp: d.amp || 0,
    speed: d.speed || 0,
    phase: d.phase || 0,
    points: d.points || 2,
    r: WORLD.dummy.r,
    h: WORLD.dummy.h,
    tilt: 0,
    tiltV: 0,
    tiltX: 0,
    tiltZ: -1,
  }));
  return {
    time: 0,
    bins,
    dummies,
    posts: def.posts ? { points: def.posts.points || 3 } : null,
  };
}

export function updateTargets(world, dt) {
  world.time += dt;
  const t = world.time;
  for (const b of world.bins) b.x = b.baseX + b.amp * Math.sin(b.speed * t + b.phase);
  for (const d of world.dummies) {
    d.x = d.baseX + d.amp * Math.sin(d.speed * t + d.phase);
    // damped spring back upright
    d.tiltV += (-60 * d.tilt - 6 * d.tiltV) * dt;
    d.tilt = clamp(d.tilt + d.tiltV * dt, -1.2, 1.2);
  }
}

// ---------------------------------------------------------------------------
// Ball physics
// ---------------------------------------------------------------------------
export function makeBall() {
  return {
    x: WORLD.start.x,
    y: WORLD.ballR,
    z: WORLD.start.z,
    vx: 0,
    vy: 0,
    vz: 0,
    state: 'ready', // ready | flying | captured | done | lost
    age: 0,
    rest: 0,
    scored: 0,
    goal: false,
    touched: false,
    hitDummies: new Set(),
    cap: null,
    grounded: false,
  };
}

function collideCyl(ball, cx, cz, cr, ch) {
  const R = WORLD.ballR;
  const dx = ball.x - cx;
  const dz = ball.z - cz;
  const d = Math.hypot(dx, dz);
  if (d >= cr + R) return null;
  if (ball.y - R >= ch || ball.y + R <= 0) return null;
  if (ball.y >= ch) {
    // resting on top
    if (d < cr) {
      ball.y = ch + R;
      if (ball.vy < 0) ball.vy = -ball.vy * 0.4;
    }
    return null;
  }
  const nx = d > 1e-6 ? dx / d : 1;
  const nz = d > 1e-6 ? dz / d : 0;
  ball.x = cx + nx * (cr + R);
  ball.z = cz + nz * (cr + R);
  const vn = ball.vx * nx + ball.vz * nz;
  if (vn < 0) {
    ball.vx -= 1.5 * vn * nx;
    ball.vz -= 1.5 * vn * nz;
    return { impact: -vn, nx, nz };
  }
  return null;
}

/** Advance the ball by dt. Emits ('bounce'|'score'|'dummyHit'|'rim'|'lost', data). */
export function stepBall(ball, dt, world, emit) {
  const R = WORLD.ballR;
  const W2 = WORLD.W / 2;
  const L2 = WORLD.L / 2;

  if (ball.state === 'captured') {
    const b = ball.cap.bin;
    ball.cap.t += dt;
    const k = Math.exp(-14 * dt);
    ball.cap.ox *= k;
    ball.cap.oz *= k;
    ball.x = b.x + ball.cap.ox;
    ball.z = b.z + ball.cap.oz;
    ball.vy -= WORLD.g * dt;
    ball.y += ball.vy * dt;
    const floor = R + 0.008;
    if (ball.y < floor) {
      ball.y = floor;
      ball.vy = ball.vy < -0.5 ? -ball.vy * 0.25 : 0;
    }
    if (ball.cap.t > 0.8) ball.state = 'done';
    return;
  }
  if (ball.state !== 'flying') return;

  ball.age += dt;
  const prevZ = ball.z;
  ball.vy -= WORLD.g * dt;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  ball.z += ball.vz * dt;

  // ---- pitch floor
  const onPitch = Math.abs(ball.x) <= W2 && Math.abs(ball.z) <= L2;
  ball.grounded = false;
  if (onPitch && ball.y < R && ball.vy < 0) {
    ball.y = R;
    const vn = -ball.vy;
    if (vn > 0.35) {
      ball.vy = vn * WORLD.floorE;
      ball.vx *= 0.88;
      ball.vz *= 0.88;
      emit('bounce', { kind: 'floor', strength: clamp(vn / 3, 0.15, 1) });
    } else {
      ball.vy = 0;
      ball.grounded = true;
    }
  }
  if (ball.grounded) {
    const k = Math.exp(-WORLD.rollDamp * dt);
    ball.vx *= k;
    ball.vz *= k;
  }

  // ---- bins
  for (const b of world.bins) {
    const dx = ball.x - b.x;
    const dz = ball.z - b.z;
    const d = Math.hypot(dx, dz) || 1e-6;
    const ux = dx / d;
    const uz = dz / d;

    // inside the bin below the rim -> captured
    if (ball.y < b.h && ball.y > 0 && d < b.rIn - 0.3 * R) {
      ball.state = 'captured';
      ball.cap = { bin: b, ox: dx, oz: dz, t: 0 };
      ball.vx = 0;
      ball.vz = 0;
      emit('score', { kind: 'bin', points: b.points, x: b.x, y: b.h, z: b.z, target: b });
      return;
    }

    // rim (torus): nearest ring point to the ball
    const Rr = (b.rIn + b.rOut) / 2;
    const rx = b.x + ux * Rr;
    const rz = b.z + uz * Rr;
    const ex = ball.x - rx;
    const ey = ball.y - b.h;
    const ez = ball.z - rz;
    const dist = Math.hypot(ex, ey, ez);
    const minD = R * 0.6 + b.tube; // forgiving: ball is narrower than its collision sphere
    if (dist < minD && dist > 1e-6) {
      const nx = ex / dist;
      const ny = ey / dist;
      const nz = ez / dist;
      ball.x = rx + nx * minD;
      ball.y = b.h + ny * minD;
      ball.z = rz + nz * minD;
      const vn = ball.vx * nx + ball.vy * ny + ball.vz * nz;
      if (vn < 0) {
        const j = -(1 + 0.5) * vn;
        ball.vx += j * nx;
        ball.vy += j * ny;
        ball.vz += j * nz;
        ball.touched = true;
        emit('bounce', { kind: 'rim', strength: clamp(-vn / 3, 0.2, 1) });
      }
    }

    // outer wall (below / around rim height)
    if (ball.y < b.h + 0.5 * R && d > Rr && d < b.rOut + R) {
      ball.x = b.x + ux * (b.rOut + R);
      ball.z = b.z + uz * (b.rOut + R);
      const vn = ball.vx * ux + ball.vz * uz;
      if (vn < 0) {
        ball.vx -= 1.5 * vn * ux;
        ball.vz -= 1.5 * vn * uz;
        ball.touched = true;
        emit('bounce', { kind: 'bin', strength: clamp(-vn / 3, 0.2, 1) });
      }
    }
  }

  // ---- tackle bags
  for (const dm of world.dummies) {
    const hit = collideCyl(ball, dm.x, dm.z, dm.r, dm.h);
    if (hit && hit.impact > 0.3 && !ball.hitDummies.has(dm.id)) {
      ball.hitDummies.add(dm.id);
      ball.touched = true;
      dm.tiltV = clamp(2.5 + hit.impact * 1.2, 3, 5);
      dm.tiltX = -hit.nx;
      dm.tiltZ = -hit.nz;
      emit('dummyHit', { dummy: dm, impact: hit.impact });
      emit('score', { kind: 'dummy', points: dm.points, x: dm.x, y: dm.h, z: dm.z, target: dm });
    }
  }

  // ---- posts
  if (world.posts) {
    const P = WORLD.post;
    for (const sx of [-1, 1]) collideCyl(ball, sx * P.hw, P.z, P.barR, P.uprightH);
    // crossbar: segment from (-hw,barY,z) to (hw,barY,z)
    const cx = clamp(ball.x, -P.hw, P.hw);
    const ex = ball.x - cx;
    const ey = ball.y - P.barY;
    const ez = ball.z - P.z;
    const dist = Math.hypot(ex, ey, ez);
    const minD = R * 0.8 + P.barR;
    if (dist < minD && dist > 1e-6) {
      const nx = ex / dist;
      const ny = ey / dist;
      const nz = ez / dist;
      ball.x = cx + nx * minD;
      ball.y = P.barY + ny * minD;
      ball.z = P.z + nz * minD;
      const vn = ball.vx * nx + ball.vy * ny + ball.vz * nz;
      if (vn < 0) {
        const j = -(1 + 0.4) * vn;
        ball.vx += j * nx;
        ball.vy += j * ny;
        ball.vz += j * nz;
        ball.touched = true;
        emit('bounce', { kind: 'bar', strength: clamp(-vn / 3, 0.3, 1) });
      }
    }
    // goal: crossing the plane between the uprights, above the bar
    if (!ball.goal && prevZ > P.z && ball.z <= P.z) {
      if (Math.abs(ball.x) < P.hw - 0.3 * R && ball.y > P.barY + 0.2 * R) {
        ball.goal = true;
        emit('score', { kind: 'goal', points: world.posts.points, x: ball.x, y: ball.y, z: P.z, target: null });
      }
    }
  }

  // ---- end of flight
  if (ball.y < -0.35) {
    ball.state = 'lost';
    emit('lost', {});
    return;
  }
  const speed = Math.hypot(ball.vx, ball.vz);
  if (ball.grounded && speed < 0.05) ball.rest += dt;
  else ball.rest = 0;
  if (ball.rest > 0.35 || ball.age > 7) ball.state = 'done';
}

/**
 * Casual-game "magnetism": nudges a launch velocity towards the nearest static bin.
 * strength 0..1. Returns a new velocity (or the same one if nothing to assist).
 */
export function assistVelocity(v, world, strength) {
  if (!strength || !world.bins.length) return v;
  const sh = Math.hypot(v.vx, v.vz);
  if (sh < 1e-6) return v;
  const y0 = WORLD.ballR + 0.02;
  const rangeEst = (sh * (v.vy + Math.sqrt(v.vy * v.vy + 2 * WORLD.g * y0))) / WORLD.g;
  const ang = Math.atan2(v.vx, -v.vz);
  let best = null;
  for (const b of world.bins) {
    if (b.amp > 0) continue; // never assist moving targets
    const dx = b.x - WORLD.start.x;
    const dz = b.z - WORLD.start.z;
    const dist = Math.hypot(dx, dz);
    const angT = Math.atan2(dx, -dz);
    const dAng = Math.abs(angT - ang);
    if (dAng < 0.5 && (!best || dAng < best.dAng)) best = { dist, angT, dAng };
  }
  if (!best) return v;
  const wantRange = best.dist + 0.13; // land just past the rim so the descent drops in
  let f = 1;
  if (Math.abs(rangeEst - wantRange) < 0.6 * wantRange) {
    const newRange = rangeEst + strength * (wantRange - rangeEst);
    f = Math.sqrt(newRange / rangeEst);
  }
  const newAng = ang + strength * (best.angT - ang);
  const nsh = sh * f;
  return { ...v, vx: nsh * Math.sin(newAng), vz: -nsh * Math.cos(newAng), vy: v.vy * f };
}

// ---------------------------------------------------------------------------
// Game state machine
// ---------------------------------------------------------------------------
export class Game {
  /** @param {(type:string, data?:any)=>void} emit */
  constructor(emit = () => {}) {
    this.emit = emit;
    this.phase = 'idle'; // idle | ready | flying | between | done
    this.def = null;
    this.world = null;
    this.ball = null;
    this.index = -1;
    this.score = 0;
    this.streak = 0;
    this.mult = 1;
    this.ballsUsed = 0;
    this.timeLeft = 0;
    this.timerStarted = false;
    this.timeUp = false;
    this.timer = 0;
    this._onBall = this._onBall.bind(this);
  }

  get timed() {
    return !!(this.def && this.def.time);
  }
  get ballsTotal() {
    return this.def ? this.def.balls : 0;
  }

  startChallenge(index) {
    this.index = index;
    this.def = CHALLENGES[index];
    this.world = buildWorld(this.def);
    this.score = 0;
    this.streak = 0;
    this.mult = 1;
    this.ballsUsed = 0;
    this.timeLeft = this.def.time || 0;
    this.timerStarted = false;
    this.timeUp = false;
    this.timer = 0;
    this.emit('start', { def: this.def, world: this.world });
    this._spawn();
  }

  _spawn() {
    this.ball = makeBall();
    this.phase = 'ready';
    this.emit('ready', { ball: this.ball });
  }

  /** @param {{vx:number,vy:number,vz:number,power?:number}} v pitch-local velocity */
  flick(v) {
    if (this.phase !== 'ready' || !v) return false;
    v = assistVelocity(v, this.world, this.def.assist || 0);
    const b = this.ball;
    b.vx = v.vx;
    b.vy = v.vy;
    b.vz = v.vz;
    b.y = WORLD.ballR + 0.02;
    b.state = 'flying';
    this.phase = 'flying';
    this.ballsUsed++;
    this.mult = Math.min(3, 1 + this.streak);
    if (this.timed) this.timerStarted = true;
    this.emit('launch', { power: v.power ?? 0.5, v });
    return true;
  }

  _onBall(type, data) {
    if (type === 'score') {
      const pts = data.points * this.mult;
      this.score += pts;
      this.ball.scored += pts;
      this.emit('score', { ...data, points: pts, base: data.points, mult: this.mult, total: this.score });
    } else {
      this.emit(type, data);
    }
  }

  update(dt) {
    if (!this.world || this.phase === 'idle' || this.phase === 'done') return;
    updateTargets(this.world, dt);

    if (this.timed && this.timerStarted && !this.timeUp) {
      this.timeLeft = Math.max(0, this.timeLeft - dt);
      if (this.timeLeft === 0) this.timeUp = true;
    }

    if (this.phase === 'flying') {
      const n = Math.min(8, Math.max(1, Math.ceil(dt / (1 / 240))));
      const h = dt / n;
      for (let i = 0; i < n; i++) {
        stepBall(this.ball, h, this.world, this._onBall);
        if (this.ball.state === 'done' || this.ball.state === 'lost') break;
      }
      if (this.ball.state === 'done' || this.ball.state === 'lost') this._endThrow();
    } else if (this.phase === 'between') {
      this.timer -= dt;
      if (this.timer <= 0) this._next();
    } else if (this.phase === 'ready' && this.timeUp) {
      this._finish();
    }
  }

  _endThrow() {
    const b = this.ball;
    const scored = b.scored > 0;
    this.streak = scored ? this.streak + 1 : 0;
    this.emit('throwEnd', {
      scored,
      streak: this.streak,
      touched: b.touched,
      farMiss: b.z < -WORLD.L / 2 - 0.02,
      short: b.z > 0 && !scored,
      x: b.x,
      z: b.z,
    });
    this.phase = 'between';
    this.timer = this.def.between ?? 0.8;
  }

  _next() {
    if (this.timed) {
      if (this.timeUp) this._finish();
      else this._spawn();
    } else if (this.ballsUsed >= this.def.balls) this._finish();
    else this._spawn();
  }

  _finish() {
    const [s1, s2, s3] = this.def.stars;
    const stars = this.score >= s3 ? 3 : this.score >= s2 ? 2 : this.score >= s1 ? 1 : 0;
    this.phase = 'done';
    this.emit('complete', {
      score: this.score,
      stars,
      passed: stars > 0,
      index: this.index,
      last: this.index >= CHALLENGES.length - 1,
      def: this.def,
    });
  }
}

/** Ballistic preview points (no collisions) — handy for aim guides and tests. */
export function predictArc(v, from = WORLD.start, steps = 24, dt = 0.04) {
  const pts = [];
  let x = from.x,
    y = WORLD.ballR + 0.02,
    z = from.z,
    vy = v.vy;
  for (let i = 0; i < steps; i++) {
    x += v.vx * dt;
    z += v.vz * dt;
    vy -= WORLD.g * dt;
    y += vy * dt;
    if (y < WORLD.ballR) break;
    pts.push({ x, y, z });
  }
  return pts;
}

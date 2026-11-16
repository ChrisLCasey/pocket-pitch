// Run with: node test/logic.test.mjs
import assert from 'node:assert/strict';
import {
  Game,
  CHALLENGES,
  WORLD,
  flickToVelocity,
  yawForForward,
  phiFromLocalDir,
} from '../src/logic.js';

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log('  ok  ' + name);
};

// ---------------------------------------------------------------- mapping
test('straight flick goes straight ahead (-z)', () => {
  const v = flickToVelocity({ vx: 0, vy: -3 }, 0);
  assert.ok(Math.abs(v.vx) < 1e-9);
  assert.ok(v.vz < 0 && v.vy > 0);
});

test('swipe right goes to +x; left to -x', () => {
  assert.ok(flickToVelocity({ vx: 1.5, vy: -3 }, 0).vx > 0);
  assert.ok(flickToVelocity({ vx: -1.5, vy: -3 }, 0).vx < 0);
});

test('downward / sideways-only swipes are rejected', () => {
  assert.equal(flickToVelocity({ vx: 0, vy: 2 }, 0), null);
  assert.equal(flickToVelocity({ vx: 3, vy: -0.05 }, 0), null);
});

test('camera yaw rotates the launch direction', () => {
  // Camera looking along pitch -x => forward flick should go towards -x.
  const v = flickToVelocity({ vx: 0, vy: -3 }, Math.PI / 2);
  assert.ok(v.vx < -1 && Math.abs(v.vz) < 1e-6, JSON.stringify(v));
});

test('range increases monotonically with swipe speed', () => {
  let last = -1;
  for (let s = 1; s <= 6; s += 0.5) {
    const r = flickToVelocity({ vx: 0, vy: -s }, 0).range;
    assert.ok(r >= last);
    last = r;
  }
});

test('yaw/phi helpers are consistent', () => {
  // group yaw makes local -z point along (dx,dz); then that dir in local space has phi = 0
  const dx = 0.6, dz = -0.8;
  const psi = yawForForward(dx, dz);
  const lx = dx * Math.cos(-psi) + dz * Math.sin(-psi);
  const lz = -dx * Math.sin(-psi) + dz * Math.cos(-psi);
  assert.ok(Math.abs(phiFromLocalDir(lx, lz)) < 1e-9);
});

// ------------------------------------------------------------ simulation
function simulate(defIndex, { speed, vx, wait }) {
  const events = [];
  const g = new Game((t, d) => events.push([t, d]));
  g.startChallenge(defIndex);
  for (let t = 0; t < wait; t += 1 / 60) g.update(1 / 60); // let moving targets drift
  const v = flickToVelocity({ vx, vy: -speed }, 0);
  g.flick(v);
  let guard = 0;
  while (g.phase === 'flying' && guard++ < 1200) g.update(1 / 60);
  return { g, events };
}

for (let i = 0; i < CHALLENGES.length; i++) {
  const def = CHALLENGES[i];
  test(`"${def.title}" is winnable but not trivial`, () => {
    let total = 0,
      scoring = 0;
    for (let speed = 1.4; speed <= 6; speed += 0.2)
      for (let vx = -1.2; vx <= 1.2; vx += 0.1)
        for (let wait = 0; wait < 6; wait += 0.4) {
          total++;
          const { g } = simulate(i, { speed, vx, wait });
          assert.ok(Number.isFinite(g.ball.x + g.ball.y + g.ball.z), 'NaN ball');
          if (g.ball.scored > 0) scoring++;
        }
    const pct = (100 * scoring) / total;
    console.log(`        ${scoring}/${total} sampled flicks score (${pct.toFixed(1)}%)`);
    assert.ok(scoring > 0, 'no flick scores — challenge unreachable');
    assert.ok(pct < 45, 'challenge is too easy');
  });
}

test('every scoring kind is reachable (bin, dummy, goal)', () => {
  const kinds = new Set();
  for (const idx of [0, 1, 2, 3])
    for (let speed = 1.4; speed <= 6; speed += 0.2)
      for (let vx = -1.2; vx <= 1.2; vx += 0.1)
        for (let wait = 0; wait < 6; wait += 0.4) {
          const { events } = simulate(idx, { speed, vx, wait });
          for (const [t, d] of events) if (t === 'score') kinds.add(d.kind);
        }
  assert.deepEqual([...kinds].sort(), ['bin', 'dummy', 'goal']);
});

test('fixed-count challenge finishes after N balls with stars', () => {
  const ev = [];
  const g = new Game((t, d) => ev.push([t, d]));
  g.startChallenge(0);
  let guard = 0;
  while (g.phase !== 'done' && guard++ < 20000) {
    if (g.phase === 'ready') g.flick(flickToVelocity({ vx: 0, vy: -2.5 }, 0));
    g.update(1 / 60);
  }
  assert.equal(g.phase, 'done');
  assert.equal(g.ballsUsed, CHALLENGES[0].balls);
  const done = ev.filter(([t]) => t === 'complete');
  assert.equal(done.length, 1);
  assert.ok(done[0][1].stars >= 0 && done[0][1].stars <= 3);
});

test('timed challenge ends on the clock, not on ball count', () => {
  const ev = [];
  const g = new Game((t, d) => ev.push([t, d]));
  g.startChallenge(3);
  let guard = 0;
  let elapsed = 0;
  while (g.phase !== 'done' && guard++ < 40000) {
    if (g.phase === 'ready') g.flick(flickToVelocity({ vx: 0.2, vy: -2.8 }, 0));
    g.update(1 / 60);
    elapsed += 1 / 60;
  }
  assert.equal(g.phase, 'done');
  assert.ok(g.ballsUsed > 5, 'should have thrown many balls');
  assert.ok(elapsed < 60, 'finished within a sane time');
});

test('streak multiplier builds and resets', () => {
  const g = new Game();
  g.startChallenge(0);
  // find a flick that scores in challenge 0 (static bin)
  let best = null;
  for (let s = 1.4; s <= 6 && !best; s += 0.05) {
    const { g: t } = simulate(0, { speed: s, vx: 0, wait: 0 });
    if (t.ball.scored > 0) best = s;
  }
  assert.ok(best, 'static bin reachable with a straight flick');
  const h = new Game();
  h.startChallenge(0);
  const got = [];
  for (let i = 0; i < 3; i++) {
    h.flick(flickToVelocity({ vx: 0, vy: -best }, 0));
    let guard = 0;
    while (h.phase === 'flying' && guard++ < 1200) h.update(1 / 60);
    got.push([h.streak, h.mult]);
    while (h.phase === 'between') h.update(1 / 60);
  }
  // after each scoring throw streak increments; mult used on throw i = min(3, 1 + streakBefore)
  assert.deepEqual(got.map((x) => x[0]), [1, 2, 3]);
  assert.deepEqual(got.map((x) => x[1]), [1, 2, 3]);
  h.flick(flickToVelocity({ vx: 0, vy: -1.4 }, 0)); // weak flick: miss
  let guard = 0;
  while (h.phase === 'flying' && guard++ < 1200) h.update(1 / 60);
  assert.equal(h.streak, 0);
});

test('ball never produces NaN under hundreds of random flicks', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let n = 0; n < 400; n++) {
    const idx = Math.floor(rnd() * CHALLENGES.length);
    const g = new Game();
    g.startChallenge(idx);
    for (let t = 0; t < rnd() * 5; t += 1 / 60) g.update(1 / 60);
    g.flick(flickToVelocity({ vx: (rnd() - 0.5) * 3, vy: -(1 + rnd() * 6) }, (rnd() - 0.5) * 6));
    let guard = 0;
    while (g.phase === 'flying' && guard++ < 1200) g.update(1 / 30); // coarse dt as on slow phones
    const b = g.ball;
    assert.ok([b.x, b.y, b.z, b.vx, b.vy, b.vz].every(Number.isFinite));
  }
});

test('goal requires passing above the crossbar between the uprights', () => {
  // A very hard straight flick in "Through the Posts" should be able to score a goal
  let goal = false, bar = false;
  for (let s = 3; s <= 6; s += 0.1) {
    const { events } = simulate(2, { speed: s, vx: 0, wait: 0.3 });
    for (const [t, d] of events) {
      if (t === 'score' && d.kind === 'goal') goal = true;
      if (t === 'bounce' && d.kind === 'bar') bar = true;
    }
  }
  assert.ok(goal, 'a hard straight flick can score a goal');
  console.log(`        crossbar collisions observed: ${bar}`);
});

console.log(`\n${passed} tests passed`);

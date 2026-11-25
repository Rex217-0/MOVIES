import test from 'node:test';
import assert from 'node:assert/strict';
import {
  arcFor, splitSeconds, planSceneShots, sceneMediaClass, shotPlanSummary,
  SHOT_ARCS, MIN_SHOT_SECONDS, FRAMING_PROMPTS, MAX_SHOTS_PER_SCENE, repeatFactor,
} from './shotPlan.ts';

test('a short scene is one shot, a long scene gets full coverage', () => {
  assert.deepEqual(arcFor(5), ['medium']);
  assert.deepEqual(arcFor(10), ['wide', 'close']);
  assert.deepEqual(arcFor(18), ['establishing', 'medium', 'close']);
  assert.deepEqual(arcFor(30), ['establishing', 'wide', 'medium', 'close']);
  assert.equal(arcFor(300).length, SHOT_ARCS.at(-1)!.length);
});

test('every shot is a distinct framing, never the same shot repeated', () => {
  for (const arc of SHOT_ARCS) {
    assert.equal(new Set(arc).size, arc.length, `arc repeats a framing: ${arc.join(',')}`);
  }
});

test('splitSeconds sums to exactly the scene length', () => {
  for (const seconds of [6, 7, 11, 12.5, 20, 33.33, 60, 300]) {
    for (const count of [1, 2, 3, 4, 5, 6]) {
      const parts = splitSeconds(seconds, count);
      const sum = parts.reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - seconds) < 0.05, `${count} parts of ${seconds} summed to ${sum}`);
    }
  }
});

test('splitSeconds never produces a shot shorter than the flash-frame floor', () => {
  const parts = splitSeconds(10, 6);
  assert.equal(parts.length, 5, '10s cannot hold 6 shots of 2s each');
  for (const p of parts) assert.ok(p >= MIN_SHOT_SECONDS, `shot too short: ${p}`);
});

test('a scene is planned as ordered shots with distinct prompts', () => {
  const shots = planSceneShots({ visual: 'Isang mangingisda sa dalampasigan', heading: 'SCENE 1', seconds: 18 });
  assert.equal(shots.length, 3);
  assert.deepEqual(shots.map(s => s.index), [1, 2, 3]);
  assert.deepEqual(shots.map(s => s.framing), ['establishing', 'medium', 'close']);
  const total = shots.reduce((a, s) => a + s.seconds, 0);
  assert.ok(Math.abs(total - 18) < 0.05, `planned ${total}s for an 18s scene`);
  assert.equal(new Set(shots.map(s => s.prompt)).size, 3, 'two shots share a prompt');
  for (const s of shots) {
    assert.match(s.prompt, new RegExp(FRAMING_PROMPTS[s.framing].slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('planning is deterministic, so a re-render resumes the same coverage', () => {
  const a = planSceneShots({ visual: 'Dagat', heading: 'S1', seconds: 30 });
  const b = planSceneShots({ visual: 'Dagat', heading: 'S1', seconds: 30 });
  assert.deepEqual(a, b);
});

test('a scene falls back to its heading when it has no visual line', () => {
  const shots = planSceneShots({ visual: '', heading: 'EXT. DAAN - GABI', seconds: 8 });
  assert.match(shots[0].prompt, /EXT\. DAAN - GABI/);
});

test('a mixed scene is HYBRID, not whichever class came first', () => {
  assert.equal(sceneMediaClass(['SYNTHETIC_MOTION']), 'SYNTHETIC_MOTION');
  assert.equal(sceneMediaClass(['SYNTHETIC_MOTION', 'SYNTHETIC_MOTION']), 'SYNTHETIC_MOTION');
  assert.equal(sceneMediaClass(['STOCK_FOOTAGE', 'SYNTHETIC_MOTION']), 'HYBRID');
  assert.equal(sceneMediaClass(['SYNTHETIC_MOTION', 'STILL_MOTION']), 'HYBRID');
  assert.equal(sceneMediaClass([]), 'FAILED');
  assert.equal(sceneMediaClass(['FAILED']), 'FAILED');
});

test('the shot plan summary names every shot and its length', () => {
  const shots = planSceneShots({ visual: 'Dagat', heading: 'S1', seconds: 12 });
  assert.match(shotPlanSummary(shots), /wide \d+\.\ds → close \d+\.\ds/);
});

test('a film scene is capped so one feature is not a hundred renders', () => {
  const shots = planSceneShots({ visual: 'Dagat', heading: 'S1', seconds: 300 });
  assert.equal(shots.length, MAX_SHOTS_PER_SCENE, `a 300s scene planned ${shots.length} shots`);
});

test('repeatFactor is how many times a render fills its shot, rounded up', () => {
  assert.equal(repeatFactor(6, 6), 1);
  assert.equal(repeatFactor(6, 5), 2);
  assert.equal(repeatFactor(12, 5), 3);
  assert.equal(repeatFactor(50, 5), 10);
});

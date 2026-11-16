import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanionStage } from '../public/companion-stage.js';

function harness({ immediate = false } = {}) {
  const live = new Set();
  const disposals = [];
  const fades = [];
  const stage = createCompanionStage({
    dispose(record) {
      assert.equal(record.controller.signal.aborted, true, 'cancel loading before releasing its player');
      assert.ok(live.delete(record), 'each player is released exactly once');
      disposals.push(record.name);
    },
    transition(previous, next, done) {
      const fade = { previous, next, done, cancellations: 0 };
      fades.push(fade);
      if (immediate) done();
      return () => { fade.cancellations += 1; };
    },
  });
  const candidate = name => {
    const record = { name, controller: new AbortController() };
    live.add(record);
    return record;
  };
  return { stage, live, disposals, fades, candidate };
}

test('the first frame becomes active without requiring a fade or releasing its player', () => {
  const { stage, candidate, live, fades } = harness();
  const first = candidate('first');
  assert.equal(stage.begin(first), true);
  assert.equal(stage.active, undefined, 'beginning a load is not a ready frame');
  assert.equal(stage.pending, first);
  assert.equal(stage.present(first), true);
  assert.equal(stage.active, first);
  assert.equal(stage.pending, undefined);
  assert.equal(first.controller.signal.aborted, false);
  assert.equal(live.size, 1);
  assert.equal(fades.length, 0);
});

test('loading keeps the old picture alive, then releases it only after the replacement fade finishes', () => {
  const { stage, candidate, disposals, fades, live } = harness();
  const first = candidate('portrait');
  stage.begin(first);
  stage.present(first);
  const second = candidate('skill');
  stage.begin(second);
  assert.equal(stage.active, first);
  assert.equal(first.controller.signal.aborted, false);
  assert.deepEqual(disposals, []);
  stage.present(second);
  assert.equal(stage.active, second);
  assert.equal(stage.outgoing, first);
  assert.equal(live.size, 2);
  assert.equal(fades[0].previous, first);
  assert.equal(fades[0].next, second);
  assert.deepEqual(disposals, []);
  fades[0].done();
  assert.deepEqual(disposals, ['portrait']);
  assert.equal(stage.outgoing, undefined);
  assert.equal(stage.active, second);
  assert.equal(live.size, 1);
  fades[0].done();
  assert.deepEqual(disposals, ['portrait'], 'a repeated transition event must be harmless');
});

test('a failed replacement preserves the current picture and aborts only the failed load', () => {
  const { stage, candidate, live, disposals } = harness();
  const old = candidate('visible');
  stage.begin(old);
  stage.present(old);
  const failed = candidate('failed');
  stage.begin(failed);
  assert.equal(stage.fail(failed), true);
  assert.equal(stage.active, old);
  assert.equal(stage.pending, undefined);
  assert.equal(old.controller.signal.aborted, false);
  assert.equal(live.size, 1);
  assert.deepEqual(disposals, ['failed']);
  assert.equal(stage.fail(failed), false);
  assert.equal(stage.fail(old), false, 'a late failed-load callback cannot remove the active picture');
});

test('a new request aborts the old candidate and late ready or error callbacks cannot win', () => {
  const { stage, candidate, live, fades, disposals } = harness();
  const first = candidate('first request');
  stage.begin(first);
  const latest = candidate('latest request');
  stage.begin(latest);
  assert.equal(first.controller.signal.aborted, true);
  assert.deepEqual(disposals, ['first request']);
  assert.equal(stage.present(first), false);
  assert.equal(stage.fail(first), false);
  assert.equal(stage.pending, latest);
  assert.equal(stage.present(latest), true);
  assert.equal(stage.active, latest);
  assert.equal(live.size, 1);
  assert.equal(fades.length, 0);
});

test('rapid changes retire an earlier fade before loading another picture, keeping at most two players', () => {
  const { stage, candidate, live, fades, disposals } = harness();
  const first = candidate('A');
  stage.begin(first);
  stage.present(first);
  const second = candidate('B');
  stage.begin(second);
  stage.present(second);
  assert.equal(live.size, 2);
  const third = candidate('C');
  stage.begin(third);
  assert.equal(fades[0].cancellations, 1);
  assert.equal(stage.outgoing, undefined);
  assert.equal(stage.active, second);
  assert.equal(stage.pending, third);
  assert.equal(live.size, 2);
  assert.deepEqual(disposals, ['A']);
  fades[0].done();
  assert.equal(stage.active, second);
  assert.equal(stage.pending, third);
  stage.present(third);
  assert.equal(live.size, 2);
  assert.equal(stage.outgoing, second);
  fades[1].done();
  assert.equal(stage.active, third);
  assert.deepEqual(disposals, ['A', 'B']);
  assert.equal(live.size, 1);
});

test('closing during a fade aborts and releases both pictures, ignores late completion, and is idempotent', () => {
  const { stage, candidate, live, fades, disposals } = harness();
  const first = candidate('A');
  stage.begin(first);
  stage.present(first);
  const second = candidate('B');
  stage.begin(second);
  stage.present(second);
  stage.clear();
  assert.equal(live.size, 0);
  assert.equal(stage.active, undefined);
  assert.equal(stage.pending, undefined);
  assert.equal(stage.outgoing, undefined);
  assert.equal(fades[0].cancellations, 1);
  fades[0].done();
  stage.clear();
  assert.deepEqual(disposals.sort(), ['A', 'B']);
});

test('closing during a slow load releases its candidate and old picture even with reentrant abort callbacks', () => {
  const { stage, candidate, live, disposals } = harness();
  const first = candidate('visible');
  stage.begin(first);
  stage.present(first);
  const second = candidate('loading');
  stage.begin(second);
  second.controller.signal.addEventListener('abort', () => stage.fail(second));
  stage.clear();
  assert.equal(live.size, 0);
  assert.equal(stage.present(second), false);
  assert.deepEqual(disposals, ['loading', 'visible']);
});

test('an immediate reduced-motion swap cleans up the transition and leaves only the new picture', () => {
  const { stage, candidate, live, disposals, fades } = harness({ immediate: true });
  const first = candidate('A');
  stage.begin(first);
  stage.present(first);
  const second = candidate('B');
  stage.begin(second);
  stage.present(second);
  assert.equal(stage.active, second);
  assert.equal(stage.outgoing, undefined);
  assert.equal(live.size, 1);
  assert.deepEqual(disposals, ['A']);
  assert.equal(fades[0].cancellations, 1, 'synchronous completion must not retain timers or listeners');
  stage.clear();
  assert.equal(fades[0].cancellations, 1);
});

test('repeated requests for the same pending record are harmless and a released picture cannot be resurrected', () => {
  const { stage, candidate, disposals } = harness();
  const first = candidate('A');
  assert.equal(stage.begin(first), true);
  assert.equal(stage.begin(first), true);
  assert.deepEqual(disposals, []);
  stage.fail(first);
  assert.equal(stage.begin(first), false);
  assert.equal(stage.present(first), false);
  assert.equal(stage.active, undefined);
  assert.equal(stage.pending, undefined);
});

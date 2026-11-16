/** Freeze imported bootstrap semantics before adding an opt-in scheduling policy. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { reviewState } from '../packages/domain/src/recommendations.ts';
import { event, now } from './phase16-fixtures.ts';

it('anchors all pre-baseline successes at the last success plus one, without advancing stages', () => {
  const history = ['2026-09-01', '2026-09-02', '2026-09-05'].map(d => ({ ...event(d), recordedAt: 10 }));
  const state = reviewState('1', true, history, 'UTC', 10, now);
  assert.equal(state.stage, 0);
  assert.equal(state.dueDate, '2026-09-06');
  const next = reviewState('1', true, [...history, { ...event('2026-09-06'), recordedAt: 11 }], 'UTC', 10, now);
  assert.equal(next.stage, 1);
  assert.equal(next.dueDate, '2026-09-09');
});

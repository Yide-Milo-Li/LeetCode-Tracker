/** Time regressions protecting recommendation completion from fabricated instants. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCalendarDate, isEventTime, isTimeZone, localDate, addDays } from '../packages/contracts/src/time.ts';
import { normalizeProgressDate, createPracticeRecordSchema } from '../packages/contracts/src/practice.ts';

test('rejects calendar overflow, offsetless clocks and precision mismatches', () => {
  assert.equal(isCalendarDate('2026-02-29'), false);
  assert.equal(isCalendarDate('2024-02-29'), true);
  for (const date of ['2026-02-30T12:00:00Z', '2026-09-08T24:00:00Z', '2026-09-08T12:00:00']) assert.equal(isEventTime(date, 'datetime'), false);
  assert.throws(() => normalizeProgressDate('Feb 30, 2026'));
  assert.throws(() => normalizeProgressDate('2026-09-08T12:00'));
  assert.equal(createPracticeRecordSchema.safeParse({ questionFrontendId: '1', completed: true, practicedAt: '2026-09-08', timePrecision: 'datetime' }).success, false);
});

test('groups instants in the confirmed zone across DST and year boundaries', () => {
  assert.equal(isTimeZone('not/a-zone'), false);
  assert.equal(localDate(Date.parse('2027-01-01T02:00:00Z'), 'America/Los_Angeles'), '2026-12-31');
  assert.equal(localDate(Date.parse('2026-03-08T10:00:00Z'), 'America/Los_Angeles'), '2026-03-08');
  assert.equal(addDays('2026-03-08', 1), '2026-03-09');
});

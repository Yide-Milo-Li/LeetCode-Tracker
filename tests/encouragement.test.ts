/**
 * Unit and invariant tests for Phase 10 time-aware encouragement quotes library.
 * Verifies dataset bounds, uniqueness, period boundaries, midnight bridging,
 * timezone sensitivity, and the 60-day non-repetition rotation guarantee.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_QUOTES,
  MORNING_QUOTES,
  AFTERNOON_QUOTES,
  EVENING_QUOTES,
  NIGHT_QUOTES,
} from '../apps/web/src/data/encouragements.ts';
import {
  getLogicalPeriodAndDate,
  getEncouragement,
  getZonedTimeParts,
} from '../apps/web/src/encouragement.ts';

describe('Encouragement Quotes Dataset Quality', () => {
  it('contains at least 240 quotes with at least 60 in each of the four periods', () => {
    assert.ok(ALL_QUOTES.length >= 240, `Expected at least 240 quotes, got ${ALL_QUOTES.length}`);
    assert.ok(MORNING_QUOTES.length >= 60, `Morning quotes count: ${MORNING_QUOTES.length}`);
    assert.ok(AFTERNOON_QUOTES.length >= 60, `Afternoon quotes count: ${AFTERNOON_QUOTES.length}`);
    assert.ok(EVENING_QUOTES.length >= 60, `Evening quotes count: ${EVENING_QUOTES.length}`);
    assert.ok(NIGHT_QUOTES.length >= 60, `Night quotes count: ${NIGHT_QUOTES.length}`);
  });

  it('guarantees unique IDs across all quotes', () => {
    const ids = new Set<string>();
    for (const quote of ALL_QUOTES) {
      assert.ok(!ids.has(quote.id), `Duplicate quote ID found: ${quote.id}`);
      ids.add(quote.id);
    }
  });

  it('guarantees unique Chinese and English copy with zero duplicates', () => {
    const zhSet = new Set<string>();
    const enSet = new Set<string>();
    for (const quote of ALL_QUOTES) {
      assert.ok(!zhSet.has(quote.zh), `Duplicate Chinese text: ${quote.zh}`);
      zhSet.add(quote.zh);

      assert.ok(!enSet.has(quote.en), `Duplicate English text: ${quote.en}`);
      enSet.add(quote.en);
    }
  });

  it('enforces string length constraints: <=32 Chinese chars, <=18 English words', () => {
    for (const quote of ALL_QUOTES) {
      assert.ok(
        quote.zh.length <= 32,
        `Chinese quote exceeds 32 chars (${quote.zh.length}): "${quote.zh}"`,
      );
      const words = quote.en.trim().split(/\s+/).filter(Boolean).length;
      assert.ok(
        words <= 18,
        `English quote exceeds 18 words (${words}): "${quote.en}"`,
      );
    }
  });
});

describe('Encouragement Period Calculation & Rotation Logic', () => {
  it('correctly maps 24-hour boundaries in UTC', () => {
    // 05:59:59 -> night (attributed to previous day)
    const t0559 = new Date('2026-09-12T05:59:59Z');
    const p0559 = getLogicalPeriodAndDate(t0559, 'UTC');
    assert.equal(p0559.period, 'night');
    assert.equal(p0559.logicalDate, '2026-09-11');

    // 06:00:00 -> morning
    const t0600 = new Date('2026-09-12T06:00:00Z');
    const p0600 = getLogicalPeriodAndDate(t0600, 'UTC');
    assert.equal(p0600.period, 'morning');
    assert.equal(p0600.logicalDate, '2026-09-12');

    // 10:59:59 -> morning
    const t1059 = new Date('2026-09-12T10:59:59Z');
    const p1059 = getLogicalPeriodAndDate(t1059, 'UTC');
    assert.equal(p1059.period, 'morning');
    assert.equal(p1059.logicalDate, '2026-09-12');

    // 11:00:00 -> afternoon
    const t1100 = new Date('2026-09-12T11:00:00Z');
    const p1100 = getLogicalPeriodAndDate(t1100, 'UTC');
    assert.equal(p1100.period, 'afternoon');
    assert.equal(p1100.logicalDate, '2026-09-12');

    // 16:59:59 -> afternoon
    const t1659 = new Date('2026-09-12T16:59:59Z');
    const p1659 = getLogicalPeriodAndDate(t1659, 'UTC');
    assert.equal(p1659.period, 'afternoon');
    assert.equal(p1659.logicalDate, '2026-09-12');

    // 17:00:00 -> evening
    const t1700 = new Date('2026-09-12T17:00:00Z');
    const p1700 = getLogicalPeriodAndDate(t1700, 'UTC');
    assert.equal(p1700.period, 'evening');
    assert.equal(p1700.logicalDate, '2026-09-12');

    // 21:59:59 -> evening
    const t2159 = new Date('2026-09-12T21:59:59Z');
    const p2159 = getLogicalPeriodAndDate(t2159, 'UTC');
    assert.equal(p2159.period, 'evening');
    assert.equal(p2159.logicalDate, '2026-09-12');

    // 22:00:00 -> night
    const t2200 = new Date('2026-09-12T22:00:00Z');
    const p2200 = getLogicalPeriodAndDate(t2200, 'UTC');
    assert.equal(p2200.period, 'night');
    assert.equal(p2200.logicalDate, '2026-09-12');

    // 23:59:59 -> night
    const t2359 = new Date('2026-09-12T23:59:59Z');
    const p2359 = getLogicalPeriodAndDate(t2359, 'UTC');
    assert.equal(p2359.period, 'night');
    assert.equal(p2359.logicalDate, '2026-09-12');
  });

  it('bridges midnight continuously without changing quotes until 06:00', () => {
    // 23:30 on Sept 12 in UTC
    const beforeMidnight = new Date('2026-09-12T23:30:00Z');
    // 02:45 on Sept 13 in UTC
    const afterMidnight = new Date('2026-09-13T02:45:00Z');
    // 05:59 on Sept 13 in UTC
    const justBeforeMorning = new Date('2026-09-13T05:59:00Z');
    // 06:00 on Sept 13 in UTC
    const morningSwitch = new Date('2026-09-13T06:00:00Z');

    const quoteBefore = getEncouragement(beforeMidnight, 'UTC');
    const quoteAfter = getEncouragement(afterMidnight, 'UTC');
    const quoteJustBefore = getEncouragement(justBeforeMorning, 'UTC');
    const quoteMorning = getEncouragement(morningSwitch, 'UTC');

    assert.equal(quoteBefore.id, quoteAfter.id, 'Midnight crossover should preserve quote');
    assert.equal(quoteBefore.id, quoteJustBefore.id, 'Quote should remain until 06:00');
    assert.notEqual(quoteJustBefore.id, quoteMorning.id, 'Quote must rotate at 06:00');
    assert.equal(quoteMorning.period, 'morning');
  });

  it('guarantees no duplicate quotes across 60 consecutive days for all four periods', () => {
    const periods = ['morning', 'afternoon', 'evening', 'night'] as const;
    const baseDate = new Date('2026-01-01T08:00:00Z');

    for (const period of periods) {
      const seenIds = new Set<string>();
      const hourOffset =
        period === 'morning' ? 8 : period === 'afternoon' ? 14 : period === 'evening' ? 19 : 23;

      for (let day = 0; day < 60; day++) {
        const testDate = new Date(Date.UTC(2026, 0, 1 + day, hourOffset, 0, 0));
        const quote = getEncouragement(testDate, 'UTC');
        assert.equal(quote.period, period);
        assert.ok(
          !seenIds.has(quote.id),
          `Repeat detected in ${period} on day ${day}: ${quote.id}`,
        );
        seenIds.add(quote.id);
      }
      assert.equal(seenIds.size, 60);
    }
  });

  it('adjusts accurately to user timezone and daylight saving time', () => {
    // 2026-07-15T15:00:00Z
    // In UTC: 15:00 -> afternoon
    // In America/New_York (EDT = UTC-4): 11:00 -> afternoon
    // In America/Los_Angeles (PDT = UTC-7): 08:00 -> morning
    // In Asia/Shanghai (UTC+8): 23:00 -> night
    const summerTime = new Date('2026-07-15T15:00:00Z');

    const utcRes = getLogicalPeriodAndDate(summerTime, 'UTC');
    assert.equal(utcRes.period, 'afternoon');

    const nyRes = getLogicalPeriodAndDate(summerTime, 'America/New_York');
    assert.equal(nyRes.period, 'afternoon');

    const laRes = getLogicalPeriodAndDate(summerTime, 'America/Los_Angeles');
    assert.equal(laRes.period, 'morning');

    const shRes = getLogicalPeriodAndDate(summerTime, 'Asia/Shanghai');
    assert.equal(shRes.period, 'night');
    assert.equal(shRes.logicalDate, '2026-07-15');
  });

  it('remains stable and idempotent on repeated calls within the same period', () => {
    const now = new Date('2026-09-12T14:35:12Z');
    const q1 = getEncouragement(now, 'UTC');
    const q2 = getEncouragement(now, 'UTC');
    assert.equal(q1.id, q2.id);
    assert.equal(q1.zh, q2.zh);
    assert.equal(q1.en, q2.en);
  });
});

/**
 * Pure deterministic selection algorithm for time-aware encouragement quotes.
 * Adheres to Phase 10 time boundaries:
 * - morning: 06:00–11:00
 * - afternoon: 11:00–17:00
 * - evening: 17:00–22:00
 * - night: 22:00–06:00 next day
 *
 * Night hours belong to the date when the night began (i.e. between 00:00 and 05:59,
 * the quote is anchored to the previous calendar day). Thus, no rotation occurs at midnight;
 * quotes rotate cleanly at 06:00, 11:00, 17:00, and 22:00.
 *
 * Quotes are selected deterministically using the day index modulo the pool size (>=60),
 * guaranteeing zero repetitions within any continuous 60-day period.
 */

import {
  type TimePeriod,
  type EncouragementQuote,
  QUOTES_BY_PERIOD,
} from './data/encouragements.ts';

/**
 * Extract localized calendar components for a given instant and timezone.
 * Uses the browser default timezone if none or invalid timezone is provided.
 *
 * @param date The reference date instant
 * @param timeZone Optional IANA timezone identifier (e.g. 'America/Los_Angeles')
 * @returns Localized year, month, day, hour, and minute
 */
export function getZonedTimeParts(
  date: Date,
  timeZone?: string | null,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  let tz: string | undefined = undefined;
  if (timeZone) {
    try {
      // Validate timezone identifier
      Intl.DateTimeFormat(undefined, { timeZone }).format();
      tz = timeZone;
    } catch {
      // Graceful fallback to browser default if timeZone is invalid
      tz = undefined;
    }
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;

  for (const part of parts) {
    if (part.type === 'year') year = Number(part.value);
    if (part.type === 'month') month = Number(part.value);
    if (part.type === 'day') day = Number(part.value);
    if (part.type === 'hour') {
      const h = Number(part.value);
      // Some engines format midnight as 24:00
      hour = h === 24 ? 0 : h;
    }
    if (part.type === 'minute') minute = Number(part.value);
  }

  return { year, month, day, hour, minute };
}

/**
 * Compute the logical time period, the logical calendar date, and the continuous day index.
 * Night hours between 00:00 and 05:59:59 belong to the previous day's night period.
 *
 * @param date The reference date instant
 * @param timeZone Optional IANA timezone identifier
 * @returns Object with period, logical date string (YYYY-MM-DD), and day index
 */
export function getLogicalPeriodAndDate(
  date: Date,
  timeZone?: string | null,
): {
  period: TimePeriod;
  logicalDate: string;
  dayIndex: number;
} {
  const parts = getZonedTimeParts(date, timeZone);
  let period: TimePeriod;
  let { year, month, day, hour } = parts;

  if (hour >= 6 && hour < 11) {
    period = 'morning';
  } else if (hour >= 11 && hour < 17) {
    period = 'afternoon';
  } else if (hour >= 17 && hour < 22) {
    period = 'evening';
  } else {
    period = 'night';
    // If the local hour is between midnight and 05:59, the night period belongs
    // to the previous calendar day when it began at 22:00.
    if (hour < 6) {
      const prev = new Date(Date.UTC(year, month - 1, day - 1));
      year = prev.getUTCFullYear();
      month = prev.getUTCMonth() + 1;
      day = prev.getUTCDate();
    }
  }

  const yStr = String(year).padStart(4, '0');
  const mStr = String(month).padStart(2, '0');
  const dStr = String(day).padStart(2, '0');
  const logicalDate = `${yStr}-${mStr}-${dStr}`;

  // Continuous day number since Unix epoch UTC to ensure consecutive non-repeating indices
  const dayIndex = Math.floor(Date.UTC(year, month - 1, day) / 86400000);

  return { period, logicalDate, dayIndex };
}

/**
 * Select an encouragement quote deterministically based on date, time, and timezone.
 *
 * @param date Reference date instant
 * @param timeZone Optional IANA timezone identifier
 * @returns The chosen EncouragementQuote
 */
export function getEncouragement(
  date: Date,
  timeZone?: string | null,
): EncouragementQuote {
  const { period, dayIndex } = getLogicalPeriodAndDate(date, timeZone);
  const pool = QUOTES_BY_PERIOD[period];
  const index = ((dayIndex % pool.length) + pool.length) % pool.length;
  return pool[index];
}

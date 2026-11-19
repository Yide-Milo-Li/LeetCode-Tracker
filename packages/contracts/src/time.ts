/** Strict event-time validation; legacy ambiguous values remain readable but are not proof. */
import { z } from 'zod';

// Formatter configuration is immutable. Bound the cache because zones may come from imports.
const dates = new Map<string, Intl.DateTimeFormat>();
const invalidZones = new Set<string>();
const clocks = new Map<string, Intl.DateTimeFormat>();

export function zonedFormatter(zone: string, includeClock = false): Intl.DateTimeFormat {
  const cache = includeClock ? clocks : dates;
  const known = cache.get(zone);
  if (known) return known;
  const formatter = new Intl.DateTimeFormat(includeClock ? 'en-US' : 'en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    ...(includeClock ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false } as const : {}),
  });
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(zone, formatter);
  return formatter;
}

/** Accept supported named time zones without guessing from the host environment. */
export function isTimeZone(value: string): boolean {
  if (typeof value !== 'string' || !value || value.trim() !== value || invalidZones.has(value)) return false;
  try { zonedFormatter(value); return true; }
  catch {
    if (invalidZones.size >= 64) invalidZones.delete(invalidZones.values().next().value!);
    if (value.length <= 100) invalidZones.add(value);
    return false;
  }
}
export const timeZoneSchema = z.string().max(100).refine(isTimeZone, 'A valid IANA time zone is required');

/** Reject overflow dates such as February 30 rather than letting Date normalize them. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Validate precision and require an explicit offset for instants. */
export function isEventTime(value: string, precision: 'date' | 'datetime'): boolean {
  if (precision === 'date') return isCalendarDate(value);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  return !!match && isCalendarDate(match[1]) && +match[2] < 24 && +match[3] < 60 && +(match[4] ?? 0) < 60
    && +(match[6] ?? 0) <= 23 && +(match[7] ?? 0) < 60 && Number.isFinite(Date.parse(value));
}

/** Return the user's calendar date, independent of the machine time zone. */
export function localDate(instant: number, zone: string): string {
  const parts = zonedFormatter(zone).formatToParts(instant);
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)!.value).join('-');
}

/** Calendar arithmetic uses UTC only as a date container, never as a local-day duration. */
export function addDays(date: string, days: number): string {
  const result = new Date(`${date}T12:00:00Z`); result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

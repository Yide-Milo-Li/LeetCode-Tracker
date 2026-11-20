/**
 * Shared, cached date formatting for UI labels.
 *
 * Replaces scattered `new Date(x).toLocaleString(zh ? 'zh-CN' : 'en-US', …)` calls. Output is
 * identical to those calls: the presets spell out the same fields that `toLocaleString` and
 * `toLocaleTimeString` add by default. `Intl.DateTimeFormat` instances are cached because
 * constructing one is far more expensive than formatting with it (tables format one cell per row).
 */
import type { Language } from './i18n.ts';

/** BCP 47 locale used for every UI date in the given language. */
export function localeFor(lang: Language): 'zh-CN' | 'en-US' {
  return lang === 'zh' ? 'zh-CN' : 'en-US';
}

/** Field sets matching the implicit defaults of `toLocaleString` / `toLocaleTimeString`. */
const PRESETS = {
  date: { dateStyle: 'medium' },
  datetime: { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' },
  time: { hour: 'numeric', minute: 'numeric', second: 'numeric' },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

const cache = new Map<string, Intl.DateTimeFormat>();

/** Return a cached formatter; an invalid IANA zone throws `RangeError`, like the native calls. */
function formatter(lang: Language, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${lang}|${JSON.stringify(options)}`;
  let value = cache.get(key);
  if (!value) {
    value = new Intl.DateTimeFormat(localeFor(lang), options);
    cache.set(key, value);
  }
  return value;
}

/**
 * Format an instant (epoch ms, ISO string or Date) for display.
 * `timeZone` undefined means the runtime's zone; callers pass `'UTC'` or the user's zone explicitly.
 */
export function formatInstant(
  value: number | string | Date,
  lang: Language,
  { timeZone, preset = 'datetime' }: { timeZone?: string; preset?: keyof typeof PRESETS } = {},
): string {
  return formatter(lang, { ...PRESETS[preset], ...(timeZone ? { timeZone } : {}) }).format(new Date(value));
}

/**
 * Format a local calendar date (`YYYY-MM-DD`) with explicit fields.
 * The date is pinned to UTC midnight and formatted in UTC, so the label never shifts by a day.
 */
export function formatCalendarDate(
  date: string,
  lang: Language,
  fields: Omit<Intl.DateTimeFormatOptions, 'timeZone'>,
): string {
  return formatter(lang, { ...fields, timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
}

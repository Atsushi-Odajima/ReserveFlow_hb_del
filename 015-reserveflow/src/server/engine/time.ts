import { DateTime, IANAZone } from 'luxon';

export const MIN = 60_000;

export function isValidTimezone(tz: string): boolean {
  return IANAZone.isValidZone(tz);
}

/** 'YYYY-MM-DD' of the given instant in zone. */
export function localDateOf(ms: number, tz: string): string {
  return DateTime.fromMillis(ms, { zone: tz }).toISODate()!;
}

/** Weekday 0=Sunday..6=Saturday for a local date string. */
export function weekdayOf(date: string): number {
  const d = DateTime.fromISO(date, { zone: 'UTC' });
  return d.weekday % 7;
}

export function addDays(date: string, n: number): string {
  return DateTime.fromISO(date, { zone: 'UTC' }).plus({ days: n }).toISODate()!;
}

export function diffDays(a: string, b: string): number {
  return Math.round(DateTime.fromISO(b, { zone: 'UTC' }).diff(DateTime.fromISO(a, { zone: 'UTC' }), 'days').days);
}

export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Instant for a local wall-clock time. minutes may be 1440 (= next day 00:00).
 * Non-existent local times (DST gap) are shifted forward by Luxon.
 */
export function localToInstant(date: string, minutes: number, tz: string): number {
  const base = DateTime.fromISO(date, { zone: tz }).startOf('day');
  if (minutes >= 1440) {
    const next = DateTime.fromISO(addDays(date, 1), { zone: tz }).startOf('day');
    return next.plus({ minutes: minutes - 1440 }).toMillis();
  }
  const dt = DateTime.fromObject(
    { year: base.year, month: base.month, day: base.day, hour: Math.floor(minutes / 60), minute: minutes % 60 },
    { zone: tz },
  );
  return dt.toMillis();
}

/**
 * Strict variant used for slot candidates: returns null when the wall-clock time does not exist (DST gap).
 * For ambiguous times (DST fall back) Luxon returns the earlier offset, which is our documented rule.
 */
export function localToInstantStrict(date: string, minutes: number, tz: string): number | null {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const [y, mo, d] = date.split('-').map(Number);
  const dt = DateTime.fromObject({ year: y, month: mo, day: d, hour: h, minute: m }, { zone: tz });
  if (!dt.isValid) return null;
  if (dt.hour !== h || dt.minute !== m || dt.day !== d) return null;
  return dt.toMillis();
}

/** Start/end instants of a local date [00:00, next 00:00). */
export function dayRange(date: string, tz: string): { start: number; end: number } {
  return { start: localToInstant(date, 0, tz), end: localToInstant(date, 1440, tz) };
}

export function minutesOfDay(ms: number, tz: string): number {
  const dt = DateTime.fromMillis(ms, { zone: tz });
  return dt.hour * 60 + dt.minute;
}

export function formatLocal(ms: number, tz: string, fmt = 'yyyy/MM/dd HH:mm'): string {
  return DateTime.fromMillis(ms, { zone: tz }).toFormat(fmt);
}

const WD_JA = ['日', '月', '火', '水', '木', '金', '土'];

export function formatLocalJa(ms: number, tz: string): string {
  const dt = DateTime.fromMillis(ms, { zone: tz });
  return `${dt.toFormat('yyyy年M月d日')}(${WD_JA[dt.weekday % 7]}) ${dt.toFormat('HH:mm')}`;
}

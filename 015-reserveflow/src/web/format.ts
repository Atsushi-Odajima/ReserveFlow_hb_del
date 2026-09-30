import { DateTime } from 'luxon';
import { WEEKDAYS } from '../shared/labels';

export function dt(iso: string | number | Date, tz: string): DateTime {
  const ms = typeof iso === 'number' ? iso : iso instanceof Date ? iso.getTime() : Date.parse(iso);
  return DateTime.fromMillis(ms, { zone: tz });
}

export const fmtTime = (iso: string | number | Date, tz: string) => dt(iso, tz).toFormat('HH:mm');
export const fmtDate = (iso: string | number | Date, tz: string) => {
  const d = dt(iso, tz);
  return `${d.toFormat('M/d')}(${WEEKDAYS[d.weekday % 7]})`;
};
export const fmtDateLong = (iso: string | number | Date, tz: string) => {
  const d = dt(iso, tz);
  return `${d.toFormat('yyyy年M月d日')}(${WEEKDAYS[d.weekday % 7]})`;
};
export const fmtDateTime = (iso: string | number | Date, tz: string) => `${fmtDateLong(iso, tz)} ${fmtTime(iso, tz)}`;
export const fmtShortDateTime = (iso: string | number | Date, tz: string) => `${fmtDate(iso, tz)} ${fmtTime(iso, tz)}`;

export function dateLabel(date: string): string {
  const d = DateTime.fromISO(date, { zone: 'UTC' });
  return `${d.toFormat('M/d')}(${WEEKDAYS[d.weekday % 7]})`;
}

export function todayIn(tz: string): string {
  return DateTime.now().setZone(tz).toISODate()!;
}

export function addDays(date: string, n: number): string {
  return DateTime.fromISO(date, { zone: 'UTC' }).plus({ days: n }).toISODate()!;
}

export function weekdayOf(date: string): number {
  return DateTime.fromISO(date, { zone: 'UTC' }).weekday % 7;
}

/** Local wall time (in business tz) → ISO instant. Returns null for non-existent times (DST gap). */
export function localToIso(date: string, time: string, tz: string): string | null {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const x = DateTime.fromObject({ year: y, month: m, day: d, hour: hh, minute: mm }, { zone: tz });
  if (!x.isValid || x.hour !== hh || x.minute !== mm) return null;
  return x.toUTC().toISO();
}

export function minToTime(m: number): string {
  if (m >= 1440) return '24:00';
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function timeToMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export function minutesLabel(min: number): string {
  if (min % 1440 === 0 && min >= 1440) return `${min / 1440}日`;
  if (min % 60 === 0 && min >= 60) return `${min / 60}時間`;
  return `${min}分`;
}

export function monthGrid(month: string, weekStart: number): string[] {
  // month = 'YYYY-MM' → 6 weeks of dates
  const first = `${month}-01`;
  const offset = (weekdayOf(first) - weekStart + 7) % 7;
  const start = addDays(first, -offset);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

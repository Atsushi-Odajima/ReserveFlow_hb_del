export interface Interval {
  start: number;
  end: number;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function contains(outer: Interval, inner: Interval): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/** Sort and merge overlapping or touching intervals. */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ start: i.start, end: i.end });
  }
  return out;
}

/** True when `inner` lies completely inside one interval of the merged set. */
export function coveredBy(set: Interval[], inner: Interval): boolean {
  for (const s of set) {
    if (s.start <= inner.start && inner.end <= s.end) return true;
    if (s.start > inner.start) break;
  }
  return false;
}

/** Subtract `cut` intervals from `base` intervals. */
export function subtract(base: Interval[], cut: Interval[]): Interval[] {
  let result = mergeIntervals(base);
  for (const c of mergeIntervals(cut)) {
    const next: Interval[] = [];
    for (const r of result) {
      if (!overlaps(r, c)) {
        next.push(r);
        continue;
      }
      if (r.start < c.start) next.push({ start: r.start, end: c.start });
      if (c.end < r.end) next.push({ start: c.end, end: r.end });
    }
    result = next;
  }
  return result;
}

/**
 * Maximum number of simultaneously overlapping intervals inside `window`.
 * Intervals are half-open [start, end).
 */
export function maxConcurrency(list: Interval[], window: Interval): number {
  const events: Array<[number, number]> = [];
  for (const i of list) {
    if (!overlaps(i, window)) continue;
    events.push([Math.max(i.start, window.start), 1]);
    events.push([Math.min(i.end, window.end), -1]);
  }
  // ends before starts at the same instant (half-open)
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of events) {
    cur += d;
    if (cur > max) max = cur;
  }
  return max;
}

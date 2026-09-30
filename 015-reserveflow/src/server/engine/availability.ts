import { contains, coveredBy, maxConcurrency, mergeIntervals, overlaps, type Interval } from './intervals.js';
import { addDays, eachDate, localDateOf, localToInstant, localToInstantStrict, minutesOfDay, weekdayOf, MIN } from './time.js';
import type {
  EngineInput,
  EngineOccurrence,
  EngineService,
  EngineStaff,
  HoursInterval,
  Reason,
  Slot,
  SlotRequest,
  SlotResult,
  WeeklyHours,
} from './types.js';

/**
 * Business hours for one local date after applying date exceptions.
 * Priority: closed exception > special_hours exception > weekly hours.
 */
export function businessDayHours(input: EngineInput, date: string): HoursInterval[] {
  const ex = input.exceptions.filter((e) => e.date === date);
  if (ex.some((e) => e.kind === 'closed')) return [];
  const special = ex.filter((e) => e.kind === 'special_hours');
  if (special.length) return sortHours(special.flatMap((e) => e.intervals));
  return sortHours(input.business.weeklyHours[weekdayOf(date)] ?? []);
}

function sortHours(list: HoursInterval[]): HoursInterval[] {
  return [...list].filter((h) => h.endMin > h.startMin).sort((a, b) => a.startMin - b.startMin);
}

function hoursToInstants(date: string, hours: HoursInterval[], tz: string): Interval[] {
  return hours.map((h) => ({ start: localToInstant(date, h.startMin, tz), end: localToInstant(date, h.endMin, tz) }));
}

/** Engine context with per-date memoization so listing many slots stays cheap. */
export class EngineContext {
  readonly input: EngineInput;
  private readonly tz: string;
  private bizCache = new Map<string, Interval[]>();
  private staffCache = new Map<string, Interval[]>();
  private resCache = new Map<string, Interval[]>();
  readonly servicesById: Map<string, EngineService>;
  readonly staffById: Map<string, EngineStaff>;

  constructor(input: EngineInput) {
    this.input = input;
    this.tz = input.business.timezone;
    this.servicesById = new Map(input.services.map((s) => [s.id, s]));
    this.staffById = new Map(input.staff.map((s) => [s.id, s]));
  }

  get timezone(): string {
    return this.tz;
  }

  /** Merged business open intervals covering [date-1, date+1] (so cross-midnight bookings work). */
  businessOpen(date: string): Interval[] {
    let v = this.bizCache.get(date);
    if (!v) {
      const parts: Interval[] = [];
      for (const d of [addDays(date, -1), date, addDays(date, 1)]) parts.push(...hoursToInstants(d, businessDayHours(this.input, d), this.tz));
      v = mergeIntervals(parts);
      this.bizCache.set(date, v);
    }
    return v;
  }

  private weeklyFor(date: string, week: WeeklyHours): Interval[] {
    const parts: Interval[] = [];
    for (const d of [addDays(date, -1), date, addDays(date, 1)]) parts.push(...hoursToInstants(d, sortHours(week[weekdayOf(d)] ?? []), this.tz));
    return mergeIntervals(parts);
  }

  /** Staff working intervals (before blocks/bookings), breaks removed. */
  staffWorking(staff: EngineStaff, date: string): Interval[] {
    const key = `${staff.id}|${date}`;
    let v = this.staffCache.get(key);
    if (!v) {
      let base: Interval[];
      if (staff.usesBusinessHours) {
        const parts: Interval[] = [];
        for (const d of [addDays(date, -1), date, addDays(date, 1)]) parts.push(...hoursToInstants(d, businessDayHours(this.input, d), this.tz));
        base = mergeIntervals(parts);
      } else {
        base = this.weeklyFor(date, staff.weeklyHours);
      }
      const breaks = this.weeklyFor(date, staff.breaks);
      v = subtractAll(base, breaks);
      this.staffCache.set(key, v);
    }
    return v;
  }

  resourceHours(resourceId: string, week: WeeklyHours, date: string): Interval[] {
    const key = `${resourceId}|${date}`;
    let v = this.resCache.get(key);
    if (!v) {
      v = this.weeklyFor(date, week);
      this.resCache.set(key, v);
    }
    return v;
  }
}

function subtractAll(base: Interval[], cut: Interval[]): Interval[] {
  let result = base;
  for (const c of cut) {
    const next: Interval[] = [];
    for (const r of result) {
      if (!overlaps(r, c)) next.push(r);
      else {
        if (r.start < c.start) next.push({ start: r.start, end: c.start });
        if (c.end < r.end) next.push({ start: c.end, end: r.end });
      }
    }
    result = next;
  }
  return result;
}

export function effectiveCapacity(ctx: EngineContext, service: EngineService, staffId: string | null): number {
  let cap = service.capacity;
  for (const rid of service.resourceIds) {
    const r = ctx.input.resources.find((x) => x.id === rid);
    if (r?.personCapacity) cap = Math.min(cap, r.personCapacity);
  }
  if (staffId) {
    const s = ctx.staffById.get(staffId);
    if (s?.maxParticipants) cap = Math.min(cap, s.maxParticipants);
  }
  return cap;
}

function slotStep(ctx: EngineContext, service: EngineService): number {
  return service.slotIntervalMin ?? ctx.input.business.slotIntervalMin;
}

/** Is `start` (instant) on the public start-time grid of its local date? */
function onGrid(ctx: EngineContext, service: EngineService, start: number): boolean {
  const tz = ctx.timezone;
  const date = localDateOf(start, tz);
  const mins = minutesOfDay(start, tz);
  const step = slotStep(ctx, service);
  for (const h of businessDayHours(ctx.input, date)) {
    if (mins >= h.startMin && mins < h.endMin && (mins - h.startMin) % step === 0) {
      // make sure the instant is the canonical (earlier) one for that wall time
      return localToInstantStrict(date, mins, tz) === start;
    }
  }
  return false;
}

function reason(code: Reason['code'], message: string, extra: Partial<Reason> = {}): Reason {
  return { code, message, ...extra };
}

function bookingWindowReasons(ctx: EngineContext, start: number, now: number, minNoticeMin: number): Reason[] {
  const out: Reason[] = [];
  const b = ctx.input.business;
  if (start < now + minNoticeMin * MIN) out.push(reason('TOO_SOON', `開始の${minNoticeMin}分前を過ぎた枠は予約できません`));
  const lastDate = addDays(localDateOf(now, b.timezone), b.maxAdvanceDays);
  if (localDateOf(start, b.timezone) > lastDate) out.push(reason('TOO_FAR', `${b.maxAdvanceDays}日先までの予約のみ受け付けています`));
  return out;
}

/**
 * Validate one concrete slot. This is the single source of truth used both for listing
 * (public page / admin search) and for the final server-side re-validation at confirm time.
 */
export function checkSlot(ctx: EngineContext, req: SlotRequest): SlotResult {
  const { input } = ctx;
  const service = ctx.servicesById.get(req.serviceId);
  const reasons: Reason[] = [];
  if (!service || service.archived || !service.acceptsBookings || (req.mode === 'public' && !service.isPublic)) {
    return { ok: false, reasons: [reason('SERVICE_UNAVAILABLE', 'このサービスは現在受け付けていません')] };
  }
  if (service.bookingMode === 'sessions') {
    return { ok: false, reasons: [reason('SERVICE_UNAVAILABLE', 'このサービスは開催日程から選んで予約します')] };
  }
  const maxParty = Math.min(service.maxPartySize, service.capacity);
  if (!Number.isInteger(req.partySize) || req.partySize < 1 || req.partySize > maxParty) {
    return { ok: false, reasons: [reason('PARTY_SIZE', `人数は1〜${maxParty}名で指定してください`)] };
  }

  const start = req.start;
  const end = start + service.durationMin * MIN;
  const occ: Interval = { start: start - service.bufferBeforeMin * MIN, end: end + service.bufferAfterMin * MIN };
  const date = localDateOf(start, ctx.timezone);
  const enforceWindow = req.mode === 'public';
  const enforceHours = req.mode !== 'force';

  if (enforceWindow) {
    reasons.push(...bookingWindowReasons(ctx, start, req.now, input.business.minNoticeMin));
    if (!onGrid(ctx, service, start)) reasons.push(reason('OFF_GRID', '選択できない開始時刻です'));
  }
  if (enforceHours) {
    if (!coveredBy(ctx.businessOpen(date), { start, end })) reasons.push(reason('OUTSIDE_BUSINESS_HOURS', '営業時間外です'));
    if (input.blocks.some((b) => b.scope === 'business' && overlaps(b, occ))) reasons.push(reason('BUSINESS_BLOCKED', '受付停止（ブロック）時間と重なります'));
  }
  if (reasons.length) return { ok: false, reasons };

  const excluded = req.excludeBookingId;
  const activeAllocs = input.allocations.filter((a) => a.bookingId === null || a.bookingId !== excluded);
  const activeBookings = input.bookings.filter((b) => b.id !== excluded);

  // candidate staff
  let staffCandidates: Array<string | null>;
  if (!service.requiresStaff) staffCandidates = [null];
  else if (req.staffId) staffCandidates = [req.staffId];
  else
    staffCandidates = input.staff
      .filter((s) => service.staffIds.includes(s.id) || s.serviceIds.includes(service.id))
      .map((s) => s.id);

  if (service.requiresStaff && staffCandidates.length === 0) {
    return { ok: false, reasons: [reason('NO_STAFF', '対応できるスタッフがいません')] };
  }

  const options: Array<{ staffId: string | null; sessionKey: string | null; join: boolean; capacity: number; remaining: number; load: number; order: number }> = [];

  for (const staffId of staffCandidates) {
    const staffReasons: Reason[] = [];
    const staff = staffId ? ctx.staffById.get(staffId) : undefined;
    if (staffId) {
      if (!staff || staff.archived || !staff.acceptsBookings || !(staff.serviceIds.includes(service.id) || service.staffIds.includes(staff.id))) {
        reasons.push(reason('STAFF_UNAVAILABLE', 'このスタッフは現在予約を受け付けていません', { staffId }));
        continue;
      }
    }

    // existing group session at the same start for this service & staff?
    const capacity = effectiveCapacity(ctx, service, staffId);
    let sessionKey: string | null = null;
    let booked = 0;
    if (service.capacity > 1) {
      const same = activeBookings.filter(
        (b) => b.serviceId === service.id && b.start === start && (b.staffId ?? null) === staffId && b.occurrenceId === null,
      );
      if (same.length) {
        sessionKey = same[0].sessionKey;
        booked = same.reduce((n, b) => n + b.partySize, 0);
      }
    }
    if (booked + req.partySize > capacity) {
      staffReasons.push(reason('CAPACITY_FULL', `定員に達しています（残り${Math.max(0, capacity - booked)}名）`, staffId ? { staffId } : {}));
    }

    if (staff && staffId) {
      if (enforceHours) {
        if (!coveredBy(ctx.staffWorking(staff, date), occ)) staffReasons.push(reason('STAFF_HOURS', 'スタッフの勤務時間外（休憩を含む）です', { staffId }));
        if (input.blocks.some((b) => b.scope === 'staff' && b.targetId === staffId && overlaps(b, occ)))
          staffReasons.push(reason('STAFF_BLOCKED', 'スタッフの休み/ブロックと重なります', { staffId }));
      }
      const busy = activeAllocs.some(
        (a) => a.kind === 'staff' && a.targetId === staffId && a.sessionKey !== sessionKey && overlaps(a, occ),
      );
      if (busy) staffReasons.push(reason('STAFF_BUSY', 'スタッフに別の予約があります', { staffId }));
    }

    // resources
    for (const rid of service.resourceIds) {
      const r = input.resources.find((x) => x.id === rid);
      if (!r || r.archived) {
        staffReasons.push(reason('RESOURCE_UNAVAILABLE', '必要な設備/部屋が利用できません', { resourceId: rid }));
        continue;
      }
      if (enforceHours) {
        if (r.hasHours && !coveredBy(ctx.resourceHours(r.id, r.weeklyHours, date), occ))
          staffReasons.push(reason('RESOURCE_HOURS', `${r.name} の利用可能時間外です`, { resourceId: rid }));
        if (input.blocks.some((b) => b.scope === 'resource' && b.targetId === rid && overlaps(b, occ)))
          staffReasons.push(reason('RESOURCE_BLOCKED', `${r.name} は休止/ブロック中です`, { resourceId: rid }));
      }
      if (!sessionKey) {
        // joining an existing session consumes no extra resource units
        const bySession = new Map<string, Interval>();
        for (const a of activeAllocs) {
          if (a.kind !== 'resource' || a.targetId !== rid || !overlaps(a, occ)) continue;
          const cur = bySession.get(a.sessionKey);
          bySession.set(a.sessionKey, cur ? { start: Math.min(cur.start, a.start), end: Math.max(cur.end, a.end) } : { start: a.start, end: a.end });
        }
        const used = maxConcurrency([...bySession.values()], occ);
        if (used + 1 > r.quantity) staffReasons.push(reason('RESOURCE_FULL', `${r.name} は使用中です`, { resourceId: rid }));
      }
    }

    if (staffReasons.length) {
      reasons.push(...staffReasons);
      continue;
    }
    const load = staffId ? activeBookings.filter((b) => b.staffId === staffId && localDateOf(b.start, ctx.timezone) === date).length : 0;
    options.push({
      staffId,
      sessionKey,
      join: sessionKey !== null,
      capacity,
      remaining: capacity - booked - req.partySize,
      load,
      order: staff?.sortOrder ?? 0,
    });
  }

  if (!options.length) return { ok: false, reasons: dedupeReasons(reasons) };

  // おまかせ rule: join existing session > fewest bookings that day > display order > id
  options.sort(
    (a, b) =>
      Number(b.join) - Number(a.join) || a.load - b.load || a.order - b.order || String(a.staffId).localeCompare(String(b.staffId)),
  );
  const pick = options[0];
  return {
    ok: true,
    serviceId: service.id,
    staffId: pick.staffId,
    start,
    end,
    occupiedStart: occ.start,
    occupiedEnd: occ.end,
    sessionKey: pick.sessionKey,
    joinsExisting: pick.join,
    capacity: pick.capacity,
    remainingAfter: pick.remaining,
    resourceIds: [...service.resourceIds],
    occurrenceId: null,
  };
}

function dedupeReasons(list: Reason[]): Reason[] {
  const seen = new Set<string>();
  return list.filter((r) => {
    const k = `${r.code}|${r.staffId ?? ''}|${r.resourceId ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Candidate start instants for a local date (wall-clock grid from each business interval start). */
export function candidateStarts(ctx: EngineContext, service: EngineService, date: string): number[] {
  const step = slotStep(ctx, service);
  const out: number[] = [];
  for (const h of businessDayHours(ctx.input, date)) {
    for (let m = h.startMin; m < h.endMin; m += step) {
      const t = localToInstantStrict(date, m, ctx.timezone);
      if (t !== null) out.push(t);
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

export interface ListRequest {
  serviceId: string;
  staffId: string | null;
  fromDate: string;
  toDate: string;
  partySize: number;
  now: number;
  mode: 'public' | 'admin';
  excludeBookingId?: string;
  /** optional local time window (minutes) used by admin "空き検索" */
  timeFromMin?: number;
  timeToMin?: number;
  limit?: number;
}

/** List available slots. Uses checkSlot for every candidate — no shortcut path. */
export function listSlots(ctx: EngineContext, req: ListRequest): Slot[] {
  const service = ctx.servicesById.get(req.serviceId);
  if (!service) return [];
  if (service.bookingMode === 'sessions') return listOccurrenceSlots(ctx, req);
  const out: Slot[] = [];
  for (const date of eachDate(req.fromDate, req.toDate)) {
    for (const start of candidateStarts(ctx, service, date)) {
      const mins = minutesOfDay(start, ctx.timezone);
      if (req.timeFromMin !== undefined && mins < req.timeFromMin) continue;
      if (req.timeToMin !== undefined && mins >= req.timeToMin) continue;
      if (req.staffId === null && service.requiresStaff) {
        // collect every staff that can take it (for admin display); public hides ids
        const staffIds: string[] = [];
        let remaining: number | null = null;
        for (const s of ctx.input.staff) {
          if (!(s.serviceIds.includes(service.id) || service.staffIds.includes(s.id))) continue;
          const r = checkSlot(ctx, { ...req, staffId: s.id, start });
          if (r.ok) {
            staffIds.push(s.id);
            if (service.capacity > 1) remaining = Math.max(remaining ?? 0, r.remainingAfter + req.partySize);
          }
        }
        if (staffIds.length) out.push({ start, end: start + service.durationMin * MIN, staffIds, remaining, occurrenceId: null });
      } else {
        const r = checkSlot(ctx, { ...req, start });
        if (r.ok)
          out.push({
            start,
            end: r.end,
            staffIds: r.staffId ? [r.staffId] : [],
            remaining: service.capacity > 1 ? r.remainingAfter + req.partySize : null,
            occurrenceId: null,
          });
      }
      if (req.limit && out.length >= req.limit) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// sessions mode (recurring classes / workshops)

export function occurrenceBooked(ctx: EngineContext, occurrenceId: string, excludeBookingId?: string): number {
  return ctx.input.bookings.filter((b) => b.occurrenceId === occurrenceId && b.id !== excludeBookingId).reduce((n, b) => n + b.partySize, 0);
}

export function checkOccurrence(
  ctx: EngineContext,
  req: { occurrenceId: string; partySize: number; now: number; mode: 'public' | 'admin' | 'force'; excludeBookingId?: string },
): SlotResult {
  const o = ctx.input.occurrences.find((x) => x.id === req.occurrenceId);
  if (!o || o.status !== 'scheduled') return { ok: false, reasons: [reason('OCCURRENCE_UNAVAILABLE', 'この開催回は受け付けていません')] };
  const service = ctx.servicesById.get(o.serviceId);
  if (!service || service.archived || !service.acceptsBookings || (req.mode === 'public' && !service.isPublic))
    return { ok: false, reasons: [reason('SERVICE_UNAVAILABLE', 'このサービスは現在受け付けていません')] };
  const reasons: Reason[] = [];
  const maxParty = Math.min(service.maxPartySize, o.capacity);
  if (!Number.isInteger(req.partySize) || req.partySize < 1 || req.partySize > maxParty)
    return { ok: false, reasons: [reason('PARTY_SIZE', `人数は1〜${maxParty}名で指定してください`)] };
  if (req.mode === 'public') reasons.push(...bookingWindowReasons(ctx, o.start, req.now, ctx.input.business.minNoticeMin));
  if (req.mode !== 'force') {
    const occ = { start: o.occupiedStart, end: o.occupiedEnd };
    if (ctx.input.exceptions.some((e) => e.date === o.localDate && e.kind === 'closed'))
      reasons.push(reason('OUTSIDE_BUSINESS_HOURS', '休業日です'));
    if (ctx.input.blocks.some((b) => b.scope === 'business' && overlaps(b, occ))) reasons.push(reason('BUSINESS_BLOCKED', '受付停止（ブロック）時間と重なります'));
    if (o.staffId && ctx.input.blocks.some((b) => b.scope === 'staff' && b.targetId === o.staffId && overlaps(b, occ)))
      reasons.push(reason('STAFF_BLOCKED', 'スタッフの休み/ブロックと重なります', { staffId: o.staffId }));
    for (const rid of o.resourceIds)
      if (ctx.input.blocks.some((b) => b.scope === 'resource' && b.targetId === rid && overlaps(b, occ)))
        reasons.push(reason('RESOURCE_BLOCKED', '設備/部屋が休止/ブロック中です', { resourceId: rid }));
  }
  if (o.staffId) {
    const s = ctx.staffById.get(o.staffId);
    if (!s || s.archived) reasons.push(reason('STAFF_UNAVAILABLE', '担当スタッフが利用できません', { staffId: o.staffId }));
  }
  const booked = occurrenceBooked(ctx, o.id, req.excludeBookingId);
  if (booked + req.partySize > o.capacity) reasons.push(reason('CAPACITY_FULL', `定員に達しています（残り${Math.max(0, o.capacity - booked)}名）`));
  if (reasons.length) return { ok: false, reasons };
  return {
    ok: true,
    serviceId: service.id,
    staffId: o.staffId,
    start: o.start,
    end: o.end,
    occupiedStart: o.occupiedStart,
    occupiedEnd: o.occupiedEnd,
    sessionKey: `occ:${o.id}`,
    joinsExisting: true,
    capacity: o.capacity,
    remainingAfter: o.capacity - booked - req.partySize,
    resourceIds: [...o.resourceIds],
    occurrenceId: o.id,
  };
}

function listOccurrenceSlots(ctx: EngineContext, req: ListRequest): Slot[] {
  const tz = ctx.timezone;
  const out: Slot[] = [];
  const list = ctx.input.occurrences
    .filter((o) => o.serviceId === req.serviceId && o.localDate >= req.fromDate && o.localDate <= req.toDate)
    .filter((o) => !req.staffId || o.staffId === req.staffId)
    .sort((a, b) => a.start - b.start);
  for (const o of list) {
    const mins = minutesOfDay(o.start, tz);
    if (req.timeFromMin !== undefined && mins < req.timeFromMin) continue;
    if (req.timeToMin !== undefined && mins >= req.timeToMin) continue;
    const r = checkOccurrence(ctx, { occurrenceId: o.id, partySize: req.partySize, now: req.now, mode: req.mode, excludeBookingId: req.excludeBookingId });
    if (r.ok) out.push({ start: o.start, end: o.end, staffIds: o.staffId ? [o.staffId] : [], remaining: r.remainingAfter + req.partySize, occurrenceId: o.id });
    if (req.limit && out.length >= req.limit) break;
  }
  return out;
}

/** Local dates that are within the public booking window. */
export function bookingWindowDates(ctx: EngineContext, now: number): { first: string; last: string } {
  const b = ctx.input.business;
  const today = localDateOf(now, b.timezone);
  return { first: today, last: addDays(today, b.maxAdvanceDays) };
}

export function occurrenceOccupancy(service: EngineService, start: number): { end: number; occupiedStart: number; occupiedEnd: number } {
  const end = start + service.durationMin * MIN;
  return { end, occupiedStart: start - service.bufferBeforeMin * MIN, occupiedEnd: end + service.bufferAfterMin * MIN };
}

export type { EngineOccurrence };
export { contains };

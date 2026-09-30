import { EngineContext } from '../../src/server/engine/availability.js';
import { localToInstant } from '../../src/server/engine/time.js';
import type {
  EngineAllocation,
  EngineBooking,
  EngineInput,
  EngineResource,
  EngineService,
  EngineStaff,
  HoursInterval,
  WeeklyHours,
} from '../../src/server/engine/types.js';

export const TZ = 'Asia/Tokyo';
export const h = (hh: number, mm = 0) => hh * 60 + mm;
export const hours = (from: number, to: number): HoursInterval => ({ startMin: from, endMin: to });

/** Mon-Sun 10:00-18:00, Wednesday closed. */
export function week(interval: HoursInterval | HoursInterval[] = hours(h(10), h(18)), closedWeekdays = [3]): WeeklyHours {
  const list = Array.isArray(interval) ? interval : [interval];
  return [0, 1, 2, 3, 4, 5, 6].map((d) => (closedWeekdays.includes(d) ? [] : list.map((x) => ({ ...x }))));
}

export function at(date: string, hh: number, mm = 0, tz = TZ): number {
  return localToInstant(date, hh * 60 + mm, tz);
}

export function staff(id: string, serviceIds: string[], extra: Partial<EngineStaff> = {}): EngineStaff {
  return {
    id,
    displayName: id,
    acceptsBookings: true,
    archived: false,
    sortOrder: 0,
    serviceIds,
    usesBusinessHours: true,
    weeklyHours: week(),
    breaks: week([], []),
    maxParticipants: null,
    ...extra,
  };
}

export function service(id: string, extra: Partial<EngineService> = {}): EngineService {
  return {
    id,
    name: id,
    durationMin: 60,
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    capacity: 1,
    maxPartySize: 1,
    requiresStaff: true,
    bookingMode: 'slots',
    slotIntervalMin: null,
    acceptsBookings: true,
    isPublic: true,
    archived: false,
    resourceIds: [],
    staffIds: [],
    ...extra,
  };
}

export function resource(id: string, extra: Partial<EngineResource> = {}): EngineResource {
  return { id, name: id, quantity: 1, personCapacity: null, hasHours: false, weeklyHours: week([], []), archived: false, ...extra };
}

export function baseInput(extra: Partial<EngineInput> = {}, tz = TZ): EngineInput {
  return {
    business: { id: 'biz', timezone: tz, slotIntervalMin: 30, minNoticeMin: 0, maxAdvanceDays: 60, weeklyHours: week() },
    exceptions: [],
    staff: [staff('aki', ['s60'])],
    resources: [],
    services: [service('s60')],
    blocks: [],
    allocations: [],
    bookings: [],
    occurrences: [],
    ...extra,
  };
}

let seq = 0;
/** Add an existing active booking (allocations for staff & resources) to the input. */
export function addBooking(
  input: EngineInput,
  o: { serviceId: string; staffId: string | null; start: number; partySize?: number; resourceIds?: string[]; sessionKey?: string },
): EngineBooking {
  const svc = input.services.find((s) => s.id === o.serviceId)!;
  const id = `bk${++seq}`;
  const sessionKey = o.sessionKey ?? (svc.capacity > 1 ? `g:${svc.id}:${o.staffId ?? '-'}:${o.start}` : `b:${id}`);
  const occStart = o.start - svc.bufferBeforeMin * 60_000;
  const occEnd = o.start + (svc.durationMin + svc.bufferAfterMin) * 60_000;
  const b: EngineBooking = { id, serviceId: svc.id, staffId: o.staffId, sessionKey, occurrenceId: null, start: o.start, partySize: o.partySize ?? 1 };
  input.bookings.push(b);
  const allocs: EngineAllocation[] = [];
  if (o.staffId) allocs.push({ kind: 'staff', targetId: o.staffId, start: occStart, end: occEnd, sessionKey, bookingId: id, occurrenceId: null });
  for (const r of o.resourceIds ?? svc.resourceIds)
    allocs.push({ kind: 'resource', targetId: r, start: occStart, end: occEnd, sessionKey, bookingId: id, occurrenceId: null });
  input.allocations.push(...allocs);
  return b;
}

export const ctxOf = (input: EngineInput) => new EngineContext(input);

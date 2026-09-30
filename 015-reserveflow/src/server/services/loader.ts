import type { Queryable } from '../db/pool.js';
import { EngineContext } from '../engine/availability.js';
import { addDays, dayRange } from '../engine/time.js';
import {
  emptyWeek,
  type EngineInput,
  type EngineService,
  type EngineStaff,
  type EngineResource,
  type WeeklyHours,
} from '../engine/types.js';
import { notFound } from '../lib/errors.js';

export const ACTIVE_STATUSES = ['confirmed', 'checked_in', 'completed', 'no_show'] as const;

export interface BusinessRow {
  id: string;
  slug: string;
  name: string;
  brand_name: string | null;
  description: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  website_url: string | null;
  sns_url: string | null;
  timezone: string;
  week_start: number;
  slot_interval_min: number;
  min_notice_min: number;
  max_advance_days: number;
  change_deadline_min: number;
  cancel_deadline_min: number;
  reminder_hours_before: number;
  theme_color: string;
  completion_message: string;
  notes: string;
  phone_requirement: 'required' | 'optional' | 'hidden';
  consent_text: string;
  email_signature: string;
  notify_owner_new_booking: boolean;
  owner_notify_email: string | null;
  published: boolean;
  is_sample: boolean;
  logo_mime: string | null;
  created_at: Date;
  updated_at: Date;
}

export const BUSINESS_COLUMNS = `id, slug, name, brand_name, description, phone, email, address, website_url, sns_url, timezone, week_start,
  slot_interval_min, min_notice_min, max_advance_days, change_deadline_min, cancel_deadline_min, reminder_hours_before,
  theme_color, completion_message, notes, phone_requirement, consent_text, email_signature, notify_owner_new_booking,
  owner_notify_email, published, is_sample, logo_mime, created_at, updated_at`;

export async function getBusiness(q: Queryable, businessId: string): Promise<BusinessRow> {
  const r = await q.query<BusinessRow>(`SELECT ${BUSINESS_COLUMNS} FROM businesses WHERE id = $1`, [businessId]);
  if (!r.rows[0]) throw notFound('事業者');
  return r.rows[0];
}

function weekFrom(rows: Array<{ weekday: number; start_min: number; end_min: number }>): WeeklyHours {
  const w = emptyWeek();
  for (const r of rows) w[r.weekday].push({ startMin: r.start_min, endMin: r.end_min });
  for (const d of w) d.sort((a, b) => a.startMin - b.startMin);
  return w;
}

/**
 * Load everything the engine needs for local dates [fromDate, toDate] (with a ±2 day margin
 * so buffers and cross-midnight intervals are always covered).
 */
export async function loadEngine(q: Queryable, businessId: string, fromDate: string, toDate: string): Promise<{ ctx: EngineContext; business: BusinessRow }> {
  const business = await getBusiness(q, businessId);
  const tz = business.timezone;
  const from = new Date(dayRange(addDays(fromDate, -2), tz).start);
  const to = new Date(dayRange(addDays(toDate, 2), tz).end);

  const [hours, exceptions, staffRows, staffSvc, resRows, svcRows, svcRes, blocks, allocs, bookings, occs] = await Promise.all([
    q.query(`SELECT owner_kind, owner_id, weekday, start_min, end_min FROM weekly_hours WHERE business_id = $1`, [businessId]),
    q.query(`SELECT date, kind, intervals FROM date_exceptions WHERE business_id = $1 AND date BETWEEN $2 AND $3`, [businessId, addDays(fromDate, -2), addDays(toDate, 2)]),
    q.query(`SELECT id, display_name, accepts_bookings, archived_at, sort_order, uses_business_hours, max_participants FROM staff WHERE business_id = $1`, [businessId]),
    q.query(`SELECT staff_id, service_id FROM staff_services WHERE business_id = $1`, [businessId]),
    q.query(`SELECT id, name, quantity, person_capacity, has_hours, archived_at FROM resources WHERE business_id = $1`, [businessId]),
    q.query(
      `SELECT id, name, duration_min, buffer_before_min, buffer_after_min, capacity, max_party_size, requires_staff, booking_mode,
              slot_interval_min, accepts_bookings, is_public, archived_at FROM services WHERE business_id = $1`,
      [businessId],
    ),
    q.query(`SELECT service_id, resource_id FROM service_resources WHERE business_id = $1`, [businessId]),
    q.query(`SELECT id, scope, target_id, start_at, end_at FROM blocks WHERE business_id = $1 AND start_at < $3 AND end_at > $2`, [businessId, from, to]),
    q.query(
      `SELECT kind, target_id, lower(occupied) AS s, upper(occupied) AS e, session_key, booking_id, occurrence_id
         FROM allocations WHERE business_id = $1 AND active AND occupied && tstzrange($2, $3)`,
      [businessId, from, to],
    ),
    q.query(
      `SELECT id, service_id, staff_id, session_key, occurrence_id, start_at, party_size FROM bookings
        WHERE business_id = $1 AND status = ANY($4) AND occupied_end > $2 AND occupied_start < $3`,
      [businessId, from, to, ACTIVE_STATUSES],
    ),
    q.query(
      `SELECT o.id, o.service_id, o.staff_id, o.local_date, o.start_at, o.end_at, o.occupied_start, o.occupied_end, o.capacity, o.status,
              COALESCE((SELECT array_agg(a.target_id) FROM allocations a WHERE a.occurrence_id = o.id AND a.kind = 'resource'), '{}') AS resource_ids
         FROM session_occurrences o WHERE o.business_id = $1 AND o.start_at < $3 AND o.end_at > $2`,
      [businessId, from, to],
    ),
  ]);

  const byOwner = new Map<string, Array<{ weekday: number; start_min: number; end_min: number }>>();
  for (const r of hours.rows) {
    const k = `${r.owner_kind}:${r.owner_id}`;
    if (!byOwner.has(k)) byOwner.set(k, []);
    byOwner.get(k)!.push(r);
  }
  const svcStaff = new Map<string, string[]>();
  const staffSvcMap = new Map<string, string[]>();
  for (const r of staffSvc.rows) {
    if (!svcStaff.has(r.service_id)) svcStaff.set(r.service_id, []);
    svcStaff.get(r.service_id)!.push(r.staff_id);
    if (!staffSvcMap.has(r.staff_id)) staffSvcMap.set(r.staff_id, []);
    staffSvcMap.get(r.staff_id)!.push(r.service_id);
  }
  const svcResMap = new Map<string, string[]>();
  for (const r of svcRes.rows) {
    if (!svcResMap.has(r.service_id)) svcResMap.set(r.service_id, []);
    svcResMap.get(r.service_id)!.push(r.resource_id);
  }

  const staff: EngineStaff[] = staffRows.rows.map((s) => ({
    id: s.id,
    displayName: s.display_name,
    acceptsBookings: s.accepts_bookings,
    archived: s.archived_at !== null,
    sortOrder: s.sort_order,
    serviceIds: staffSvcMap.get(s.id) ?? [],
    usesBusinessHours: s.uses_business_hours,
    weeklyHours: weekFrom(byOwner.get(`staff:${s.id}`) ?? []),
    breaks: weekFrom(byOwner.get(`staff_break:${s.id}`) ?? []),
    maxParticipants: s.max_participants,
  }));
  const resources: EngineResource[] = resRows.rows.map((r) => ({
    id: r.id,
    name: r.name,
    quantity: r.quantity,
    personCapacity: r.person_capacity,
    hasHours: r.has_hours,
    weeklyHours: weekFrom(byOwner.get(`resource:${r.id}`) ?? []),
    archived: r.archived_at !== null,
  }));
  const services: EngineService[] = svcRows.rows.map((s) => ({
    id: s.id,
    name: s.name,
    durationMin: s.duration_min,
    bufferBeforeMin: s.buffer_before_min,
    bufferAfterMin: s.buffer_after_min,
    capacity: s.capacity,
    maxPartySize: s.max_party_size,
    requiresStaff: s.requires_staff,
    bookingMode: s.booking_mode,
    slotIntervalMin: s.slot_interval_min,
    acceptsBookings: s.accepts_bookings,
    isPublic: s.is_public,
    archived: s.archived_at !== null,
    resourceIds: svcResMap.get(s.id) ?? [],
    staffIds: svcStaff.get(s.id) ?? [],
  }));

  const input: EngineInput = {
    business: {
      id: business.id,
      timezone: tz,
      slotIntervalMin: business.slot_interval_min,
      minNoticeMin: business.min_notice_min,
      maxAdvanceDays: business.max_advance_days,
      weeklyHours: weekFrom(byOwner.get(`business:${business.id}`) ?? []),
    },
    exceptions: exceptions.rows.map((e) => ({ date: e.date, kind: e.kind, intervals: e.intervals })),
    staff,
    resources,
    services,
    blocks: blocks.rows.map((b) => ({ id: b.id, scope: b.scope, targetId: b.target_id, start: b.start_at.getTime(), end: b.end_at.getTime() })),
    allocations: allocs.rows.map((a) => ({
      kind: a.kind,
      targetId: a.target_id,
      start: a.s.getTime(),
      end: a.e.getTime(),
      sessionKey: a.session_key,
      bookingId: a.booking_id,
      occurrenceId: a.occurrence_id,
    })),
    bookings: bookings.rows.map((b) => ({
      id: b.id,
      serviceId: b.service_id,
      staffId: b.staff_id,
      sessionKey: b.session_key,
      occurrenceId: b.occurrence_id,
      start: b.start_at.getTime(),
      partySize: b.party_size,
    })),
    occurrences: occs.rows.map((o) => ({
      id: o.id,
      serviceId: o.service_id,
      staffId: o.staff_id,
      localDate: o.local_date,
      start: o.start_at.getTime(),
      end: o.end_at.getTime(),
      occupiedStart: o.occupied_start.getTime(),
      occupiedEnd: o.occupied_end.getTime(),
      capacity: o.capacity,
      status: o.status,
      resourceIds: o.resource_ids,
    })),
  };
  return { ctx: new EngineContext(input), business };
}

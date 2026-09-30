import type pg from 'pg';
import { lockBusiness, withTx, type Queryable } from '../db/pool.js';
import { maxConcurrency, overlaps } from '../engine/intervals.js';
import { addDays, eachDate, localDateOf, localToInstantStrict, weekdayOf } from '../engine/time.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { audit, type Actor } from './audit.js';
import { cancelBooking } from './bookings.js';

export interface RuleRow {
  id: string;
  business_id: string;
  service_id: string;
  staff_id: string | null;
  freq: 'weekly' | 'monthly_nth_weekday' | 'monthly_day';
  interval_n: number;
  weekdays: number[];
  nth: number | null;
  month_day: number | null;
  start_time_min: number;
  start_date: string;
  end_date: string | null;
  capacity: number | null;
  active: boolean;
  generated_until?: string | null;
}

/** Dates produced by a rule within [from, to]. Kept deliberately simple (weekly / monthly), no free-form RRULE. */
export function ruleDates(rule: Pick<RuleRow, 'freq' | 'interval_n' | 'weekdays' | 'nth' | 'month_day' | 'start_date' | 'end_date'>, from: string, to: string): string[] {
  const first = from > rule.start_date ? from : rule.start_date;
  const last = rule.end_date && rule.end_date < to ? rule.end_date : to;
  if (first > last) return [];
  const out: string[] = [];
  const startWeek = weekIndex(rule.start_date);
  const startMonth = monthIndex(rule.start_date);
  for (const d of eachDate(first, last)) {
    const wd = weekdayOf(d);
    if (rule.freq === 'weekly') {
      if (!rule.weekdays.includes(wd)) continue;
      if ((weekIndex(d) - startWeek) % rule.interval_n !== 0) continue;
      out.push(d);
    } else {
      if ((monthIndex(d) - startMonth) % rule.interval_n !== 0) continue;
      const day = Number(d.slice(8, 10));
      if (rule.freq === 'monthly_day') {
        if (day === rule.month_day) out.push(d);
      } else {
        if (!rule.weekdays.includes(wd) || rule.nth === null) continue;
        const nth = Math.floor((day - 1) / 7) + 1;
        const isLast = addDays(d, 7).slice(5, 7) !== d.slice(5, 7);
        if (nth === rule.nth || (rule.nth === -1 && isLast)) out.push(d);
      }
    }
  }
  return out;
}

function weekIndex(d: string): number {
  // weeks since epoch, Monday based
  const days = Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
  return Math.floor((days + 3) / 7);
}

function monthIndex(d: string): number {
  return Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;
}

export interface GenerateResult {
  created: number;
  skipped: Array<{ date: string; reason: string }>;
}

/**
 * Materialize occurrences for a rule up to `untilDate`. Each occurrence immediately holds its
 * staff/resources (allocations) so private bookings cannot take that time. Conflicting dates are skipped and reported.
 * Caller must hold the business lock.
 */
export async function generateForRule(tx: Queryable, rule: RuleRow, untilDate: string, now = Date.now()): Promise<GenerateResult> {
  const biz = (await tx.query(`SELECT timezone FROM businesses WHERE id = $1`, [rule.business_id])).rows[0];
  const tz: string = biz.timezone;
  const svc = (await tx.query(`SELECT * FROM services WHERE id = $1 AND business_id = $2`, [rule.service_id, rule.business_id])).rows[0];
  if (!svc) throw notFound('サービス');
  const resIds: string[] = (await tx.query(`SELECT resource_id FROM service_resources WHERE service_id = $1`, [rule.service_id])).rows.map((r) => r.resource_id);
  const today = localDateOf(now, tz);
  const res: GenerateResult = { created: 0, skipped: [] };
  if (!rule.active) return res;
  for (const date of ruleDates(rule, today, untilDate)) {
    const start = localToInstantStrict(date, rule.start_time_min, tz);
    if (start === null) {
      res.skipped.push({ date, reason: '夏時間切替で存在しない時刻' });
      continue;
    }
    if (start <= now) continue;
    const exists = await tx.query(`SELECT 1 FROM session_occurrences WHERE rule_id = $1 AND start_at = $2`, [rule.id, new Date(start)]);
    if (exists.rows[0]) continue;
    const closed = await tx.query(`SELECT 1 FROM date_exceptions WHERE business_id = $1 AND date = $2 AND kind = 'closed'`, [rule.business_id, date]);
    if (closed.rows[0]) {
      res.skipped.push({ date, reason: '休業日' });
      continue;
    }
    const end = start + svc.duration_min * 60_000;
    const occ = { start: start - svc.buffer_before_min * 60_000, end: end + svc.buffer_after_min * 60_000 };
    const conflictReason = await occupancyConflict(tx, rule.business_id, rule.staff_id, resIds, occ);
    if (conflictReason) {
      res.skipped.push({ date, reason: conflictReason });
      continue;
    }
    const capacity = rule.capacity ?? svc.capacity;
    const ins = await tx.query(
      `INSERT INTO session_occurrences (business_id, service_id, rule_id, staff_id, local_date, start_at, end_at, occupied_start, occupied_end, capacity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [rule.business_id, rule.service_id, rule.id, rule.staff_id, date, new Date(start), new Date(end), new Date(occ.start), new Date(occ.end), capacity],
    );
    await insertOccurrenceAllocations(tx, rule.business_id, ins.rows[0].id, rule.staff_id, resIds, occ);
    res.created++;
  }
  await tx.query(`UPDATE recurrence_rules SET generated_until = $2 WHERE id = $1`, [rule.id, untilDate]);
  return res;
}

async function insertOccurrenceAllocations(tx: Queryable, businessId: string, occurrenceId: string, staffId: string | null, resIds: string[], occ: { start: number; end: number }) {
  const range = `[${new Date(occ.start).toISOString()},${new Date(occ.end).toISOString()})`;
  const key = `occ:${occurrenceId}`;
  if (staffId) await tx.query(`INSERT INTO allocations (business_id, occurrence_id, kind, target_id, occupied, session_key) VALUES ($1,$2,'staff',$3,$4::tstzrange,$5)`, [businessId, occurrenceId, staffId, range, key]);
  for (const r of resIds) await tx.query(`INSERT INTO allocations (business_id, occurrence_id, kind, target_id, occupied, session_key) VALUES ($1,$2,'resource',$3,$4::tstzrange,$5)`, [businessId, occurrenceId, r, range, key]);
}

async function occupancyConflict(tx: Queryable, businessId: string, staffId: string | null, resIds: string[], occ: { start: number; end: number }, ownKey?: string): Promise<string | null> {
  const range = `[${new Date(occ.start).toISOString()},${new Date(occ.end).toISOString()})`;
  if (staffId) {
    const busy = await tx.query(`SELECT 1 FROM allocations WHERE business_id = $1 AND active AND kind = 'staff' AND target_id = $2 AND occupied && $3::tstzrange AND session_key <> COALESCE($4, '') LIMIT 1`, [businessId, staffId, range, ownKey ?? null]);
    if (busy.rows[0]) return 'スタッフに別の予約/開催があります';
    const blk = await tx.query(`SELECT 1 FROM blocks WHERE business_id = $1 AND ((scope = 'staff' AND target_id = $2) OR scope = 'business') AND start_at < $4 AND end_at > $3 LIMIT 1`, [businessId, staffId, new Date(occ.start), new Date(occ.end)]);
    if (blk.rows[0]) return 'スタッフの休み/ブロックと重なります';
  }
  for (const rid of resIds) {
    const r = (await tx.query(`SELECT name, quantity FROM resources WHERE id = $1`, [rid])).rows[0];
    const allocs = await tx.query(`SELECT session_key, lower(occupied) AS s, upper(occupied) AS e FROM allocations WHERE business_id = $1 AND active AND kind = 'resource' AND target_id = $2 AND occupied && $3::tstzrange AND session_key <> COALESCE($4, '')`, [businessId, rid, range, ownKey ?? null]);
    const bySession = new Map<string, { start: number; end: number }>();
    for (const a of allocs.rows) bySession.set(a.session_key, { start: a.s.getTime(), end: a.e.getTime() });
    if (maxConcurrency([...bySession.values()].filter((x) => overlaps(x, occ)), occ) + 1 > r.quantity) return `${r.name} が使用中です`;
    const blk = await tx.query(`SELECT 1 FROM blocks WHERE business_id = $1 AND scope = 'resource' AND target_id = $2 AND start_at < $4 AND end_at > $3 LIMIT 1`, [businessId, rid, new Date(occ.start), new Date(occ.end)]);
    if (blk.rows[0]) return `${r.name} が休止/ブロック中です`;
  }
  return null;
}

async function horizonFor(tx: Queryable, businessId: string, now: number): Promise<string> {
  const b = (await tx.query(`SELECT timezone, max_advance_days FROM businesses WHERE id = $1`, [businessId])).rows[0];
  return addDays(localDateOf(now, b.timezone), b.max_advance_days);
}

export async function createRule(pool: pg.Pool, businessId: string, input: Omit<RuleRow, 'id' | 'business_id' | 'active'>, actor: Actor): Promise<{ id: string; result: GenerateResult }> {
  validateRule(input);
  return withTx(pool, async (tx) => {
    await lockBusiness(tx, businessId);
    const svc = (await tx.query(`SELECT booking_mode FROM services WHERE id = $1 AND business_id = $2`, [input.service_id, businessId])).rows[0];
    if (!svc) throw notFound('サービス');
    if (svc.booking_mode !== 'sessions') throw badRequest('繰り返し開催枠は「開催日程から選ぶ」形式のサービスにのみ設定できます');
    if (input.staff_id) {
      const st = (await tx.query(`SELECT 1 FROM staff WHERE id = $1 AND business_id = $2 AND archived_at IS NULL`, [input.staff_id, businessId])).rows[0];
      if (!st) throw notFound('スタッフ');
    }
    const r = await tx.query<RuleRow>(
      `INSERT INTO recurrence_rules (business_id, service_id, staff_id, freq, interval_n, weekdays, nth, month_day, start_time_min, start_date, end_date, capacity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [businessId, input.service_id, input.staff_id, input.freq, input.interval_n, input.weekdays, input.nth, input.month_day, input.start_time_min, input.start_date, input.end_date, input.capacity],
    );
    const result = await generateForRule(tx, r.rows[0], await horizonFor(tx, businessId, Date.now()));
    await audit(tx, businessId, actor, 'recurrence.create', 'recurrence_rule', r.rows[0].id, { created: result.created, skipped: result.skipped.length });
    return { id: r.rows[0].id, result };
  });
}

/**
 * Update a rule. Only FUTURE occurrences of this rule that have no bookings at all and were not individually
 * modified are replaced. Past occurrences, booked occurrences and individually edited ones are left untouched.
 */
export async function updateRule(pool: pg.Pool, businessId: string, ruleId: string, input: Omit<RuleRow, 'id' | 'business_id'>, actor: Actor): Promise<{ removed: number; kept: number; result: GenerateResult }> {
  validateRule(input);
  return withTx(pool, async (tx) => {
    await lockBusiness(tx, businessId);
    const cur = (await tx.query(`SELECT * FROM recurrence_rules WHERE id = $1 AND business_id = $2 FOR UPDATE`, [ruleId, businessId])).rows[0];
    if (!cur) throw notFound('繰り返しルール');
    const del = await tx.query(
      `DELETE FROM session_occurrences o WHERE o.rule_id = $1 AND o.start_at > now() AND NOT o.modified
          AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.occurrence_id = o.id) RETURNING id`,
      [ruleId],
    );
    const kept = await tx.query(`SELECT count(*)::int AS n FROM session_occurrences WHERE rule_id = $1 AND start_at > now()`, [ruleId]);
    const r = await tx.query<RuleRow>(
      `UPDATE recurrence_rules SET staff_id=$3, freq=$4, interval_n=$5, weekdays=$6, nth=$7, month_day=$8, start_time_min=$9, start_date=$10,
              end_date=$11, capacity=$12, active=$13, updated_at=now() WHERE id=$1 AND business_id=$2 RETURNING *`,
      [ruleId, businessId, input.staff_id, input.freq, input.interval_n, input.weekdays, input.nth, input.month_day, input.start_time_min, input.start_date, input.end_date, input.capacity, input.active],
    );
    const result = await generateForRule(tx, r.rows[0], await horizonFor(tx, businessId, Date.now()));
    await audit(tx, businessId, actor, 'recurrence.update', 'recurrence_rule', ruleId, { removed: del.rowCount, kept: kept.rows[0].n, created: result.created });
    return { removed: del.rowCount ?? 0, kept: kept.rows[0].n, result };
  });
}

function validateRule(i: Pick<RuleRow, 'freq' | 'weekdays' | 'nth' | 'month_day' | 'start_date' | 'end_date' | 'interval_n'>) {
  if (i.freq === 'weekly' && !i.weekdays.length) throw badRequest('曜日を1つ以上選んでください');
  if (i.freq === 'monthly_nth_weekday' && (i.weekdays.length !== 1 || !i.nth)) throw badRequest('「第n何曜日」を指定してください');
  if (i.freq === 'monthly_day' && !(i.month_day && i.month_day >= 1 && i.month_day <= 31)) throw badRequest('日にち（1〜31）を指定してください');
  if (i.end_date && i.end_date < i.start_date) throw badRequest('終了日は開始日以降にしてください');
}

/** Extend every active rule's horizon (run periodically by the worker). */
export async function extendAllRules(pool: pg.Pool, now = Date.now()): Promise<number> {
  const rules = (await pool.query<RuleRow>(`SELECT * FROM recurrence_rules WHERE active`)).rows;
  let created = 0;
  for (const rule of rules) {
    await withTx(pool, async (tx) => {
      await lockBusiness(tx, rule.business_id);
      const h = await horizonFor(tx, rule.business_id, now);
      if (rule.generated_until && rule.generated_until >= h) return;
      created += (await generateForRule(tx, rule, h, now)).created;
    });
  }
  return created;
}

/** Individually edit one occurrence (capacity / note / staff / time when unbooked). */
export async function updateOccurrence(
  pool: pg.Pool,
  businessId: string,
  id: string,
  patch: { capacity?: number; note?: string; staffId?: string | null; start?: number },
  actor: Actor,
): Promise<void> {
  await withTx(pool, async (tx) => {
    await lockBusiness(tx, businessId);
    const o = (await tx.query(`SELECT * FROM session_occurrences WHERE id = $1 AND business_id = $2 FOR UPDATE`, [id, businessId])).rows[0];
    if (!o) throw notFound('開催回');
    const booked = (await tx.query(`SELECT COALESCE(sum(party_size),0)::int AS n, count(*)::int AS c FROM bookings WHERE occurrence_id = $1 AND status IN ('confirmed','checked_in','completed','no_show')`, [id])).rows[0];
    if (patch.capacity !== undefined && patch.capacity < booked.n) throw conflict('CAPACITY_BELOW_BOOKED', `定員は予約済み人数（${booked.n}名）以上にしてください`);
    const timeChanged = patch.start !== undefined && patch.start !== o.start_at.getTime();
    const staffChanged = patch.staffId !== undefined && patch.staffId !== o.staff_id;
    if ((timeChanged || staffChanged) && booked.c > 0) throw conflict('OCCURRENCE_HAS_BOOKINGS', '予約が入っている回の日時/担当は変更できません。各予約を個別に変更してください。');
    if (timeChanged || staffChanged) {
      const svc = (await tx.query(`SELECT * FROM services WHERE id = $1`, [o.service_id])).rows[0];
      const start = patch.start ?? o.start_at.getTime();
      const end = start + svc.duration_min * 60_000;
      const occ = { start: start - svc.buffer_before_min * 60_000, end: end + svc.buffer_after_min * 60_000 };
      const resIds: string[] = (await tx.query(`SELECT target_id FROM allocations WHERE occurrence_id = $1 AND kind = 'resource'`, [id])).rows.map((r) => r.target_id);
      const staffId = patch.staffId === undefined ? o.staff_id : patch.staffId;
      await tx.query(`UPDATE allocations SET active = false WHERE occurrence_id = $1`, [id]);
      const c = await occupancyConflict(tx, businessId, staffId, resIds, occ);
      if (c) throw conflict('SLOT_UNAVAILABLE', c);
      await tx.query(`DELETE FROM allocations WHERE occurrence_id = $1`, [id]);
      const tz = (await tx.query(`SELECT timezone FROM businesses WHERE id = $1`, [businessId])).rows[0].timezone;
      await tx.query(`UPDATE session_occurrences SET start_at=$2, end_at=$3, occupied_start=$4, occupied_end=$5, staff_id=$6, local_date=$7 WHERE id=$1`, [
        id, new Date(start), new Date(end), new Date(occ.start), new Date(occ.end), staffId, localDateOf(start, tz),
      ]);
      if (o.status === 'scheduled') await insertOccurrenceAllocations(tx, businessId, id, staffId, resIds, occ);
    }
    await tx.query(`UPDATE session_occurrences SET capacity = COALESCE($2, capacity), note = COALESCE($3, note), modified = true WHERE id = $1`, [id, patch.capacity ?? null, patch.note ?? null]);
    await audit(tx, businessId, actor, 'occurrence.update', 'occurrence', id, { capacity: patch.capacity, timeChanged, staffChanged });
  });
}

/** Pause (cancel) one occurrence. Existing bookings are only cancelled when explicitly requested. */
export async function cancelOccurrence(pool: pg.Pool, businessId: string, id: string, opts: { cancelBookings: boolean; reason?: string }, actor: Actor): Promise<{ cancelledBookings: number }> {
  const bookings = (await pool.query(`SELECT id FROM bookings WHERE occurrence_id = $1 AND business_id = $2 AND status = 'confirmed'`, [id, businessId])).rows;
  if (bookings.length && !opts.cancelBookings) throw conflict('OCCURRENCE_HAS_BOOKINGS', `この回には${bookings.length}件の予約があります。予約もキャンセルする場合は確認してください。`);
  for (const b of bookings) await cancelBooking(pool, { businessId, bookingId: b.id, by: 'business', reason: opts.reason ?? '開催中止', actor });
  await withTx(pool, async (tx) => {
    await lockBusiness(tx, businessId);
    const r = await tx.query(`UPDATE session_occurrences SET status = 'cancelled', modified = true WHERE id = $1 AND business_id = $2 RETURNING id`, [id, businessId]);
    if (!r.rows[0]) throw notFound('開催回');
    await tx.query(`UPDATE allocations SET active = false WHERE occurrence_id = $1`, [id]);
    await audit(tx, businessId, actor, 'occurrence.cancel', 'occurrence', id, { cancelledBookings: bookings.length });
  });
  return { cancelledBookings: bookings.length };
}

/** Create a single (non-recurring) session occurrence. */
export async function createOccurrence(pool: pg.Pool, businessId: string, i: { serviceId: string; staffId: string | null; start: number; capacity?: number | null; note?: string }, actor: Actor): Promise<string> {
  return withTx(pool, async (tx) => {
    await lockBusiness(tx, businessId);
    const svc = (await tx.query(`SELECT * FROM services WHERE id = $1 AND business_id = $2`, [i.serviceId, businessId])).rows[0];
    if (!svc) throw notFound('サービス');
    if (svc.booking_mode !== 'sessions') throw badRequest('開催回は「開催日程から選ぶ」形式のサービスにのみ作成できます');
    const tz = (await tx.query(`SELECT timezone FROM businesses WHERE id = $1`, [businessId])).rows[0].timezone;
    const resIds: string[] = (await tx.query(`SELECT resource_id FROM service_resources WHERE service_id = $1`, [i.serviceId])).rows.map((r) => r.resource_id);
    const end = i.start + svc.duration_min * 60_000;
    const occ = { start: i.start - svc.buffer_before_min * 60_000, end: end + svc.buffer_after_min * 60_000 };
    const c = await occupancyConflict(tx, businessId, i.staffId, resIds, occ);
    if (c) throw conflict('SLOT_UNAVAILABLE', c);
    const ins = await tx.query(
      `INSERT INTO session_occurrences (business_id, service_id, staff_id, local_date, start_at, end_at, occupied_start, occupied_end, capacity, note, modified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true) RETURNING id`,
      [businessId, i.serviceId, i.staffId, localDateOf(i.start, tz), new Date(i.start), new Date(end), new Date(occ.start), new Date(occ.end), i.capacity ?? svc.capacity, i.note ?? ''],
    );
    await insertOccurrenceAllocations(tx, businessId, ins.rows[0].id, i.staffId, resIds, occ);
    await audit(tx, businessId, actor, 'occurrence.create', 'occurrence', ins.rows[0].id, { start: new Date(i.start).toISOString() });
    return ins.rows[0].id;
  });
}

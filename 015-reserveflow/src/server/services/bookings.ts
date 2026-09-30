import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { lockBusiness, withTx, type Queryable } from '../db/pool.js';
import { checkOccurrence, checkSlot, listSlots } from '../engine/availability.js';
import { addDays, localDateOf } from '../engine/time.js';
import type { CheckMode, Reason, Slot, SlotOk } from '../engine/types.js';
import { refCode } from '../lib/crypto.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { normEmail, normName, normPhone } from '../lib/normalize.js';
import { audit, type Actor } from './audit.js';
import { loadEngine, type BusinessRow } from './loader.js';
import { cancelPendingForBooking, enqueue, enqueueReminder, ownerRecipient } from './notifications.js';
import { issueManageToken } from './tokens.js';
import { findWaitlistMatches } from './waitlist.js';

export type BookingStatus = 'confirmed' | 'checked_in' | 'completed' | 'cancelled_by_customer' | 'cancelled_by_business' | 'no_show' | 'rescheduled';
export type BookingSource = 'public' | 'phone' | 'walk_in' | 'dm' | 'email' | 'admin' | 'other';

export interface CustomerInput {
  name: string;
  email?: string | null;
  phone?: string | null;
}

export interface AnswerInput {
  questionId: string;
  value: string | string[] | boolean | null;
}

export interface CreateBookingInput {
  businessId: string;
  serviceId: string;
  staffId: string | null;
  start?: number;
  occurrenceId?: string | null;
  partySize: number;
  customer?: CustomerInput;
  customerId?: string;
  answers?: AnswerInput[];
  customerNote?: string;
  staffNote?: string;
  source: BookingSource;
  mode: CheckMode;
  forcedReason?: string;
  idempotencyKey?: string | null;
  actor: Actor;
  now?: number;
  /** issue a manage token and return it (public flow) */
  issueToken?: boolean;
  /** staff-entered bookings (phone etc.) may leave required questions unanswered */
  relaxRequiredAnswers?: boolean;
}

export interface CreatedBooking {
  bookingId: string;
  refCode: string;
  start: Date;
  end: Date;
  staffId: string | null;
  manageToken: string | null;
  replayed: boolean;
}

const PG_EXCLUSION = '23P01';
const PG_UNIQUE = '23505';

function slotUnavailable(reasons: Reason[], alternatives: Slot[] = []): AppError {
  return conflict('SLOT_UNAVAILABLE', 'この時間はすでに埋まったか、予約できなくなりました。別の時間を選んでください。', {
    reasons,
    alternatives: alternatives.map((a) => ({ start: new Date(a.start).toISOString(), end: new Date(a.end).toISOString(), occurrenceId: a.occurrenceId })),
  });
}

/** Suggest a few alternative slots after a conflict (outside the failed transaction). */
export async function suggestAlternatives(q: Queryable, businessId: string, serviceId: string, staffId: string | null, from: number, partySize: number, mode: 'public' | 'admin'): Promise<Slot[]> {
  try {
    const { ctx } = await loadEngine(q, businessId, localDateOf(from, 'UTC'), addDays(localDateOf(from, 'UTC'), 7));
    const tz = ctx.timezone;
    const d = localDateOf(from, tz);
    return listSlots(ctx, { serviceId, staffId, fromDate: d, toDate: addDays(d, 7), partySize, now: Date.now(), mode, limit: 6 });
  } catch {
    return [];
  }
}

function mapDbConflict(e: unknown): never {
  const err = e as { code?: string; constraint?: string };
  if (err.code === PG_EXCLUSION) throw slotUnavailable([{ code: 'STAFF_BUSY', message: 'スタッフに別の予約があります' }]);
  throw e;
}

// ---------------------------------------------------------------------------
// questions / answers snapshot

interface QuestionRow {
  id: string;
  type: 'short_text' | 'long_text' | 'single_choice' | 'multi_choice' | 'yes_no' | 'confirm';
  label: string;
  help_text: string;
  required: boolean;
  options: Array<{ id: string; label: string }>;
}

export async function questionsFor(q: Queryable, businessId: string, serviceId: string): Promise<QuestionRow[]> {
  const r = await q.query<QuestionRow>(
    `SELECT id, type, label, help_text, required, options FROM questions
      WHERE business_id = $1 AND archived_at IS NULL AND (service_id IS NULL OR service_id = $2)
      ORDER BY sort_order, created_at`,
    [businessId, serviceId],
  );
  return r.rows;
}

/**
 * Validate answers and build an immutable snapshot (question label/options copied at booking time),
 * so later edits of the question never change the meaning of past answers.
 */
export function buildAnswerSnapshot(questions: QuestionRow[], answers: AnswerInput[], relaxRequired = false): Array<Record<string, unknown>> {
  const byId = new Map(answers.map((a) => [a.questionId, a.value]));
  const errors: Record<string, string> = {};
  const snap: Array<Record<string, unknown>> = [];
  for (const qn of questions) {
    const raw = byId.get(qn.id);
    let value: unknown = null;
    let display = '';
    switch (qn.type) {
      case 'short_text':
      case 'long_text': {
        const s = typeof raw === 'string' ? raw.trim() : '';
        const max = qn.type === 'short_text' ? 200 : 2000;
        if (s.length > max) errors[qn.id] = `${max}文字以内で入力してください`;
        value = s || null;
        display = s;
        break;
      }
      case 'single_choice': {
        const opt = qn.options.find((o) => o.id === raw);
        if (raw && !opt) errors[qn.id] = '選択肢が正しくありません';
        value = opt?.id ?? null;
        display = opt?.label ?? '';
        break;
      }
      case 'multi_choice': {
        const arr = Array.isArray(raw) ? raw : [];
        const opts = qn.options.filter((o) => arr.includes(o.id));
        if (opts.length !== arr.length) errors[qn.id] = '選択肢が正しくありません';
        value = opts.length ? opts.map((o) => o.id) : null;
        display = opts.map((o) => o.label).join('、');
        break;
      }
      case 'yes_no': {
        value = raw === true || raw === 'yes' ? true : raw === false || raw === 'no' ? false : null;
        display = value === true ? 'はい' : value === false ? 'いいえ' : '';
        break;
      }
      case 'confirm': {
        value = raw === true ? true : null;
        display = value ? '確認しました' : '';
        break;
      }
    }
    if (qn.required && !relaxRequired && (value === null || value === '')) errors[qn.id] = qn.type === 'confirm' ? '確認のチェックが必要です' : '回答してください';
    snap.push({ questionId: qn.id, type: qn.type, label: qn.label, options: qn.options, value, display });
  }
  if (Object.keys(errors).length) throw badRequest('事前質問の回答を確認してください', { fieldErrors: errors });
  return snap;
}

// ---------------------------------------------------------------------------
// customers

async function nextCustomerNo(tx: Queryable, businessId: string): Promise<number> {
  const r = await tx.query(`SELECT COALESCE(MAX(customer_no), 0) + 1 AS n FROM customers WHERE business_id = $1`, [businessId]);
  return r.rows[0].n;
}

/**
 * Attach to an existing customer only on an exact (normalized) name + email match,
 * or name + phone when there is no email. Anything else creates a new record —
 * possible duplicates are shown as candidates in the ledger but never merged automatically.
 * Must be called while holding the business lock.
 */
export async function findOrCreateCustomer(tx: Queryable, businessId: string, c: CustomerInput): Promise<string> {
  const name = c.name.trim();
  const email = normEmail(c.email);
  const phone = normPhone(c.phone);
  const nn = normName(name);
  if (email) {
    const r = await tx.query(`SELECT id FROM customers WHERE business_id = $1 AND email_normalized = $2 AND name_normalized = $3 AND anonymized_at IS NULL ORDER BY created_at LIMIT 1`, [businessId, email, nn]);
    if (r.rows[0]) {
      if (c.phone) await tx.query(`UPDATE customers SET phone = $2, phone_normalized = $3, archived_at = NULL, updated_at = now() WHERE id = $1`, [r.rows[0].id, c.phone.trim(), phone]);
      return r.rows[0].id;
    }
  } else if (phone) {
    const r = await tx.query(`SELECT id FROM customers WHERE business_id = $1 AND phone_normalized = $2 AND name_normalized = $3 AND email_normalized IS NULL AND anonymized_at IS NULL ORDER BY created_at LIMIT 1`, [businessId, phone, nn]);
    if (r.rows[0]) return r.rows[0].id;
  }
  const no = await nextCustomerNo(tx, businessId);
  const r = await tx.query(
    `INSERT INTO customers (business_id, customer_no, name, name_normalized, email, email_normalized, phone, phone_normalized)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [businessId, no, name, nn, c.email?.trim() || null, email, c.phone?.trim() || null, phone],
  );
  return r.rows[0].id;
}

export async function createCustomerRecord(tx: Queryable, businessId: string, c: CustomerInput & { adminNote?: string; tags?: string[] }): Promise<string> {
  const no = await nextCustomerNo(tx, businessId);
  const r = await tx.query(
    `INSERT INTO customers (business_id, customer_no, name, name_normalized, email, email_normalized, phone, phone_normalized, admin_note, tags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [businessId, no, c.name.trim(), normName(c.name), c.email?.trim() || null, normEmail(c.email), c.phone?.trim() || null, normPhone(c.phone), c.adminNote ?? '', c.tags ?? []],
  );
  return r.rows[0].id;
}

// ---------------------------------------------------------------------------
// create

async function serviceSnapshot(tx: Queryable, serviceId: string) {
  const r = await tx.query(`SELECT id, name, duration_min, buffer_before_min, buffer_after_min, price_text, category FROM services WHERE id = $1`, [serviceId]);
  const s = r.rows[0];
  return { id: s.id, name: s.name, durationMin: s.duration_min, bufferBeforeMin: s.buffer_before_min, bufferAfterMin: s.buffer_after_min, priceText: s.price_text, category: s.category };
}

async function insertAllocations(tx: Queryable, businessId: string, bookingId: string, res: SlotOk, sessionKey: string): Promise<void> {
  if (res.occurrenceId) return; // the occurrence holds staff/resources
  const range = `[${new Date(res.occupiedStart).toISOString()},${new Date(res.occupiedEnd).toISOString()})`;
  if (res.staffId)
    await tx.query(`INSERT INTO allocations (business_id, booking_id, kind, target_id, occupied, session_key) VALUES ($1,$2,'staff',$3,$4::tstzrange,$5)`, [businessId, bookingId, res.staffId, range, sessionKey]);
  for (const rid of res.resourceIds)
    await tx.query(`INSERT INTO allocations (business_id, booking_id, kind, target_id, occupied, session_key) VALUES ($1,$2,'resource',$3,$4::tstzrange,$5)`, [businessId, bookingId, rid, range, sessionKey]);
}

export async function recordStatus(tx: Queryable, businessId: string, bookingId: string, from: string | null, to: string, actor: Actor, reason?: string | null): Promise<void> {
  await tx.query(`INSERT INTO booking_status_history (business_id, booking_id, from_status, to_status, actor_type, actor_user_id, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
    businessId,
    bookingId,
    from,
    to,
    actor.type,
    actor.userId ?? null,
    reason ?? null,
  ]);
}

function validateSlotRequest(business: BusinessRow, i: CreateBookingInput, now: number): void {
  if (i.mode === 'force' && !(i.forcedReason && i.forcedReason.trim())) throw badRequest('強制予約には理由の入力が必要です');
  if (i.mode === 'admin' && i.start !== undefined && i.start < now - 30 * 60_000) throw badRequest('30分以上前の時刻には通常予約を作成できません（強制予約を利用してください）');
  void business;
}

export async function createBooking(pool: pg.Pool, i: CreateBookingInput): Promise<CreatedBooking> {
  const now = i.now ?? Date.now();
  try {
    return await withTx(pool, async (tx) => {
      await lockBusiness(tx, i.businessId);

      if (i.idempotencyKey) {
        const ex = await tx.query(`SELECT id, ref_code, start_at, end_at, staff_id FROM bookings WHERE business_id = $1 AND idempotency_key = $2`, [i.businessId, i.idempotencyKey]);
        if (ex.rows[0]) {
          const b = ex.rows[0];
          const token = i.issueToken ? await issueManageToken(tx, i.businessId, b.id, b.end_at) : null;
          return { bookingId: b.id, refCode: b.ref_code, start: b.start_at, end: b.end_at, staffId: b.staff_id, manageToken: token, replayed: true };
        }
      }

      // re-validate against the latest committed state (we hold the business lock)
      let res;
      let business: BusinessRow;
      if (i.occurrenceId) {
        const o = await tx.query(`SELECT local_date, service_id FROM session_occurrences WHERE id = $1 AND business_id = $2`, [i.occurrenceId, i.businessId]);
        if (!o.rows[0] || o.rows[0].service_id !== i.serviceId) throw notFound('開催回');
        const loaded = await loadEngine(tx, i.businessId, o.rows[0].local_date, o.rows[0].local_date);
        business = loaded.business;
        res = checkOccurrence(loaded.ctx, { occurrenceId: i.occurrenceId, partySize: i.partySize, now, mode: i.mode });
      } else {
        if (i.start === undefined || !Number.isFinite(i.start)) throw badRequest('開始日時が必要です');
        const loaded = await loadEngine(tx, i.businessId, localDateOf(i.start, 'UTC'), localDateOf(i.start, 'UTC'));
        business = loaded.business;
        validateSlotRequest(business, i, now);
        res = checkSlot(loaded.ctx, { serviceId: i.serviceId, staffId: i.staffId, start: i.start, partySize: i.partySize, now, mode: i.mode });
      }
      if (!res.ok) throw slotUnavailable(res.reasons);

      const answers = buildAnswerSnapshot(await questionsFor(tx, i.businessId, i.serviceId), i.answers ?? [], i.relaxRequiredAnswers ?? false);
      let customerId = i.customerId;
      if (customerId) {
        const c = await tx.query(`SELECT id FROM customers WHERE id = $1 AND business_id = $2 AND anonymized_at IS NULL`, [customerId, i.businessId]);
        if (!c.rows[0]) throw notFound('顧客');
      } else {
        if (!i.customer?.name?.trim()) throw badRequest('お名前を入力してください');
        customerId = await findOrCreateCustomer(tx, i.businessId, i.customer);
      }

      const id = randomUUID();
      const sessionKey = res.sessionKey ?? `b:${id}`;
      const snapshot = await serviceSnapshot(tx, i.serviceId);
      const code = refCode();
      await tx.query(
        `INSERT INTO bookings (id, business_id, ref_code, customer_id, service_id, staff_id, occurrence_id, session_key, start_at, end_at,
                               occupied_start, occupied_end, party_size, status, source, service_snapshot, answers, customer_note, staff_note,
                               resource_ids, forced, forced_reason, idempotency_key, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'confirmed',$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
        [
          id, i.businessId, code, customerId, i.serviceId, res.staffId, res.occurrenceId, sessionKey,
          new Date(res.start), new Date(res.end), new Date(res.occupiedStart), new Date(res.occupiedEnd), i.partySize, i.source,
          JSON.stringify(snapshot), JSON.stringify(answers), (i.customerNote ?? '').slice(0, 2000), (i.staffNote ?? '').slice(0, 2000),
          res.resourceIds, i.mode === 'force', i.mode === 'force' ? i.forcedReason : null, i.idempotencyKey ?? null, i.actor.userId ?? null,
        ],
      );
      try {
        await insertAllocations(tx, i.businessId, id, res, sessionKey);
      } catch (e) {
        mapDbConflict(e);
      }
      await recordStatus(tx, i.businessId, id, null, 'confirmed', i.actor, i.mode === 'force' ? `強制予約: ${i.forcedReason}` : null);

      const cust = (await tx.query(`SELECT email FROM customers WHERE id = $1`, [customerId])).rows[0];
      const token = i.issueToken ? await issueManageToken(tx, i.businessId, id, new Date(res.end)) : null;
      await enqueue(tx, { businessId: i.businessId, bookingId: id, kind: 'booking_confirmed', recipient: cust.email, dedupeKey: `confirmed:${id}` });
      if (i.source === 'public') await enqueue(tx, { businessId: i.businessId, bookingId: id, kind: 'owner_new_booking', recipient: ownerRecipient(business), dedupeKey: `owner_new:${id}` });
      await enqueueReminder(tx, business, { id, start_at: new Date(res.start) }, cust.email, new Date(now));
      await audit(tx, i.businessId, i.actor, i.mode === 'force' ? 'booking.force_create' : 'booking.create', 'booking', id, {
        ref: code,
        start: new Date(res.start).toISOString(),
        serviceId: i.serviceId,
        staffId: res.staffId,
        partySize: i.partySize,
        source: i.source,
        ...(i.mode === 'force' ? { forcedReason: i.forcedReason } : {}),
      });
      return { bookingId: id, refCode: code, start: new Date(res.start), end: new Date(res.end), staffId: res.staffId, manageToken: token, replayed: false };
    });
  } catch (e) {
    const err = e as { code?: string; constraint?: string };
    if (err.code === PG_UNIQUE && err.constraint === 'bookings_business_id_idempotency_key_key') {
      // concurrent duplicate submit that raced past the lock (should not happen) → replay
      return createBooking(pool, i);
    }
    if (e instanceof AppError && e.code === 'SLOT_UNAVAILABLE') {
      const alt = i.start !== undefined ? await suggestAlternatives(pool, i.businessId, i.serviceId, i.staffId, i.start, i.partySize, i.mode === 'public' ? 'public' : 'admin') : [];
      const details = e.details as { reasons: Reason[] };
      throw slotUnavailable(details.reasons, alt);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// reschedule (atomic: new slot secured before the old one is released; failure keeps the old booking)

export interface RescheduleInput {
  businessId: string;
  bookingId: string;
  start?: number;
  occurrenceId?: string | null;
  staffId?: string | null;
  mode: CheckMode;
  actor: Actor;
  byCustomer: boolean;
  now?: number;
  forcedReason?: string;
}

export async function rescheduleBooking(pool: pg.Pool, i: RescheduleInput): Promise<{ bookingId: string; refCode: string; start: Date }> {
  const now = i.now ?? Date.now();
  try {
    return await withTx(pool, async (tx) => {
      await lockBusiness(tx, i.businessId);
      const cur = (await tx.query(`SELECT * FROM bookings WHERE id = $1 AND business_id = $2 FOR UPDATE`, [i.bookingId, i.businessId])).rows[0];
      if (!cur) throw notFound('予約');
      if (cur.status !== 'confirmed') throw conflict('INVALID_STATUS', 'この予約は変更できない状態です');
      const business = (await loadEngine(tx, i.businessId, localDateOf(cur.start_at.getTime(), 'UTC'), localDateOf(cur.start_at.getTime(), 'UTC'))).business;
      if (i.byCustomer && now > cur.start_at.getTime() - business.change_deadline_min * 60_000)
        throw forbidden(`変更の締切（開始の${Math.round(business.change_deadline_min / 60)}時間前）を過ぎています。お店へ直接ご連絡ください。`);
      if (i.mode === 'force' && !i.forcedReason?.trim()) throw badRequest('強制変更には理由の入力が必要です');

      let res;
      if (i.occurrenceId) {
        const o = await tx.query(`SELECT local_date, service_id FROM session_occurrences WHERE id = $1 AND business_id = $2`, [i.occurrenceId, i.businessId]);
        if (!o.rows[0] || o.rows[0].service_id !== cur.service_id) throw notFound('開催回');
        const { ctx } = await loadEngine(tx, i.businessId, o.rows[0].local_date, o.rows[0].local_date);
        res = checkOccurrence(ctx, { occurrenceId: i.occurrenceId, partySize: cur.party_size, now, mode: i.mode, excludeBookingId: cur.id });
      } else {
        if (i.start === undefined) throw badRequest('変更先の日時が必要です');
        const { ctx } = await loadEngine(tx, i.businessId, localDateOf(i.start, 'UTC'), localDateOf(i.start, 'UTC'));
        const staffId = i.staffId === undefined ? cur.staff_id : i.staffId;
        res = checkSlot(ctx, { serviceId: cur.service_id, staffId, start: i.start, partySize: cur.party_size, now, mode: i.mode, excludeBookingId: cur.id });
      }
      if (!res.ok) throw slotUnavailable(res.reasons);

      // release old occupancy inside the same transaction, then secure the new one
      await tx.query(`UPDATE allocations SET active = false WHERE booking_id = $1`, [cur.id]);
      const id = randomUUID();
      const sessionKey = res.sessionKey ?? `b:${id}`;
      const code = refCode();
      const snapshot = await serviceSnapshot(tx, cur.service_id);
      await tx.query(
        `INSERT INTO bookings (id, business_id, ref_code, customer_id, service_id, staff_id, occurrence_id, session_key, start_at, end_at,
                               occupied_start, occupied_end, party_size, status, source, service_snapshot, answers, customer_note, staff_note,
                               resource_ids, forced, forced_reason, rescheduled_from_id, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'confirmed',$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
        [
          id, i.businessId, code, cur.customer_id, cur.service_id, res.staffId, res.occurrenceId, sessionKey,
          new Date(res.start), new Date(res.end), new Date(res.occupiedStart), new Date(res.occupiedEnd), cur.party_size, cur.source,
          JSON.stringify(snapshot), JSON.stringify(cur.answers), cur.customer_note, cur.staff_note, res.resourceIds,
          i.mode === 'force', i.mode === 'force' ? i.forcedReason : null, cur.id, i.actor.userId ?? null,
        ],
      );
      try {
        await insertAllocations(tx, i.businessId, id, res, sessionKey);
      } catch (e) {
        mapDbConflict(e);
      }
      await tx.query(`UPDATE bookings SET status = 'rescheduled', rescheduled_to_id = $2, updated_at = now() WHERE id = $1`, [cur.id, id]);
      await recordStatus(tx, i.businessId, cur.id, 'confirmed', 'rescheduled', i.actor, `変更先: ${code}`);
      await recordStatus(tx, i.businessId, id, null, 'confirmed', i.actor, `変更元: ${cur.ref_code}`);
      // keep the customer's manage link working: move tokens to the new booking
      await tx.query(`UPDATE manage_tokens SET booking_id = $2, expires_at = GREATEST(expires_at, $3::timestamptz + interval '30 days') WHERE booking_id = $1 AND revoked_at IS NULL`, [cur.id, id, new Date(res.end)]);
      await cancelPendingForBooking(tx, cur.id, ['reminder', 'booking_confirmed']);
      const cust = (await tx.query(`SELECT email FROM customers WHERE id = $1`, [cur.customer_id])).rows[0];
      await enqueue(tx, { businessId: i.businessId, bookingId: id, kind: 'booking_changed', recipient: cust.email, dedupeKey: `changed:${id}` });
      if (i.byCustomer) await enqueue(tx, { businessId: i.businessId, bookingId: id, kind: 'owner_booking_changed', recipient: ownerRecipient(business), dedupeKey: `owner_changed:${id}` });
      await enqueueReminder(tx, business, { id, start_at: new Date(res.start) }, cust.email, new Date(now));
      await audit(tx, i.businessId, i.actor, 'booking.reschedule', 'booking', id, {
        from: cur.id,
        fromRef: cur.ref_code,
        ref: code,
        oldStart: cur.start_at.toISOString(),
        newStart: new Date(res.start).toISOString(),
        byCustomer: i.byCustomer,
        forced: i.mode === 'force',
      });
      return { bookingId: id, refCode: code, start: new Date(res.start) };
    });
  } catch (e) {
    if (e instanceof AppError && e.code === 'SLOT_UNAVAILABLE' && i.start !== undefined) {
      const cur = (await pool.query(`SELECT service_id, staff_id, party_size FROM bookings WHERE id = $1`, [i.bookingId])).rows[0];
      const alt = cur ? await suggestAlternatives(pool, i.businessId, cur.service_id, i.staffId ?? cur.staff_id, i.start, cur.party_size, i.byCustomer ? 'public' : 'admin') : [];
      throw slotUnavailable((e.details as { reasons: Reason[] }).reasons, alt);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// cancel

export async function cancelBooking(
  pool: pg.Pool,
  i: { businessId: string; bookingId: string; by: 'customer' | 'business'; reason?: string | null; actor: Actor; now?: number; notifyCustomer?: boolean; ignoreDeadline?: boolean },
): Promise<{ waitlistMatches: number }> {
  const now = i.now ?? Date.now();
  return withTx(pool, async (tx) => {
    await lockBusiness(tx, i.businessId);
    const cur = (await tx.query(`SELECT * FROM bookings WHERE id = $1 AND business_id = $2 FOR UPDATE`, [i.bookingId, i.businessId])).rows[0];
    if (!cur) throw notFound('予約');
    if (cur.status !== 'confirmed' && !(i.by === 'business' && cur.status === 'checked_in')) throw conflict('INVALID_STATUS', 'この予約はキャンセルできない状態です');
    const business = (await tx.query(`SELECT * FROM businesses WHERE id = $1`, [i.businessId])).rows[0] as BusinessRow;
    if (i.by === 'customer' && !i.ignoreDeadline && now > cur.start_at.getTime() - business.cancel_deadline_min * 60_000)
      throw forbidden(`キャンセルの締切（開始の${Math.round(business.cancel_deadline_min / 60)}時間前）を過ぎています。お店へ直接ご連絡ください。`);
    const to = i.by === 'customer' ? 'cancelled_by_customer' : 'cancelled_by_business';
    await tx.query(`UPDATE bookings SET status = $2, cancel_reason = $3, updated_at = now() WHERE id = $1`, [cur.id, to, (i.reason ?? '').slice(0, 500) || null]);
    await tx.query(`UPDATE allocations SET active = false WHERE booking_id = $1`, [cur.id]);
    await recordStatus(tx, i.businessId, cur.id, cur.status, to, i.actor, i.reason ?? null);
    await cancelPendingForBooking(tx, cur.id, ['reminder', 'booking_confirmed', 'booking_changed']);
    const cust = (await tx.query(`SELECT email FROM customers WHERE id = $1`, [cur.customer_id])).rows[0];
    if (i.notifyCustomer !== false) await enqueue(tx, { businessId: i.businessId, bookingId: cur.id, kind: 'booking_cancelled', recipient: cust.email, dedupeKey: `cancelled:${cur.id}` });
    if (i.by === 'customer') await enqueue(tx, { businessId: i.businessId, bookingId: cur.id, kind: 'owner_booking_cancelled', recipient: ownerRecipient(business), dedupeKey: `owner_cancelled:${cur.id}` });
    const matches = await findWaitlistMatches(tx, i.businessId, { serviceId: cur.service_id, staffId: cur.staff_id, start: cur.start_at, partySize: cur.party_size, timezone: business.timezone });
    if (matches.length) {
      await tx.query(`UPDATE waitlist_entries SET last_match_at = now() WHERE id = ANY($1)`, [matches.map((m) => m.id)]);
      await enqueue(tx, {
        businessId: i.businessId,
        bookingId: cur.id,
        kind: 'waitlist_opening',
        recipient: business.owner_notify_email || business.email,
        dedupeKey: `waitlist:${cur.id}`,
        payload: { count: matches.length, start: cur.start_at.toISOString() },
      });
    }
    await audit(tx, i.businessId, i.actor, 'booking.cancel', 'booking', cur.id, { ref: cur.ref_code, by: i.by, start: cur.start_at.toISOString(), waitlistMatches: matches.length });
    return { waitlistMatches: matches.length };
  });
}

// ---------------------------------------------------------------------------
// reception status changes

const TRANSITIONS: Record<string, string[]> = {
  confirmed: ['checked_in', 'completed', 'no_show'],
  checked_in: ['completed', 'confirmed'],
  completed: ['checked_in'],
  no_show: ['confirmed'],
};

export async function changeStatus(
  pool: pg.Pool,
  i: { businessId: string; bookingId: string; to: 'checked_in' | 'completed' | 'no_show' | 'confirmed'; actor: Actor; note?: string | null; now?: number; allowedStaffId?: string | null },
): Promise<void> {
  const now = i.now ?? Date.now();
  await withTx(pool, async (tx) => {
    const cur = (await tx.query(`SELECT id, status, start_at, staff_id, ref_code FROM bookings WHERE id = $1 AND business_id = $2 FOR UPDATE`, [i.bookingId, i.businessId])).rows[0];
    if (!cur) throw notFound('予約');
    if (i.allowedStaffId !== undefined && i.allowedStaffId !== null && cur.staff_id !== i.allowedStaffId) throw forbidden('担当外の予約は操作できません');
    if (!(TRANSITIONS[cur.status] ?? []).includes(i.to)) throw conflict('INVALID_STATUS', `「${cur.status}」から「${i.to}」へは変更できません`);
    if (i.to === 'no_show' && now < cur.start_at.getTime()) throw badRequest('無断欠席は開始時刻を過ぎてから記録できます');
    await tx.query(`UPDATE bookings SET status = $2, updated_at = now() WHERE id = $1`, [cur.id, i.to]);
    await recordStatus(tx, i.businessId, cur.id, cur.status, i.to, i.actor, i.note ?? null);
    if (i.to !== 'confirmed') await cancelPendingForBooking(tx, cur.id, ['reminder']);
    await audit(tx, i.businessId, i.actor, 'booking.status', 'booking', cur.id, { ref: cur.ref_code, from: cur.status, to: i.to });
  });
}

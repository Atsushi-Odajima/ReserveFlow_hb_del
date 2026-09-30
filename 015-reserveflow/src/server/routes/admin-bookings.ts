import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { lockBusiness, withTx } from '../db/pool.js';
import { checkOccurrence, checkSlot, listSlots } from '../engine/availability.js';
import { addDays, dayRange, diffDays, localDateOf } from '../engine/time.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { normEmail, normName, normPhone } from '../lib/normalize.js';
import { audit } from '../services/audit.js';
import { cancelBooking, changeStatus, createBooking, createCustomerRecord, rescheduleBooking } from '../services/bookings.js';
import { getBusiness, loadEngine, ACTIVE_STATUSES } from '../services/loader.js';
import { enqueue } from '../services/notifications.js';
import { cancelOccurrence, createOccurrence, createRule, updateOccurrence, updateRule } from '../services/recurrence.js';
import { issueManageToken, manageUrl, revokeManageTokens } from '../services/tokens.js';
import { parse, requireMember, requireOwner, zDate, type AppDeps, type Scoped } from '../http.js';

const zSource = z.enum(['phone', 'walk_in', 'dm', 'email', 'admin', 'other']);

function staffScope(a: Scoped): string | null {
  return a.role === 'owner' || a.perms.viewAllBookings ? null : a.staffId ?? '00000000-0000-0000-0000-000000000000';
}

function requireManage(a: Scoped): void {
  if (a.role !== 'owner' && !a.perms.manageBookings) throw forbidden('予約の作成・変更・キャンセル権限がありません');
}

const BOOKING_SELECT = `
  SELECT b.id, b.ref_code AS "refCode", b.status, b.start_at AS start, b.end_at AS end, b.occupied_start AS "occupiedStart", b.occupied_end AS "occupiedEnd",
         b.party_size AS "partySize", b.source, b.service_id AS "serviceId", b.service_snapshot->>'name' AS "serviceName", b.staff_id AS "staffId",
         st.display_name AS "staffName", st.color AS "staffColor", b.customer_id AS "customerId", c.name AS "customerName", c.phone AS "customerPhone",
         c.customer_no AS "customerNo", b.occurrence_id AS "occurrenceId", b.forced, b.customer_note AS "customerNote", b.staff_note AS "staffNote",
         b.resource_ids AS "resourceIds", b.created_at AS "createdAt"
    FROM bookings b JOIN customers c ON c.id = b.customer_id LEFT JOIN staff st ON st.id = b.staff_id`;

export function registerAdminBookingRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { pool } = deps;

  // ---------------------------------------------------------------- availability search (空き検索) & slot listing
  app.get('/api/admin/availability', async (req) => {
    const a = await requireMember(deps, req);
    const q = parse(
      z.object({
        serviceId: z.string().uuid(),
        staffId: z.string().uuid().optional(),
        from: zDate,
        to: zDate,
        partySize: z.coerce.number().int().min(1).max(500).default(1),
        timeFromMin: z.coerce.number().int().min(0).max(1440).optional(),
        timeToMin: z.coerce.number().int().min(0).max(1440).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
        excludeBookingId: z.string().uuid().optional(),
      }),
      req.query,
    );
    if (diffDays(q.from, q.to) > 62 || q.to < q.from) throw badRequest('期間は62日以内で指定してください');
    const { ctx } = await loadEngine(pool, a.businessId, q.from, q.to);
    const staffName = new Map(ctx.input.staff.map((s) => [s.id, s.displayName]));
    const slots = listSlots(ctx, {
      serviceId: q.serviceId,
      staffId: q.staffId ?? null,
      fromDate: q.from,
      toDate: q.to,
      partySize: q.partySize,
      now: Date.now(),
      mode: 'admin',
      timeFromMin: q.timeFromMin,
      timeToMin: q.timeToMin,
      limit: q.limit,
      excludeBookingId: q.excludeBookingId,
    }).filter((s) => s.start >= Date.now() - 30 * 60_000);
    return {
      timezone: ctx.timezone,
      slots: slots.map((s) => ({
        start: new Date(s.start).toISOString(),
        end: new Date(s.end).toISOString(),
        date: localDateOf(s.start, ctx.timezone),
        staff: s.staffIds.map((id) => ({ id, name: staffName.get(id) })),
        remaining: s.remaining,
        occurrenceId: s.occurrenceId,
      })),
    };
  });

  /** Explain why a specific time is (not) bookable — used by the manual booking form. */
  app.post('/api/admin/availability/check', async (req) => {
    const a = await requireMember(deps, req);
    const b = parse(
      z.object({
        serviceId: z.string().uuid(),
        staffId: z.string().uuid().nullable(),
        start: z.string().datetime().optional(),
        occurrenceId: z.string().uuid().optional(),
        partySize: z.number().int().min(1).max(500).default(1),
        mode: z.enum(['admin', 'force']).default('admin'),
        excludeBookingId: z.string().uuid().optional(),
      }),
      req.body,
    );
    const start = b.start ? Date.parse(b.start) : Date.now();
    const d = localDateOf(start, 'UTC');
    const { ctx } = await loadEngine(pool, a.businessId, d, d);
    const r = b.occurrenceId
      ? checkOccurrence(ctx, { occurrenceId: b.occurrenceId, partySize: b.partySize, now: Date.now(), mode: b.mode, excludeBookingId: b.excludeBookingId })
      : checkSlot(ctx, { serviceId: b.serviceId, staffId: b.staffId, start, partySize: b.partySize, now: Date.now(), mode: b.mode, excludeBookingId: b.excludeBookingId });
    return r.ok ? { ok: true, staffId: r.staffId, remainingAfter: r.remainingAfter } : { ok: false, reasons: r.reasons };
  });

  // ---------------------------------------------------------------- bookings
  app.get('/api/admin/bookings', async (req) => {
    const a = await requireMember(deps, req);
    const q = parse(
      z.object({
        from: zDate.optional(),
        to: zDate.optional(),
        status: z.string().max(200).optional(),
        staffId: z.string().uuid().optional(),
        serviceId: z.string().uuid().optional(),
        customerId: z.string().uuid().optional(),
        q: z.string().max(100).optional(),
        page: z.coerce.number().int().min(1).max(10000).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
        order: z.enum(['asc', 'desc']).default('asc'),
      }),
      req.query,
    );
    const biz = await getBusiness(pool, a.businessId);
    const where = ['b.business_id = $1'];
    const args: unknown[] = [a.businessId];
    const add = (sql: string, v: unknown) => {
      args.push(v);
      where.push(sql.replace('?', `$${args.length}`));
    };
    if (q.from) add('b.start_at >= ?', new Date(dayRange(q.from, biz.timezone).start));
    if (q.to) add('b.start_at < ?', new Date(dayRange(q.to, biz.timezone).end));
    if (q.status) add('b.status = ANY(?)', q.status.split(','));
    if (q.staffId) add('b.staff_id = ?', q.staffId);
    if (q.serviceId) add('b.service_id = ?', q.serviceId);
    if (q.customerId) add('b.customer_id = ?', q.customerId);
    const scope = staffScope(a);
    if (scope) add('b.staff_id = ?', scope);
    if (q.q) {
      args.push(`%${q.q.replace(/[%_\\]/g, (m) => '\\' + m)}%`);
      where.push(`(c.name ILIKE $${args.length} OR b.ref_code ILIKE $${args.length} OR c.phone ILIKE $${args.length} OR c.email ILIKE $${args.length})`);
    }
    const total = (await pool.query(`SELECT count(*)::int AS n FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE ${where.join(' AND ')}`, args)).rows[0].n;
    args.push(q.pageSize, (q.page - 1) * q.pageSize);
    const r = await pool.query(`${BOOKING_SELECT} WHERE ${where.join(' AND ')} ORDER BY b.start_at ${q.order} LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
    return { total, page: q.page, pageSize: q.pageSize, bookings: r.rows };
  });

  app.get<{ Params: { id: string } }>('/api/admin/bookings/:id', async (req) => {
    const a = await requireMember(deps, req);
    const id = parse(z.string().uuid(), req.params.id);
    const r = await pool.query(
      `${BOOKING_SELECT.replace('b.created_at AS "createdAt"', `b.created_at AS "createdAt", b.answers, b.service_snapshot AS "serviceSnapshot", b.cancel_reason AS "cancelReason",
         b.forced_reason AS "forcedReason", b.rescheduled_from_id AS "rescheduledFromId", b.rescheduled_to_id AS "rescheduledToId", c.email AS "customerEmail", c.admin_note AS "customerAdminNote"`)}
       WHERE b.id = $1 AND b.business_id = $2`,
      [id, a.businessId],
    );
    const b = r.rows[0];
    if (!b) throw notFound('予約');
    const scope = staffScope(a);
    if (scope && b.staffId !== scope) throw forbidden('担当外の予約は閲覧できません');
    if (a.role !== 'owner' && !a.perms.viewCustomers) {
      b.customerEmail = null;
      b.customerPhone = null;
      b.customerAdminNote = null;
    }
    const history = await pool.query(
      `SELECT h.from_status AS "from", h.to_status AS "to", h.actor_type AS "actorType", u.name AS "actorName", h.reason, h.at
         FROM booking_status_history h LEFT JOIN users u ON u.id = h.actor_user_id WHERE h.booking_id = $1 ORDER BY h.at, h.id`,
      [id],
    );
    const notifications = await pool.query(
      `SELECT id, kind, status, scheduled_at AS "scheduledAt", sent_at AS "sentAt", attempts, last_error AS "lastError" FROM notifications WHERE booking_id = $1 ORDER BY created_at`,
      [id],
    );
    const resources = b.resourceIds.length ? (await pool.query(`SELECT id, name FROM resources WHERE id = ANY($1)`, [b.resourceIds])).rows : [];
    return { booking: { ...b, resources }, history: history.rows, notifications: notifications.rows };
  });

  app.post('/api/admin/bookings', async (req) => {
    const a = await requireMember(deps, req);
    requireManage(a);
    const body = parse(
      z.object({
        serviceId: z.string().uuid(),
        staffId: z.string().uuid().nullable().default(null),
        start: z.string().datetime().optional(),
        occurrenceId: z.string().uuid().nullable().optional(),
        partySize: z.number().int().min(1).max(500).default(1),
        customerId: z.string().uuid().optional(),
        customer: z.object({ name: z.string().trim().min(1).max(100), email: z.string().trim().email().max(200).nullable().optional().or(z.literal('').transform(() => null)), phone: z.string().trim().max(30).nullable().optional() }).optional(),
        answers: z.array(z.object({ questionId: z.string().uuid(), value: z.any() })).max(50).default([]),
        customerNote: z.string().max(2000).default(''),
        staffNote: z.string().max(2000).default(''),
        source: zSource.default('phone'),
        force: z.boolean().default(false),
        forcedReason: z.string().max(300).optional(),
        idempotencyKey: z.string().uuid(),
        skipRequiredAnswers: z.boolean().default(true),
      }),
      req.body,
    );
    if (body.force && a.role !== 'owner') throw forbidden('強制予約はオーナーのみ実行できます');
    const scope = staffScope(a);
    if (scope && body.staffId !== scope) throw forbidden('自分の担当予約のみ作成できます');
    if (!body.customerId && !body.customer) throw badRequest('顧客を選択または入力してください');
    const created = await createBooking(pool, {
      businessId: a.businessId,
      serviceId: body.serviceId,
      staffId: body.staffId,
      start: body.start ? Date.parse(body.start) : undefined,
      occurrenceId: body.occurrenceId ?? null,
      partySize: body.partySize,
      customerId: body.customerId,
      customer: body.customer ? { name: body.customer.name, email: body.customer.email ?? null, phone: body.customer.phone ?? null } : undefined,
      answers: body.answers,
      customerNote: body.customerNote,
      staffNote: body.staffNote,
      source: body.source,
      mode: body.force ? 'force' : 'admin',
      forcedReason: body.forcedReason,
      idempotencyKey: body.idempotencyKey,
      actor: a.actor,
      relaxRequiredAnswers: body.skipRequiredAnswers,
    });
    return { id: created.bookingId, refCode: created.refCode, start: created.start.toISOString(), staffId: created.staffId, replayed: created.replayed };
  });

  async function loadScoped(a: Scoped, id: string) {
    const b = (await pool.query(`SELECT id, staff_id, status FROM bookings WHERE id = $1 AND business_id = $2`, [id, a.businessId])).rows[0];
    if (!b) throw notFound('予約');
    const scope = staffScope(a);
    if (scope && b.staff_id !== scope) throw forbidden('担当外の予約は操作できません');
    return b;
  }

  app.post<{ Params: { id: string } }>('/api/admin/bookings/:id/reschedule', async (req) => {
    const a = await requireMember(deps, req);
    requireManage(a);
    const id = parse(z.string().uuid(), req.params.id);
    await loadScoped(a, id);
    const body = parse(
      z.object({ start: z.string().datetime().optional(), occurrenceId: z.string().uuid().optional(), staffId: z.string().uuid().nullable().optional(), force: z.boolean().default(false), forcedReason: z.string().max(300).optional() }),
      req.body,
    );
    if (body.force && a.role !== 'owner') throw forbidden('強制変更はオーナーのみ実行できます');
    const scope = staffScope(a);
    if (scope && body.staffId && body.staffId !== scope) throw forbidden('自分の担当予約のみ変更できます');
    const r = await rescheduleBooking(pool, {
      businessId: a.businessId,
      bookingId: id,
      start: body.start ? Date.parse(body.start) : undefined,
      occurrenceId: body.occurrenceId ?? null,
      staffId: body.staffId,
      mode: body.force ? 'force' : 'admin',
      forcedReason: body.forcedReason,
      actor: a.actor,
      byCustomer: false,
    });
    return { id: r.bookingId, refCode: r.refCode, start: r.start.toISOString() };
  });

  app.post<{ Params: { id: string } }>('/api/admin/bookings/:id/cancel', async (req) => {
    const a = await requireMember(deps, req);
    requireManage(a);
    const id = parse(z.string().uuid(), req.params.id);
    await loadScoped(a, id);
    const body = parse(z.object({ by: z.enum(['customer', 'business']).default('business'), reason: z.string().max(500).optional(), notifyCustomer: z.boolean().default(true) }), req.body);
    // by = "customer": the customer asked by phone/DM. Self-service deadlines do not apply to staff-entered cancellations.
    return cancelBooking(pool, { businessId: a.businessId, bookingId: id, by: body.by, reason: body.reason, actor: a.actor, notifyCustomer: body.notifyCustomer, ignoreDeadline: true });
  });

  app.post<{ Params: { id: string } }>('/api/admin/bookings/:id/status', async (req) => {
    const a = await requireMember(deps, req);
    const id = parse(z.string().uuid(), req.params.id);
    await loadScoped(a, id);
    const body = parse(z.object({ to: z.enum(['checked_in', 'completed', 'no_show', 'confirmed']), note: z.string().max(500).optional() }), req.body);
    await changeStatus(pool, { businessId: a.businessId, bookingId: id, to: body.to, actor: a.actor, note: body.note ?? null });
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>('/api/admin/bookings/:id/notes', async (req) => {
    const a = await requireMember(deps, req);
    const id = parse(z.string().uuid(), req.params.id);
    await loadScoped(a, id);
    const body = parse(z.object({ staffNote: z.string().max(2000) }), req.body);
    await pool.query(`UPDATE bookings SET staff_note = $3, updated_at = now() WHERE id = $1 AND business_id = $2`, [id, a.businessId, body.staffNote]);
    await audit(pool, a.businessId, a.actor, 'booking.note', 'booking', id, { length: body.staffNote.length });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/admin/bookings/:id/manage-link', async (req) => {
    const a = await requireMember(deps, req);
    requireManage(a);
    const id = parse(z.string().uuid(), req.params.id);
    await loadScoped(a, id);
    const body = parse(z.object({ sendEmail: z.boolean().default(true) }), req.body);
    return withTx(pool, async (tx) => {
      const b = (await tx.query(`SELECT b.end_at, c.email FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.id = $1`, [id])).rows[0];
      const revoked = await revokeManageTokens(tx, id);
      let url: string | null = null;
      if (body.sendEmail && b.email) {
        await enqueue(tx, { businessId: a.businessId, bookingId: id, kind: 'manage_link', recipient: b.email, dedupeKey: `manage_link:${id}:${Date.now()}` });
      } else {
        url = manageUrl(deps.cfg.publicBaseUrl, await issueManageToken(tx, a.businessId, id, b.end_at));
      }
      await audit(tx, a.businessId, a.actor, 'booking.manage_link_reissue', 'booking', id, { revoked, emailed: !url });
      return { revoked, emailed: !url, url };
    });
  });

  // ---------------------------------------------------------------- calendar / today
  app.get('/api/admin/calendar', async (req) => {
    const a = await requireMember(deps, req);
    const q = parse(z.object({ from: zDate, to: zDate, staffId: z.string().uuid().optional() }), req.query);
    if (diffDays(q.from, q.to) > 45 || q.to < q.from) throw badRequest('期間は45日以内で指定してください');
    const biz = await getBusiness(pool, a.businessId);
    const from = new Date(dayRange(q.from, biz.timezone).start);
    const to = new Date(dayRange(q.to, biz.timezone).end);
    const scope = staffScope(a);
    const staffFilter = scope ?? q.staffId ?? null;
    const bookings = await pool.query(
      `${BOOKING_SELECT} WHERE b.business_id = $1 AND b.start_at < $3 AND b.end_at > $2 AND b.status <> 'rescheduled' AND ($4::uuid IS NULL OR b.staff_id = $4) ORDER BY b.start_at`,
      [a.businessId, from, to, staffFilter],
    );
    const blocks = await pool.query(
      `SELECT bl.id, bl.scope, bl.target_id AS "targetId", bl.start_at AS start, bl.end_at AS end, bl.reason,
              COALESCE(s.display_name, r.name) AS "targetName"
         FROM blocks bl LEFT JOIN staff s ON bl.scope = 'staff' AND s.id = bl.target_id LEFT JOIN resources r ON bl.scope = 'resource' AND r.id = bl.target_id
        WHERE bl.business_id = $1 AND bl.start_at < $3 AND bl.end_at > $2 AND ($4::uuid IS NULL OR bl.scope <> 'staff' OR bl.target_id = $4) ORDER BY bl.start_at`,
      [a.businessId, from, to, staffFilter],
    );
    const exceptions = await pool.query(`SELECT id, date, kind, label, intervals FROM date_exceptions WHERE business_id = $1 AND date BETWEEN $2 AND $3 ORDER BY date`, [a.businessId, q.from, q.to]);
    const occurrences = await pool.query(
      `SELECT o.id, o.service_id AS "serviceId", sv.name AS "serviceName", o.staff_id AS "staffId", s.display_name AS "staffName", o.start_at AS start, o.end_at AS end,
              o.capacity, o.status, o.note, COALESCE((SELECT sum(party_size) FROM bookings b WHERE b.occurrence_id = o.id AND b.status = ANY($5)), 0)::int AS booked
         FROM session_occurrences o JOIN services sv ON sv.id = o.service_id LEFT JOIN staff s ON s.id = o.staff_id
        WHERE o.business_id = $1 AND o.start_at < $3 AND o.end_at > $2 AND ($4::uuid IS NULL OR o.staff_id = $4) ORDER BY o.start_at`,
      [a.businessId, from, to, staffFilter, ACTIVE_STATUSES],
    );
    const hours = (await pool.query(`SELECT weekday, start_min AS "startMin", end_min AS "endMin" FROM weekly_hours WHERE business_id = $1 AND owner_kind = 'business'`, [a.businessId])).rows;
    return { timezone: biz.timezone, weekStart: biz.week_start, hours, bookings: bookings.rows, blocks: blocks.rows, exceptions: exceptions.rows, occurrences: occurrences.rows };
  });

  app.get('/api/admin/today', async (req) => {
    const a = await requireMember(deps, req);
    const q = parse(z.object({ date: zDate.optional() }), req.query);
    const biz = await getBusiness(pool, a.businessId);
    const date = q.date ?? localDateOf(Date.now(), biz.timezone);
    const r = dayRange(date, biz.timezone);
    const scope = staffScope(a);
    const rows = await pool.query(
      `${BOOKING_SELECT.replace('b.created_at AS "createdAt"', `b.created_at AS "createdAt", b.answers, (SELECT count(*)::int FROM bookings x WHERE x.customer_id = b.customer_id AND x.status = 'completed') AS "completedVisits", (SELECT count(*)::int FROM bookings x WHERE x.customer_id = b.customer_id AND x.status = 'no_show') AS "noShows"`)}
       WHERE b.business_id = $1 AND b.start_at >= $2 AND b.start_at < $3 AND b.status NOT IN ('rescheduled') AND ($4::uuid IS NULL OR b.staff_id = $4)
       ORDER BY b.start_at`,
      [a.businessId, new Date(r.start), new Date(r.end), scope],
    );
    return { date, timezone: biz.timezone, bookings: rows.rows, serviceNotes: (await pool.query(`SELECT id, notes FROM services WHERE business_id = $1 AND notes <> ''`, [a.businessId])).rows };
  });

  // ---------------------------------------------------------------- blocks
  app.get('/api/admin/blocks', async (req) => {
    const a = await requireMember(deps, req);
    const q = parse(z.object({ from: zDate, to: zDate }), req.query);
    const biz = await getBusiness(pool, a.businessId);
    const r = await pool.query(
      `SELECT bl.id, bl.scope, bl.target_id AS "targetId", bl.start_at AS start, bl.end_at AS end, bl.reason, COALESCE(s.display_name, r.name) AS "targetName"
         FROM blocks bl LEFT JOIN staff s ON bl.scope = 'staff' AND s.id = bl.target_id LEFT JOIN resources r ON bl.scope = 'resource' AND r.id = bl.target_id
        WHERE bl.business_id = $1 AND bl.start_at < $3 AND bl.end_at > $2 ORDER BY bl.start_at`,
      [a.businessId, new Date(dayRange(q.from, biz.timezone).start), new Date(dayRange(q.to, biz.timezone).end)],
    );
    return { blocks: r.rows };
  });

  app.post('/api/admin/blocks', async (req) => {
    const a = await requireMember(deps, req);
    const body = parse(
      z.object({ scope: z.enum(['business', 'staff', 'resource']), targetId: z.string().uuid().nullable().default(null), start: z.string().datetime(), end: z.string().datetime(), reason: z.string().max(200).default('') }),
      req.body,
    );
    if (a.role !== 'owner') {
      if (!(a.perms.manageOwnBlocks && body.scope === 'staff' && body.targetId === a.staffId)) throw forbidden('自分の休み/ブロックのみ登録できます');
    }
    const start = new Date(body.start);
    const end = new Date(body.end);
    if (end <= start) throw badRequest('終了は開始より後にしてください');
    if (end.getTime() - start.getTime() > 366 * 86_400_000) throw badRequest('ブロック期間は1年以内にしてください');
    if ((body.scope === 'business') !== (body.targetId === null)) throw badRequest('対象の指定が正しくありません');
    if (body.scope === 'staff') {
      if (!(await pool.query(`SELECT 1 FROM staff WHERE id = $1 AND business_id = $2`, [body.targetId, a.businessId])).rows[0]) throw notFound('スタッフ');
    }
    if (body.scope === 'resource') {
      if (!(await pool.query(`SELECT 1 FROM resources WHERE id = $1 AND business_id = $2`, [body.targetId, a.businessId])).rows[0]) throw notFound('リソース');
    }
    return withTx(pool, async (tx) => {
      await lockBusiness(tx, a.businessId);
      const r = await tx.query(`INSERT INTO blocks (business_id, scope, target_id, start_at, end_at, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [
        a.businessId, body.scope, body.targetId, start, end, body.reason, a.userId,
      ]);
      // existing bookings are NOT cancelled; return them as a warning list
      const overlapping = await tx.query(
        `SELECT DISTINCT b.id, b.ref_code AS "refCode", b.start_at AS start, c.name AS "customerName"
           FROM bookings b JOIN customers c ON c.id = b.customer_id LEFT JOIN allocations al ON al.booking_id = b.id AND al.active
          WHERE b.business_id = $1 AND b.status IN ('confirmed','checked_in') AND b.occupied_start < $3 AND b.occupied_end > $2
            AND ($4 = 'business' OR (al.kind = $4 AND al.target_id = $5) OR ($4 = 'staff' AND b.staff_id = $5))
          ORDER BY b.start_at`,
        [a.businessId, start, end, body.scope, body.targetId],
      );
      await audit(tx, a.businessId, a.actor, 'block.create', 'block', r.rows[0].id, { scope: body.scope, targetId: body.targetId, start: body.start, end: body.end, overlapping: overlapping.rowCount });
      return { id: r.rows[0].id, overlappingBookings: overlapping.rows };
    });
  });

  app.delete<{ Params: { id: string } }>('/api/admin/blocks/:id', async (req) => {
    const a = await requireMember(deps, req);
    const id = parse(z.string().uuid(), req.params.id);
    const bl = (await pool.query(`SELECT scope, target_id FROM blocks WHERE id = $1 AND business_id = $2`, [id, a.businessId])).rows[0];
    if (!bl) throw notFound('ブロック');
    if (a.role !== 'owner' && !(a.perms.manageOwnBlocks && bl.scope === 'staff' && bl.target_id === a.staffId)) throw forbidden();
    await pool.query(`DELETE FROM blocks WHERE id = $1`, [id]);
    await audit(pool, a.businessId, a.actor, 'block.delete', 'block', id, { scope: bl.scope });
    return { ok: true };
  });

  // ---------------------------------------------------------------- customers
  function requireCustomers(a: Scoped) {
    if (a.role !== 'owner' && !a.perms.viewCustomers) throw forbidden('顧客情報の閲覧権限がありません');
  }

  app.get('/api/admin/customers', async (req) => {
    const a = await requireMember(deps, req);
    requireCustomers(a);
    const q = parse(
      z.object({
        q: z.string().max(100).optional(),
        page: z.coerce.number().int().min(1).max(100000).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
        archived: z.enum(['0', '1']).default('0'),
        tag: z.string().max(50).optional(),
      }),
      req.query,
    );
    const args: unknown[] = [a.businessId, q.archived === '1'];
    let where = `c.business_id = $1 AND (c.archived_at IS NOT NULL) = $2`;
    if (q.q) {
      const t = q.q.trim();
      const nn = normName(t);
      const ph = normPhone(t);
      args.push(`${nn.replace(/[%_\\]/g, (m) => '\\' + m)}%`, `%${t.toLowerCase().replace(/[%_\\]/g, (m) => '\\' + m)}%`, ph && ph.length >= 3 ? `%${ph}%` : null, /^\d+$/.test(t) ? Number(t) : null);
      where += ` AND (c.name_normalized LIKE $3 OR c.email_normalized LIKE $4 OR ($5::text IS NOT NULL AND c.phone_normalized LIKE $5) OR ($6::bigint IS NOT NULL AND c.customer_no = $6))`;
    }
    if (q.tag) {
      args.push(q.tag);
      where += ` AND $${args.length} = ANY(c.tags)`;
    }
    const total = (await pool.query(`SELECT count(*)::int AS n FROM customers c WHERE ${where}`, args)).rows[0].n;
    args.push(q.pageSize, (q.page - 1) * q.pageSize);
    const r = await pool.query(
      `SELECT c.id, c.customer_no AS "customerNo", c.name, c.email, c.phone, c.tags, c.archived_at IS NOT NULL AS archived, c.anonymized_at IS NOT NULL AS anonymized,
              st.first_at AS "firstAt", st.last_at AS "lastAt", COALESCE(st.total, 0) AS total
         FROM customers c
         LEFT JOIN LATERAL (SELECT min(start_at) AS first_at, max(start_at) AS last_at, count(*)::int AS total FROM bookings b
                             WHERE b.customer_id = c.id AND b.status <> 'rescheduled') st ON true
        WHERE ${where} ORDER BY c.customer_no DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    );
    return { total, page: q.page, pageSize: q.pageSize, customers: r.rows };
  });

  app.post('/api/admin/customers', async (req) => {
    const a = await requireMember(deps, req);
    requireCustomers(a);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(100),
        email: z.string().trim().email().max(200).nullable().optional().or(z.literal('').transform(() => null)),
        phone: z.string().trim().max(30).nullable().optional(),
        adminNote: z.string().max(4000).default(''),
        tags: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
      }),
      req.body,
    );
    const id = await withTx(pool, async (tx) => {
      await lockBusiness(tx, a.businessId);
      const id = await createCustomerRecord(tx, a.businessId, { name: body.name, email: body.email ?? null, phone: body.phone ?? null, adminNote: body.adminNote, tags: body.tags });
      await audit(tx, a.businessId, a.actor, 'customer.create', 'customer', id, {});
      return id;
    });
    return { id };
  });

  app.get<{ Params: { id: string } }>('/api/admin/customers/:id', async (req) => {
    const a = await requireMember(deps, req);
    requireCustomers(a);
    const id = parse(z.string().uuid(), req.params.id);
    const c = (
      await pool.query(
        `SELECT id, customer_no AS "customerNo", name, email, phone, admin_note AS "adminNote", tags, archived_at IS NOT NULL AS archived,
                anonymized_at AS "anonymizedAt", created_at AS "createdAt", email_normalized, phone_normalized, name_normalized
           FROM customers WHERE id = $1 AND business_id = $2`,
        [id, a.businessId],
      )
    ).rows[0];
    if (!c) throw notFound('顧客');
    // Counts are always derived from the booking history (never stored twice).
    const stats = (
      await pool.query(
        `SELECT count(*) FILTER (WHERE status <> 'rescheduled')::int AS total,
                count(*) FILTER (WHERE status = 'completed')::int AS completed,
                count(*) FILTER (WHERE status = 'cancelled_by_customer')::int AS "cancelledByCustomer",
                count(*) FILTER (WHERE status = 'cancelled_by_business')::int AS "cancelledByBusiness",
                count(*) FILTER (WHERE status = 'no_show')::int AS "noShow",
                count(*) FILTER (WHERE status = 'rescheduled')::int AS rescheduled,
                min(start_at) FILTER (WHERE status <> 'rescheduled') AS "firstAt",
                max(start_at) FILTER (WHERE status IN ('completed','checked_in')) AS "lastVisitAt",
                min(start_at) FILTER (WHERE status = 'confirmed' AND start_at > now()) AS "nextAt"
           FROM bookings WHERE customer_id = $1`,
        [id],
      )
    ).rows[0];
    const scope = staffScope(a);
    const bookings = await pool.query(`${BOOKING_SELECT} WHERE b.customer_id = $1 AND b.business_id = $2 AND ($3::uuid IS NULL OR b.staff_id = $3) ORDER BY b.start_at DESC LIMIT 200`, [id, a.businessId, scope]);
    // duplicate candidates (shown only, never merged automatically)
    const dups = await pool.query(
      `SELECT id, customer_no AS "customerNo", name, email, phone FROM customers
        WHERE business_id = $1 AND id <> $2 AND anonymized_at IS NULL AND (
          ($3::text IS NOT NULL AND email_normalized = $3) OR ($4::text IS NOT NULL AND phone_normalized = $4) OR name_normalized = $5)
        LIMIT 10`,
      [a.businessId, id, c.email_normalized, c.phone_normalized, c.name_normalized],
    );
    delete c.email_normalized;
    delete c.phone_normalized;
    delete c.name_normalized;
    return { customer: c, stats, bookings: bookings.rows, duplicateCandidates: dups.rows };
  });

  app.put<{ Params: { id: string } }>('/api/admin/customers/:id', async (req) => {
    const a = await requireMember(deps, req);
    requireCustomers(a);
    const id = parse(z.string().uuid(), req.params.id);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(100),
        email: z.string().trim().email().max(200).nullable().optional().or(z.literal('').transform(() => null)),
        phone: z.string().trim().max(30).nullable().optional(),
        adminNote: z.string().max(4000).default(''),
        tags: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
      }),
      req.body,
    );
    const r = await pool.query(
      `UPDATE customers SET name=$3, name_normalized=$4, email=$5, email_normalized=$6, phone=$7, phone_normalized=$8, admin_note=$9, tags=$10, updated_at=now()
        WHERE id=$1 AND business_id=$2 AND anonymized_at IS NULL RETURNING id`,
      [id, a.businessId, body.name, normName(body.name), body.email ?? null, normEmail(body.email), body.phone ?? null, normPhone(body.phone), body.adminNote, body.tags],
    );
    if (!r.rows[0]) throw notFound('顧客');
    await audit(pool, a.businessId, a.actor, 'customer.update', 'customer', id, {});
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/admin/customers/:id/archive', async (req) => {
    const a = await requireMember(deps, req);
    requireCustomers(a);
    const id = parse(z.string().uuid(), req.params.id);
    const body = parse(z.object({ archived: z.boolean() }), req.body);
    const r = await pool.query(`UPDATE customers SET archived_at = CASE WHEN $3 THEN now() ELSE NULL END WHERE id = $1 AND business_id = $2 RETURNING id`, [id, a.businessId, body.archived]);
    if (!r.rows[0]) throw notFound('顧客');
    await audit(pool, a.businessId, a.actor, body.archived ? 'customer.archive' : 'customer.unarchive', 'customer', id, {});
    return { ok: true };
  });

  /** Delete request: personal data is anonymized, booking history rows remain for integrity (statistics stay consistent). */
  app.post<{ Params: { id: string } }>('/api/admin/customers/:id/anonymize', async (req) => {
    const a = await requireOwner(deps, req);
    const id = parse(z.string().uuid(), req.params.id);
    const body = parse(z.object({ confirm: z.literal(true) }), req.body);
    void body;
    await withTx(pool, async (tx) => {
      const future = await tx.query(`SELECT count(*)::int AS n FROM bookings WHERE customer_id = $1 AND status = 'confirmed' AND start_at > now()`, [id]);
      if (future.rows[0].n > 0) throw badRequest('今後の予約が残っています。先にキャンセルしてから削除してください。');
      const r = await tx.query(
        `UPDATE customers SET name = '削除済みの顧客', name_normalized = '削除済みの顧客', email = NULL, email_normalized = NULL, phone = NULL, phone_normalized = NULL,
                admin_note = '', tags = '{}', anonymized_at = now(), archived_at = COALESCE(archived_at, now()), updated_at = now()
          WHERE id = $1 AND business_id = $2 AND anonymized_at IS NULL RETURNING customer_no`,
        [id, a.businessId],
      );
      if (!r.rows[0]) throw notFound('顧客');
      await tx.query(`UPDATE bookings SET answers = '[]'::jsonb, customer_note = '', staff_note = '' WHERE customer_id = $1`, [id]);
      await tx.query(`UPDATE waitlist_entries SET name = '削除済み', email = NULL, phone = NULL, note = '', status = 'cancelled' WHERE customer_id = $1`, [id]);
      await tx.query(`UPDATE notifications SET recipient = 'deleted', payload = '{}'::jsonb, status = CASE WHEN status IN ('pending','failed') THEN 'cancelled' ELSE status END WHERE booking_id IN (SELECT id FROM bookings WHERE customer_id = $1)`, [id]);
      await tx.query(`UPDATE manage_tokens SET revoked_at = now() WHERE booking_id IN (SELECT id FROM bookings WHERE customer_id = $1) AND revoked_at IS NULL`, [id]);
      await audit(tx, a.businessId, a.actor, 'customer.delete_anonymize', 'customer', id, { customerNo: r.rows[0].customer_no });
    });
    return { ok: true };
  });

  /** Export one customer's data (for disclosure requests). */
  app.get<{ Params: { id: string } }>('/api/admin/customers/:id/export', async (req, reply) => {
    const a = await requireOwner(deps, req);
    const id = parse(z.string().uuid(), req.params.id);
    const c = (await pool.query(`SELECT customer_no, name, email, phone, admin_note, tags, created_at FROM customers WHERE id = $1 AND business_id = $2`, [id, a.businessId])).rows[0];
    if (!c) throw notFound('顧客');
    const b = await pool.query(
      `SELECT ref_code, status, start_at, end_at, party_size, source, service_snapshot->>'name' AS service, answers, customer_note, created_at FROM bookings WHERE customer_id = $1 ORDER BY start_at`,
      [id],
    );
    const w = await pool.query(`SELECT date_from, date_to, status, created_at FROM waitlist_entries WHERE customer_id = $1`, [id]);
    await audit(pool, a.businessId, a.actor, 'customer.export', 'customer', id, {});
    reply.header('Content-Disposition', `attachment; filename="customer-${c.customer_no}.json"`).header('Cache-Control', 'no-store');
    return { exportedAt: new Date().toISOString(), customer: c, bookings: b.rows, waitlist: w.rows };
  });

  // ---------------------------------------------------------------- waitlist
  app.get('/api/admin/waitlist', async (req) => {
    const a = await requireMember(deps, req);
    requireCustomers(a);
    const q = parse(z.object({ status: z.string().max(100).default('waiting,contacted') }), req.query);
    const r = await pool.query(
      `SELECT w.id, w.name, w.email, w.phone, w.service_id AS "serviceId", s.name AS "serviceName", w.staff_id AS "staffId", st.display_name AS "staffName",
              w.date_from AS "dateFrom", w.date_to AS "dateTo", w.time_from_min AS "timeFromMin", w.time_to_min AS "timeToMin", w.party_size AS "partySize",
              w.note, w.status, w.expires_at AS "expiresAt", w.last_match_at AS "lastMatchAt", w.created_at AS "createdAt", w.customer_id AS "customerId"
         FROM waitlist_entries w JOIN services s ON s.id = w.service_id LEFT JOIN staff st ON st.id = w.staff_id
        WHERE w.business_id = $1 AND w.status = ANY($2) ORDER BY w.last_match_at DESC NULLS LAST, w.created_at`,
      [a.businessId, q.status.split(',')],
    );
    return { entries: r.rows };
  });

  /** Current open slots matching one waitlist entry (candidates only — staff contacts the customer). */
  app.get<{ Params: { id: string } }>('/api/admin/waitlist/:id/candidates', async (req) => {
    const a = await requireMember(deps, req);
    const id = parse(z.string().uuid(), req.params.id);
    const w = (await pool.query(`SELECT * FROM waitlist_entries WHERE id = $1 AND business_id = $2`, [id, a.businessId])).rows[0];
    if (!w) throw notFound('待機');
    const biz = await getBusiness(pool, a.businessId);
    const today = localDateOf(Date.now(), biz.timezone);
    const from = w.date_from < today ? today : w.date_from;
    if (from > w.date_to) return { slots: [] };
    const { ctx } = await loadEngine(pool, a.businessId, from, w.date_to);
    const slots = listSlots(ctx, { serviceId: w.service_id, staffId: w.staff_id, fromDate: from, toDate: w.date_to, partySize: w.party_size, now: Date.now(), mode: 'admin', timeFromMin: w.time_from_min, timeToMin: w.time_to_min, limit: 20 });
    return { slots: slots.map((s) => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString(), staffIds: s.staffIds, remaining: s.remaining, occurrenceId: s.occurrenceId })) };
  });

  app.post('/api/admin/waitlist', async (req) => {
    const a = await requireMember(deps, req);
    requireCustomers(a);
    const body = parse(
      z.object({
        customerId: z.string().uuid().nullable().default(null),
        name: z.string().trim().min(1).max(100),
        email: z.string().trim().email().max(200).nullable().optional().or(z.literal('').transform(() => null)),
        phone: z.string().trim().max(30).nullable().optional(),
        serviceId: z.string().uuid(),
        staffId: z.string().uuid().nullable().default(null),
        dateFrom: zDate,
        dateTo: zDate,
        timeFromMin: z.number().int().min(0).max(1439).default(0),
        timeToMin: z.number().int().min(1).max(1440).default(1440),
        partySize: z.number().int().min(1).max(500).default(1),
        note: z.string().max(500).default(''),
      }),
      req.body,
    );
    if (body.dateTo < body.dateFrom) throw badRequest('希望期間を確認してください');
    if (!(await pool.query(`SELECT 1 FROM services WHERE id = $1 AND business_id = $2`, [body.serviceId, a.businessId])).rows[0]) throw notFound('サービス');
    if (body.customerId && !(await pool.query(`SELECT 1 FROM customers WHERE id = $1 AND business_id = $2`, [body.customerId, a.businessId])).rows[0]) throw notFound('顧客');
    const r = await pool.query(
      `INSERT INTO waitlist_entries (business_id, customer_id, name, email, phone, service_id, staff_id, date_from, date_to, time_from_min, time_to_min, party_size, note, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, ($9::date + 1)::timestamptz + interval '1 day') RETURNING id`,
      [a.businessId, body.customerId, body.name, body.email ?? null, body.phone ?? null, body.serviceId, body.staffId, body.dateFrom, body.dateTo, body.timeFromMin, body.timeToMin, body.partySize, body.note],
    );
    await audit(pool, a.businessId, a.actor, 'waitlist.create', 'waitlist', r.rows[0].id, {});
    return { id: r.rows[0].id };
  });

  app.put<{ Params: { id: string } }>('/api/admin/waitlist/:id', async (req) => {
    const a = await requireMember(deps, req);
    requireCustomers(a);
    const body = parse(z.object({ status: z.enum(['waiting', 'contacted', 'booked', 'cancelled']) }), req.body);
    const r = await pool.query(`UPDATE waitlist_entries SET status = $3, updated_at = now() WHERE id = $1 AND business_id = $2 RETURNING id`, [parse(z.string().uuid(), req.params.id), a.businessId, body.status]);
    if (!r.rows[0]) throw notFound('待機');
    await audit(pool, a.businessId, a.actor, 'waitlist.status', 'waitlist', req.params.id, { status: body.status });
    return { ok: true };
  });

  // ---------------------------------------------------------------- recurring sessions
  const zRule = z.object({
    serviceId: z.string().uuid(),
    staffId: z.string().uuid().nullable().default(null),
    freq: z.enum(['weekly', 'monthly_nth_weekday', 'monthly_day']),
    intervalN: z.number().int().min(1).max(12).default(1),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    nth: z.number().int().min(-1).max(5).nullable().default(null),
    monthDay: z.number().int().min(1).max(31).nullable().default(null),
    startTimeMin: z.number().int().min(0).max(1439),
    startDate: zDate,
    endDate: zDate.nullable().default(null),
    capacity: z.number().int().min(1).max(500).nullable().default(null),
    active: z.boolean().default(true),
  });
  const ruleRow = (r: z.infer<typeof zRule>) => ({
    service_id: r.serviceId,
    staff_id: r.staffId,
    freq: r.freq,
    interval_n: r.intervalN,
    weekdays: r.weekdays,
    nth: r.nth,
    month_day: r.monthDay,
    start_time_min: r.startTimeMin,
    start_date: r.startDate,
    end_date: r.endDate,
    capacity: r.capacity,
    active: r.active,
  });

  app.get('/api/admin/recurrences', async (req) => {
    const a = await requireMember(deps, req);
    const r = await pool.query(
      `SELECT r.id, r.service_id AS "serviceId", s.name AS "serviceName", r.staff_id AS "staffId", st.display_name AS "staffName", r.freq, r.interval_n AS "intervalN",
              r.weekdays, r.nth, r.month_day AS "monthDay", r.start_time_min AS "startTimeMin", r.start_date AS "startDate", r.end_date AS "endDate",
              r.capacity, r.active, r.generated_until AS "generatedUntil",
              (SELECT count(*)::int FROM session_occurrences o WHERE o.rule_id = r.id AND o.start_at > now() AND o.status = 'scheduled') AS "upcoming"
         FROM recurrence_rules r JOIN services s ON s.id = r.service_id LEFT JOIN staff st ON st.id = r.staff_id WHERE r.business_id = $1 ORDER BY r.created_at`,
      [a.businessId],
    );
    return { rules: r.rows };
  });

  app.post('/api/admin/recurrences', async (req) => {
    const a = await requireOwner(deps, req);
    const r = parse(zRule, req.body);
    return createRule(pool, a.businessId, ruleRow(r), a.actor);
  });

  app.put<{ Params: { id: string } }>('/api/admin/recurrences/:id', async (req) => {
    const a = await requireOwner(deps, req);
    const r = parse(zRule, req.body);
    return updateRule(pool, a.businessId, parse(z.string().uuid(), req.params.id), ruleRow(r), a.actor);
  });

  app.post('/api/admin/occurrences', async (req) => {
    const a = await requireOwner(deps, req);
    const b = parse(z.object({ serviceId: z.string().uuid(), staffId: z.string().uuid().nullable().default(null), start: z.string().datetime(), capacity: z.number().int().min(1).max(500).nullable().default(null), note: z.string().max(500).default('') }), req.body);
    const id = await createOccurrence(pool, a.businessId, { serviceId: b.serviceId, staffId: b.staffId, start: Date.parse(b.start), capacity: b.capacity, note: b.note }, a.actor);
    return { id };
  });

  app.put<{ Params: { id: string } }>('/api/admin/occurrences/:id', async (req) => {
    const a = await requireOwner(deps, req);
    const b = parse(z.object({ capacity: z.number().int().min(1).max(500).optional(), note: z.string().max(500).optional(), staffId: z.string().uuid().nullable().optional(), start: z.string().datetime().optional() }), req.body);
    await updateOccurrence(pool, a.businessId, parse(z.string().uuid(), req.params.id), { capacity: b.capacity, note: b.note, staffId: b.staffId, start: b.start ? Date.parse(b.start) : undefined }, a.actor);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/admin/occurrences/:id/cancel', async (req) => {
    const a = await requireOwner(deps, req);
    const b = parse(z.object({ cancelBookings: z.boolean().default(false), reason: z.string().max(300).optional() }), req.body);
    return cancelOccurrence(pool, a.businessId, parse(z.string().uuid(), req.params.id), b, a.actor);
  });

  // ---------------------------------------------------------------- dashboard
  app.get('/api/admin/dashboard', async (req) => {
    const a = await requireMember(deps, req);
    const biz = await getBusiness(pool, a.businessId);
    const now = Date.now();
    const today = localDateOf(now, biz.timezone);
    const tr = dayRange(today, biz.timezone);
    // week = business week start
    const wdToday = new Date(`${today}T00:00:00Z`).getUTCDay();
    const weekStartDate = addDays(today, -((wdToday - biz.week_start + 7) % 7));
    const wr = { start: dayRange(weekStartDate, biz.timezone).start, end: dayRange(addDays(weekStartDate, 6), biz.timezone).end };
    const scope = staffScope(a);
    const s = [a.businessId, scope];
    const todayRows = await pool.query(
      `${BOOKING_SELECT} WHERE b.business_id = $1 AND ($2::uuid IS NULL OR b.staff_id = $2) AND b.start_at >= $3 AND b.start_at < $4 AND b.status NOT IN ('rescheduled') ORDER BY b.start_at`,
      [...s, new Date(tr.start), new Date(tr.end)],
    );
    const next = await pool.query(`${BOOKING_SELECT} WHERE b.business_id = $1 AND ($2::uuid IS NULL OR b.staff_id = $2) AND b.status = 'confirmed' AND b.start_at >= $3 ORDER BY b.start_at LIMIT 5`, [...s, new Date(now)]);
    const unhandled = await pool.query(
      `${BOOKING_SELECT} WHERE b.business_id = $1 AND ($2::uuid IS NULL OR b.staff_id = $2) AND b.status IN ('confirmed','checked_in') AND b.end_at < $3 AND b.start_at > $3::timestamptz - interval '14 days' ORDER BY b.start_at`,
      [...s, new Date(now)],
    );
    const recentChanges = await pool.query(
      `SELECT h.at, h.from_status AS "from", h.to_status AS "to", h.actor_type AS "actorType", b.id, b.ref_code AS "refCode", b.start_at AS start, c.name AS "customerName"
         FROM booking_status_history h JOIN bookings b ON b.id = h.booking_id JOIN customers c ON c.id = b.customer_id
        WHERE h.business_id = $1 AND ($2::uuid IS NULL OR b.staff_id = $2) AND h.to_status IN ('cancelled_by_customer','cancelled_by_business','rescheduled') AND h.at > now() - interval '7 days'
        ORDER BY h.at DESC LIMIT 10`,
      s,
    );
    const counts = (
      await pool.query(
        `SELECT count(*) FILTER (WHERE status <> 'rescheduled' AND start_at >= $3 AND start_at < $4)::int AS "weekBookings",
                count(*) FILTER (WHERE status = 'no_show' AND start_at > now() - interval '30 days')::int AS "noShow30d"
           FROM bookings WHERE business_id = $1 AND ($2::uuid IS NULL OR staff_id = $2)
            AND start_at >= LEAST($3::timestamptz, now() - interval '30 days') AND start_at < GREATEST($4::timestamptz, now())`,
        [...s, new Date(wr.start), new Date(wr.end)],
      )
    ).rows[0];
    const waitlist = (await pool.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE last_match_at > now() - interval '7 days')::int AS matched FROM waitlist_entries WHERE business_id = $1 AND status = 'waiting' AND expires_at > now()`, [a.businessId])).rows[0];
    const failedNotifications = (await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE business_id = $1 AND status IN ('failed','unknown') AND created_at > now() - interval '30 days'`, [a.businessId])).rows[0].n;
    // open slots today & tomorrow per public service (small, quick overview)
    const { ctx } = await loadEngine(pool, a.businessId, today, addDays(today, 1));
    const openSlots = ctx.input.services
      .filter((x) => !x.archived && x.acceptsBookings && x.isPublic)
      .slice(0, 8)
      .map((svc) => ({
        serviceId: svc.id,
        serviceName: svc.name,
        today: listSlots(ctx, { serviceId: svc.id, staffId: null, fromDate: today, toDate: today, partySize: 1, now, mode: 'public' }).length,
        tomorrow: listSlots(ctx, { serviceId: svc.id, staffId: null, fromDate: addDays(today, 1), toDate: addDays(today, 1), partySize: 1, now, mode: 'public' }).length,
      }));
    const staffToday = await pool.query(
      `SELECT st.id, st.display_name AS name, st.color, count(b.id)::int AS bookings
         FROM staff st LEFT JOIN bookings b ON b.staff_id = st.id AND b.start_at >= $2 AND b.start_at < $3 AND b.status IN ('confirmed','checked_in','completed','no_show')
        WHERE st.business_id = $1 AND st.archived_at IS NULL GROUP BY st.id ORDER BY st.sort_order, st.display_name`,
      [a.businessId, new Date(tr.start), new Date(tr.end)],
    );
    return {
      today,
      timezone: biz.timezone,
      published: biz.published,
      slug: biz.slug,
      isSample: biz.is_sample,
      todayBookings: todayRows.rows,
      nextBookings: next.rows,
      unhandled: unhandled.rows,
      recentChanges: recentChanges.rows,
      weekBookings: counts.weekBookings,
      noShow30d: counts.noShow30d,
      waitlist,
      failedNotifications,
      openSlots,
      staffToday: staffToday.rows,
    };
  });

}

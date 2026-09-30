import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bookingWindowDates, listSlots } from '../engine/availability.js';
import { addDays, diffDays, formatLocalJa, localDateOf } from '../engine/time.js';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { CUSTOMER } from '../services/audit.js';
import { cancelBooking, createBooking, questionsFor, rescheduleBooking } from '../services/bookings.js';
import { loadEngine } from '../services/loader.js';
import { resolveManageToken } from '../services/tokens.js';
import { buildIcs } from '../services/ics.js';
import { clientIp, parse, rateLimit, zDate, type AppDeps } from '../http.js';
import { normEmail } from '../lib/normalize.js';

async function businessBySlug(deps: AppDeps, slug: string) {
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(slug)) throw notFound('予約ページ');
  const r = await deps.pool.query(`SELECT id, published FROM businesses WHERE slug = $1`, [slug]);
  const b = r.rows[0];
  if (!b || !b.published) throw notFound('予約ページ');
  return b.id as string;
}

/** Only explicitly public fields. No internal names, notes, e-mails, resource ids or customer data ever leave here. */
async function publicProfile(deps: AppDeps, businessId: string) {
  const b = (
    await deps.pool.query(
      `SELECT slug, name, brand_name, description, phone, email, address, website_url, sns_url, timezone, week_start, theme_color,
              completion_message, notes, phone_requirement, consent_text, min_notice_min, max_advance_days, change_deadline_min,
              cancel_deadline_min, logo_mime IS NOT NULL AS has_logo
         FROM businesses WHERE id = $1`,
      [businessId],
    )
  ).rows[0];
  const services = (
    await deps.pool.query(
      `SELECT id, name, description, category, duration_min, price_text, capacity, max_party_size, requires_staff, booking_mode, notes
         FROM services WHERE business_id = $1 AND archived_at IS NULL AND is_public AND accepts_bookings ORDER BY sort_order, name`,
      [businessId],
    )
  ).rows;
  const staff = (
    await deps.pool.query(
      `SELECT s.id, s.display_name, s.profile, array_agg(ss.service_id) AS service_ids
         FROM staff s JOIN staff_services ss ON ss.staff_id = s.id
        WHERE s.business_id = $1 AND s.archived_at IS NULL AND s.accepts_bookings
        GROUP BY s.id ORDER BY s.sort_order, s.display_name`,
      [businessId],
    )
  ).rows;
  return {
    business: {
      slug: b.slug,
      name: b.brand_name || b.name,
      description: b.description,
      phone: b.phone,
      email: b.email,
      address: b.address,
      websiteUrl: b.website_url,
      snsUrl: b.sns_url,
      timezone: b.timezone,
      weekStart: b.week_start,
      themeColor: b.theme_color,
      completionMessage: b.completion_message,
      notes: b.notes,
      phoneRequirement: b.phone_requirement,
      consentText: b.consent_text,
      minNoticeMin: b.min_notice_min,
      maxAdvanceDays: b.max_advance_days,
      changeDeadlineMin: b.change_deadline_min,
      cancelDeadlineMin: b.cancel_deadline_min,
      logoUrl: b.has_logo ? `/api/public/${b.slug}/logo` : null,
      turnstileSiteKey: deps.cfg.turnstileSiteKey || null,
    },
    services: services.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      category: s.category,
      durationMin: s.duration_min,
      priceText: s.price_text,
      capacity: s.capacity,
      maxPartySize: Math.min(s.max_party_size, s.capacity),
      requiresStaff: s.requires_staff,
      bookingMode: s.booking_mode,
      notes: s.notes,
      staffIds: staff.filter((st) => st.service_ids.includes(s.id)).map((st) => st.id),
    })),
    staff: staff.map((s) => ({ id: s.id, name: s.display_name, profile: s.profile })),
  };
}

function slotDto(s: { start: number; end: number; remaining: number | null; occurrenceId: string | null }) {
  return { start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString(), remaining: s.remaining, occurrenceId: s.occurrenceId };
}

async function verifyTurnstile(deps: AppDeps, token: string | undefined, ip: string): Promise<void> {
  if (!deps.cfg.turnstileSecret) return;
  if (!token) throw badRequest('ロボットでないことの確認を完了してください');
  const body = new URLSearchParams({ secret: deps.cfg.turnstileSecret, response: token, remoteip: ip });
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  const j = (await r.json()) as { success?: boolean };
  if (!j.success) throw badRequest('ロボットでないことの確認に失敗しました。もう一度お試しください。');
}

const zCustomer = z.object({
  name: z.string().trim().min(1, 'お名前を入力してください').max(100),
  email: z.string().trim().email('メールアドレスの形式が正しくありません').max(200),
  phone: z
    .string()
    .trim()
    .max(30)
    .regex(/^[0-9０-９+\-()\s]*$/, '電話番号の形式が正しくありません')
    .optional()
    .nullable(),
});

const zAnswer = z.object({ questionId: z.string().uuid(), value: z.union([z.string().max(2000), z.array(z.string().max(100)).max(50), z.boolean(), z.null()]) });

export function registerPublicRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get<{ Params: { slug: string } }>('/api/public/:slug', async (req, reply) => {
    await rateLimit(deps, `pub:${clientIp(req)}`, 300, 60);
    const id = await businessBySlug(deps, req.params.slug);
    reply.header('Cache-Control', 'no-store');
    return publicProfile(deps, id);
  });

  app.get<{ Params: { slug: string } }>('/api/public/:slug/logo', async (req, reply) => {
    const id = await businessBySlug(deps, req.params.slug);
    const r = (await deps.pool.query(`SELECT logo, logo_mime FROM businesses WHERE id = $1`, [id])).rows[0];
    if (!r?.logo) throw notFound('ロゴ');
    reply.header('Content-Type', r.logo_mime).header('Cache-Control', 'public, max-age=300').header('X-Content-Type-Options', 'nosniff');
    return reply.send(r.logo);
  });

  app.get<{ Params: { slug: string; serviceId: string } }>('/api/public/:slug/services/:serviceId/questions', async (req) => {
    await rateLimit(deps, `pub:${clientIp(req)}`, 300, 60);
    const id = await businessBySlug(deps, req.params.slug);
    const sid = parse(z.string().uuid(), req.params.serviceId);
    const qs = await questionsFor(deps.pool, id, sid);
    return { questions: qs.map((q) => ({ id: q.id, type: q.type, label: q.label, helpText: q.help_text, required: q.required, options: q.options })) };
  });

  app.get<{ Params: { slug: string } }>('/api/public/:slug/slots', async (req) => {
    await rateLimit(deps, `slots:${clientIp(req)}`, 120, 60);
    const bizId = await businessBySlug(deps, req.params.slug);
    const qy = parse(
      z.object({
        serviceId: z.string().uuid(),
        staffId: z.string().uuid().optional(),
        from: zDate,
        to: zDate,
        partySize: z.coerce.number().int().min(1).max(500).default(1),
      }),
      req.query,
    );
    if (diffDays(qy.from, qy.to) > 42 || qy.to < qy.from) throw badRequest('期間は42日以内で指定してください');
    const { ctx } = await loadEngine(deps.pool, bizId, qy.from, qy.to);
    const now = Date.now();
    const win = bookingWindowDates(ctx, now);
    const from = qy.from < win.first ? win.first : qy.from;
    const to = qy.to > win.last ? win.last : qy.to;
    const slots = from > to ? [] : listSlots(ctx, { serviceId: qy.serviceId, staffId: qy.staffId ?? null, fromDate: from, toDate: to, partySize: qy.partySize, now, mode: 'public' });
    const byDate: Record<string, ReturnType<typeof slotDto>[]> = {};
    for (const s of slots) (byDate[localDateOf(s.start, ctx.timezone)] ??= []).push(slotDto(s));
    return { timezone: ctx.timezone, firstDate: win.first, lastDate: win.last, dates: byDate };
  });

  app.post<{ Params: { slug: string } }>('/api/public/:slug/bookings', async (req, reply) => {
    const ip = clientIp(req);
    await rateLimit(deps, `book-ip:${ip}`, 10, 600);
    const bizId = await businessBySlug(deps, req.params.slug);
    await rateLimit(deps, `book-biz:${bizId}`, 300, 3600);
    const body = parse(
      z.object({
        serviceId: z.string().uuid(),
        staffId: z.string().uuid().nullable().optional(),
        start: z.string().datetime().optional(),
        occurrenceId: z.string().uuid().nullable().optional(),
        partySize: z.number().int().min(1).max(500).default(1),
        customer: zCustomer,
        answers: z.array(zAnswer).max(50).default([]),
        note: z.string().max(1000).optional().default(''),
        consent: z.boolean().optional(),
        idempotencyKey: z.string().uuid(),
        website: z.string().max(200).optional(), // honeypot – must stay empty
        elapsedMs: z.number().optional(),
        turnstileToken: z.string().max(4000).optional(),
      }),
      req.body,
    );
    // simple bot defenses (documented in SECURITY.md)
    if (body.website) throw badRequest('送信内容を確認してください');
    if (body.elapsedMs !== undefined && body.elapsedMs < 2500) throw badRequest('入力が早すぎます。内容を確認してもう一度お試しください。');
    await verifyTurnstile(deps, body.turnstileToken, ip);
    const biz = (await deps.pool.query(`SELECT phone_requirement, consent_text FROM businesses WHERE id = $1`, [bizId])).rows[0];
    if (biz.phone_requirement === 'required' && !body.customer.phone) throw badRequest('電話番号を入力してください', { fieldErrors: { 'customer.phone': '電話番号を入力してください' } });
    if (biz.consent_text && !body.consent) throw badRequest('同意事項を確認してください', { fieldErrors: { consent: '同意が必要です' } });
    const em = normEmail(body.customer.email)!;
    await rateLimit(deps, `book-email:${bizId}:${em}`, 10, 86400);
    const created = await createBooking(deps.pool, {
      businessId: bizId,
      serviceId: body.serviceId,
      staffId: body.staffId ?? null,
      start: body.start ? Date.parse(body.start) : undefined,
      occurrenceId: body.occurrenceId ?? null,
      partySize: body.partySize,
      customer: { name: body.customer.name, email: body.customer.email, phone: biz.phone_requirement === 'hidden' ? null : body.customer.phone },
      answers: body.answers,
      customerNote: body.note,
      source: 'public',
      mode: 'public',
      idempotencyKey: body.idempotencyKey,
      actor: CUSTOMER,
      issueToken: true,
    });
    reply.header('Cache-Control', 'no-store');
    return {
      refCode: created.refCode,
      start: created.start.toISOString(),
      end: created.end.toISOString(),
      manageToken: created.manageToken,
      replayed: created.replayed,
    };
  });

  app.post<{ Params: { slug: string } }>('/api/public/:slug/waitlist', async (req) => {
    await rateLimit(deps, `wait-ip:${clientIp(req)}`, 10, 600);
    const bizId = await businessBySlug(deps, req.params.slug);
    const body = parse(
      z.object({
        serviceId: z.string().uuid(),
        staffId: z.string().uuid().nullable().optional(),
        dateFrom: zDate,
        dateTo: zDate,
        timeFromMin: z.number().int().min(0).max(1439).default(0),
        timeToMin: z.number().int().min(1).max(1440).default(1440),
        partySize: z.number().int().min(1).max(500).default(1),
        name: z.string().trim().min(1).max(100),
        email: z.string().trim().email().max(200),
        phone: z.string().trim().max(30).optional().nullable(),
        note: z.string().max(500).optional().default(''),
        website: z.string().max(200).optional(),
      }),
      req.body,
    );
    if (body.website) throw badRequest('送信内容を確認してください');
    if (body.dateTo < body.dateFrom || diffDays(body.dateFrom, body.dateTo) > 60) throw badRequest('希望期間を確認してください（60日以内）');
    if (body.timeToMin <= body.timeFromMin) throw badRequest('希望時間帯を確認してください');
    const svc = (await deps.pool.query(`SELECT 1 FROM services WHERE id = $1 AND business_id = $2 AND is_public AND archived_at IS NULL`, [body.serviceId, bizId])).rows[0];
    if (!svc) throw notFound('サービス');
    const expires = new Date(Date.parse(`${addDays(body.dateTo, 1)}T00:00:00Z`) + 86_400_000);
    await deps.pool.query(
      `INSERT INTO waitlist_entries (business_id, name, email, phone, service_id, staff_id, date_from, date_to, time_from_min, time_to_min, party_size, note, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [bizId, body.name, body.email, body.phone ?? null, body.serviceId, body.staffId ?? null, body.dateFrom, body.dateTo, body.timeFromMin, body.timeToMin, body.partySize, body.note, expires],
    );
    return { ok: true, message: '空き待ちを登録しました。空きが出た場合はお店からご連絡します（予約の確定・保証ではありません）。' };
  });

  // ------------------------------------------------------------------ manage link (token in body, never in URL path/query)

  async function resolve(req: { body: unknown; ip: string }) {
    await rateLimit(deps, `manage:${req.ip}`, 60, 60);
    const { token } = parse(z.object({ token: z.string().max(100) }).passthrough(), req.body);
    const r = await resolveManageToken(deps.pool, token);
    if (!r) throw new AppError(404, 'INVALID_LINK', 'リンクが無効か期限切れです。お店へお問い合わせください。');
    return r;
  }

  async function manageView(bookingId: string) {
    const b = (
      await deps.pool.query(
        `SELECT b.id, b.ref_code, b.status, b.start_at, b.end_at, b.party_size, b.service_id, b.staff_id, b.occurrence_id, b.service_snapshot,
                b.answers, b.customer_note, c.name AS customer_name, s.display_name AS staff_name, sv.booking_mode,
                biz.slug, biz.name, biz.brand_name, biz.phone, biz.email, biz.timezone, biz.change_deadline_min, biz.cancel_deadline_min, biz.theme_color, biz.notes
           FROM bookings b JOIN customers c ON c.id = b.customer_id JOIN businesses biz ON biz.id = b.business_id
           JOIN services sv ON sv.id = b.service_id LEFT JOIN staff s ON s.id = b.staff_id WHERE b.id = $1`,
        [bookingId],
      )
    ).rows[0];
    const now = Date.now();
    const start = b.start_at.getTime();
    return {
      booking: {
        refCode: b.ref_code,
        status: b.status,
        start: b.start_at.toISOString(),
        end: b.end_at.toISOString(),
        partySize: b.party_size,
        serviceName: b.service_snapshot.name,
        serviceId: b.service_id,
        staffName: b.staff_name,
        bookingMode: b.booking_mode,
        customerName: b.customer_name,
        answers: (b.answers as Array<{ label: string; display: string }>).map((a) => ({ label: a.label, display: a.display })),
        note: b.customer_note,
        canChange: b.status === 'confirmed' && now <= start - b.change_deadline_min * 60_000,
        canCancel: b.status === 'confirmed' && now <= start - b.cancel_deadline_min * 60_000,
        changeDeadline: new Date(start - b.change_deadline_min * 60_000).toISOString(),
        cancelDeadline: new Date(start - b.cancel_deadline_min * 60_000).toISOString(),
        startLabel: formatLocalJa(start, b.timezone),
      },
      business: { slug: b.slug, name: b.brand_name || b.name, phone: b.phone, email: b.email, timezone: b.timezone, themeColor: b.theme_color, notes: b.notes },
    };
  }

  app.post('/api/manage/view', async (req, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    const r = await resolve(req);
    return manageView(r.bookingId);
  });

  app.post('/api/manage/slots', async (req) => {
    const r = await resolve(req);
    const qy = parse(z.object({ token: z.string(), from: zDate, to: zDate }), req.body);
    if (diffDays(qy.from, qy.to) > 42 || qy.to < qy.from) throw badRequest('期間は42日以内で指定してください');
    const b = (await deps.pool.query(`SELECT service_id, staff_id, party_size FROM bookings WHERE id = $1`, [r.bookingId])).rows[0];
    const { ctx } = await loadEngine(deps.pool, r.businessId, qy.from, qy.to);
    const now = Date.now();
    const win = bookingWindowDates(ctx, now);
    const from = qy.from < win.first ? win.first : qy.from;
    const to = qy.to > win.last ? win.last : qy.to;
    const slots = from > to ? [] : listSlots(ctx, { serviceId: b.service_id, staffId: b.staff_id, fromDate: from, toDate: to, partySize: b.party_size, now, mode: 'public', excludeBookingId: r.bookingId });
    const byDate: Record<string, ReturnType<typeof slotDto>[]> = {};
    for (const s of slots) (byDate[localDateOf(s.start, ctx.timezone)] ??= []).push(slotDto(s));
    return { timezone: ctx.timezone, firstDate: win.first, lastDate: win.last, dates: byDate };
  });

  app.post('/api/manage/reschedule', async (req) => {
    const r = await resolve(req);
    const body = parse(z.object({ token: z.string(), start: z.string().datetime().optional(), occurrenceId: z.string().uuid().optional() }), req.body);
    if (!body.start && !body.occurrenceId) throw badRequest('変更先を選んでください');
    const out = await rescheduleBooking(deps.pool, {
      businessId: r.businessId,
      bookingId: r.bookingId,
      start: body.start ? Date.parse(body.start) : undefined,
      occurrenceId: body.occurrenceId ?? null,
      mode: 'public',
      actor: CUSTOMER,
      byCustomer: true,
    });
    return { ok: true, ...(await manageView(out.bookingId)) };
  });

  app.post('/api/manage/cancel', async (req) => {
    const r = await resolve(req);
    const body = parse(z.object({ token: z.string(), reason: z.string().max(500).optional() }), req.body);
    const b = (await deps.pool.query(`SELECT status FROM bookings WHERE id = $1`, [r.bookingId])).rows[0];
    if (b.status !== 'confirmed') throw forbidden('この予約はキャンセルできません');
    await cancelBooking(deps.pool, { businessId: r.businessId, bookingId: r.bookingId, by: 'customer', reason: body.reason ?? null, actor: CUSTOMER });
    return { ok: true, ...(await manageView(r.bookingId)) };
  });

  app.post('/api/manage/ics', async (req, reply) => {
    const r = await resolve(req);
    const v = await manageView(r.bookingId);
    reply.header('Content-Type', 'text/calendar; charset=utf-8').header('Content-Disposition', `attachment; filename="booking-${v.booking.refCode}.ics"`);
    return buildIcs([
      {
        uid: `${v.booking.refCode}@reserveflow`,
        start: new Date(v.booking.start),
        end: new Date(v.booking.end),
        summary: `${v.booking.serviceName}（${v.business.name}）`,
        description: `予約番号: ${v.booking.refCode}`,
        status: v.booking.status.startsWith('cancelled') ? 'CANCELLED' : 'CONFIRMED',
      },
    ]);
  });
}

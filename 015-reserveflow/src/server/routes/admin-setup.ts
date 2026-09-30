import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx, lockBusiness, type Queryable } from '../db/pool.js';
import { isValidTimezone } from '../engine/time.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { BUSINESS_COLUMNS, getBusiness } from '../services/loader.js';
import { enqueue, sealSecret } from '../services/notifications.js';
import { parse, requireMember, requireOwner, zDate, type AppDeps } from '../http.js';
import { zSlug } from './auth.js';

const zHours = z
  .array(z.object({ weekday: z.number().int().min(0).max(6), startMin: z.number().int().min(0).max(1439), endMin: z.number().int().min(1).max(1440) }))
  .max(100)
  .refine((l) => l.every((h) => h.endMin > h.startMin), '終了は開始より後にしてください')
  .refine((l) => {
    for (let d = 0; d < 7; d++) {
      const day = l.filter((h) => h.weekday === d).sort((a, b) => a.startMin - b.startMin);
      for (let i = 1; i < day.length; i++) if (day[i].startMin < day[i - 1].endMin) return false;
    }
    return true;
  }, '同じ曜日の時間帯が重なっています');

async function replaceHours(q: Queryable, businessId: string, kind: 'business' | 'staff' | 'staff_break' | 'resource', ownerId: string, hours: z.infer<typeof zHours>) {
  await q.query(`DELETE FROM weekly_hours WHERE business_id = $1 AND owner_kind = $2 AND owner_id = $3`, [businessId, kind, ownerId]);
  for (const h of hours)
    await q.query(`INSERT INTO weekly_hours (business_id, owner_kind, owner_id, weekday, start_min, end_min) VALUES ($1,$2,$3,$4,$5,$6)`, [businessId, kind, ownerId, h.weekday, h.startMin, h.endMin]);
}

async function hoursOf(q: Queryable, businessId: string, kind: string, ownerId: string) {
  return (
    await q.query(`SELECT weekday, start_min AS "startMin", end_min AS "endMin" FROM weekly_hours WHERE business_id = $1 AND owner_kind = $2 AND owner_id = $3 ORDER BY weekday, start_min`, [
      businessId,
      kind,
      ownerId,
    ])
  ).rows;
}

async function assertOwned(q: Queryable, table: 'services' | 'staff' | 'resources' | 'questions', businessId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const r = await q.query(`SELECT count(*)::int AS n FROM ${table} WHERE business_id = $1 AND id = ANY($2)`, [businessId, ids]);
  if (r.rows[0].n !== new Set(ids).size) throw notFound();
}

const zSettings = z.object({
  name: z.string().trim().min(1).max(100),
  brandName: z.string().trim().max(100).nullable().optional(),
  description: z.string().max(2000).default(''),
  phone: z.string().trim().max(30).nullable().optional(),
  email: z.string().trim().email().max(200).nullable().optional().or(z.literal('').transform(() => null)),
  address: z.string().trim().max(300).nullable().optional(),
  websiteUrl: z.string().trim().url().max(300).nullable().optional().or(z.literal('').transform(() => null)),
  snsUrl: z.string().trim().url().max(300).nullable().optional().or(z.literal('').transform(() => null)),
  timezone: z.string().refine(isValidTimezone, 'タイムゾーンが正しくありません'),
  weekStart: z.number().int().min(0).max(6),
  slotIntervalMin: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20), z.literal(30), z.literal(60)]),
  minNoticeMin: z.number().int().min(0).max(43200),
  maxAdvanceDays: z.number().int().min(1).max(365),
  changeDeadlineMin: z.number().int().min(0).max(43200),
  cancelDeadlineMin: z.number().int().min(0).max(43200),
  reminderHoursBefore: z.number().int().min(0).max(168),
  themeColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  completionMessage: z.string().max(2000).default(''),
  notes: z.string().max(4000).default(''),
  phoneRequirement: z.enum(['required', 'optional', 'hidden']),
  consentText: z.string().max(2000).default(''),
  emailSignature: z.string().max(1000).default(''),
  notifyOwnerNewBooking: z.boolean(),
  ownerNotifyEmail: z.string().trim().email().max(200).nullable().optional().or(z.literal('').transform(() => null)),
  slug: zSlug,
  published: z.boolean(),
});

function settingsDto(b: Awaited<ReturnType<typeof getBusiness>>) {
  return {
    id: b.id,
    name: b.name,
    brandName: b.brand_name,
    description: b.description,
    phone: b.phone,
    email: b.email,
    address: b.address,
    websiteUrl: b.website_url,
    snsUrl: b.sns_url,
    timezone: b.timezone,
    weekStart: b.week_start,
    slotIntervalMin: b.slot_interval_min,
    minNoticeMin: b.min_notice_min,
    maxAdvanceDays: b.max_advance_days,
    changeDeadlineMin: b.change_deadline_min,
    cancelDeadlineMin: b.cancel_deadline_min,
    reminderHoursBefore: b.reminder_hours_before,
    themeColor: b.theme_color,
    completionMessage: b.completion_message,
    notes: b.notes,
    phoneRequirement: b.phone_requirement,
    consentText: b.consent_text,
    emailSignature: b.email_signature,
    notifyOwnerNewBooking: b.notify_owner_new_booking,
    ownerNotifyEmail: b.owner_notify_email,
    slug: b.slug,
    published: b.published,
    isSample: b.is_sample,
    hasLogo: !!b.logo_mime,
  };
}

const zService = z.object({
  name: z.string().trim().min(1, '名称を入力してください').max(100),
  description: z.string().max(2000).default(''),
  category: z.string().max(50).default(''),
  durationMin: z.number().int().min(5).max(1440),
  bufferBeforeMin: z.number().int().min(0).max(240).default(0),
  bufferAfterMin: z.number().int().min(0).max(240).default(0),
  priceText: z.string().max(100).default(''),
  capacity: z.number().int().min(1).max(500).default(1),
  maxPartySize: z.number().int().min(1).max(500).default(1),
  requiresStaff: z.boolean().default(true),
  bookingMode: z.enum(['slots', 'sessions']).default('slots'),
  slotIntervalMin: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20), z.literal(30), z.literal(60), z.literal(90), z.literal(120)]).nullable().default(null),
  acceptsBookings: z.boolean().default(true),
  isPublic: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(100000).default(0),
  notes: z.string().max(2000).default(''),
  staffIds: z.array(z.string().uuid()).max(500).default([]),
  resourceIds: z.array(z.string().uuid()).max(50).default([]),
});

const zStaff = z.object({
  displayName: z.string().trim().min(1, '表示名を入力してください').max(60),
  internalName: z.string().max(100).default(''),
  email: z.string().trim().email().max(200).nullable().optional().or(z.literal('').transform(() => null)),
  profile: z.string().max(1000).default(''),
  acceptsBookings: z.boolean().default(true),
  usesBusinessHours: z.boolean().default(true),
  maxParticipants: z.number().int().min(1).max(500).nullable().default(null),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#4a7bd0'),
  sortOrder: z.number().int().min(0).max(100000).default(0),
  serviceIds: z.array(z.string().uuid()).max(500).default([]),
  hours: zHours.default([]),
  breaks: zHours.default([]),
});

const zResource = z.object({
  name: z.string().trim().min(1, '名称を入力してください').max(100),
  kind: z.string().max(30).default('room'),
  quantity: z.number().int().min(1).max(100).default(1),
  personCapacity: z.number().int().min(1).max(500).nullable().default(null),
  hasHours: z.boolean().default(false),
  hours: zHours.default([]),
  sortOrder: z.number().int().min(0).max(100000).default(0),
  serviceIds: z.array(z.string().uuid()).max(500).default([]),
});

const zQuestion = z.object({
  serviceId: z.string().uuid().nullable().default(null),
  type: z.enum(['short_text', 'long_text', 'single_choice', 'multi_choice', 'yes_no', 'confirm']),
  label: z.string().trim().min(1).max(300),
  helpText: z.string().max(1000).default(''),
  required: z.boolean().default(false),
  options: z.array(z.object({ id: z.string().max(40).optional(), label: z.string().trim().min(1).max(100) })).max(30).default([]),
  sortOrder: z.number().int().min(0).max(100000).default(0),
});

export function registerAdminSetupRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { pool } = deps;

  // ---------------------------------------------------------------- settings
  app.get('/api/admin/settings', async (req) => {
    const a = await requireMember(deps, req);
    return settingsDto(await getBusiness(pool, a.businessId));
  });

  app.put('/api/admin/settings', async (req) => {
    const a = await requireOwner(deps, req);
    const s = parse(zSettings, req.body);
    const before = await getBusiness(pool, a.businessId);
    if (s.slug !== before.slug) {
      const t = await pool.query(`SELECT 1 FROM businesses WHERE slug = $1 AND id <> $2`, [s.slug, a.businessId]);
      if (t.rows[0]) throw conflict('SLUG_TAKEN', 'このURL名はすでに使われています');
    }
    await pool.query(
      `UPDATE businesses SET name=$2, brand_name=$3, description=$4, phone=$5, email=$6, address=$7, website_url=$8, sns_url=$9, timezone=$10,
              week_start=$11, slot_interval_min=$12, min_notice_min=$13, max_advance_days=$14, change_deadline_min=$15, cancel_deadline_min=$16,
              reminder_hours_before=$17, theme_color=$18, completion_message=$19, notes=$20, phone_requirement=$21, consent_text=$22,
              email_signature=$23, notify_owner_new_booking=$24, owner_notify_email=$25, slug=$26, published=$27, updated_at=now()
        WHERE id=$1`,
      [
        a.businessId, s.name, s.brandName ?? null, s.description, s.phone ?? null, s.email ?? null, s.address ?? null, s.websiteUrl ?? null,
        s.snsUrl ?? null, s.timezone, s.weekStart, s.slotIntervalMin, s.minNoticeMin, s.maxAdvanceDays, s.changeDeadlineMin, s.cancelDeadlineMin,
        s.reminderHoursBefore, s.themeColor, s.completionMessage, s.notes, s.phoneRequirement, s.consentText, s.emailSignature,
        s.notifyOwnerNewBooking, s.ownerNotifyEmail ?? null, s.slug, s.published,
      ],
    );
    const changed = Object.keys(s).filter((k) => JSON.stringify((settingsDto(before) as Record<string, unknown>)[k]) !== JSON.stringify((s as Record<string, unknown>)[k]));
    await audit(pool, a.businessId, a.actor, 'settings.update', 'business', a.businessId, { changed });
    return settingsDto(await getBusiness(pool, a.businessId));
  });

  app.put('/api/admin/settings/logo', async (req) => {
    const a = await requireOwner(deps, req);
    const body = parse(z.object({ mime: z.enum(['image/png', 'image/jpeg', 'image/webp']), dataBase64: z.string().max(400_000) }), req.body);
    const buf = Buffer.from(body.dataBase64, 'base64');
    if (buf.length > 256 * 1024) throw badRequest('ロゴ画像は256KB以下にしてください');
    const sig = buf.subarray(0, 12).toString('hex');
    const ok = (body.mime === 'image/png' && sig.startsWith('89504e47')) || (body.mime === 'image/jpeg' && sig.startsWith('ffd8ff')) || (body.mime === 'image/webp' && sig.startsWith('52494646') && sig.slice(16, 24) === '57454250');
    if (!ok) throw badRequest('画像ファイルの形式が正しくありません（PNG/JPEG/WebP）');
    await pool.query(`UPDATE businesses SET logo = $2, logo_mime = $3, updated_at = now() WHERE id = $1`, [a.businessId, buf, body.mime]);
    await audit(pool, a.businessId, a.actor, 'settings.logo', 'business', a.businessId, { bytes: buf.length });
    return { ok: true };
  });

  app.delete('/api/admin/settings/logo', async (req) => {
    const a = await requireOwner(deps, req);
    await pool.query(`UPDATE businesses SET logo = NULL, logo_mime = NULL WHERE id = $1`, [a.businessId]);
    await audit(pool, a.businessId, a.actor, 'settings.logo_remove', 'business', a.businessId, {});
    return { ok: true };
  });

  // ---------------------------------------------------------------- business hours & exceptions
  app.get('/api/admin/hours', async (req) => {
    const a = await requireMember(deps, req);
    return { hours: await hoursOf(pool, a.businessId, 'business', a.businessId) };
  });

  app.put('/api/admin/hours', async (req) => {
    const a = await requireOwner(deps, req);
    const { hours } = parse(z.object({ hours: zHours }), req.body);
    await withTx(pool, async (tx) => {
      await lockBusiness(tx, a.businessId);
      await replaceHours(tx, a.businessId, 'business', a.businessId, hours);
      await audit(tx, a.businessId, a.actor, 'hours.update', 'business', a.businessId, { intervals: hours.length });
    });
    return { hours: await hoursOf(pool, a.businessId, 'business', a.businessId) };
  });

  app.get('/api/admin/exceptions', async (req) => {
    const a = await requireMember(deps, req);
    const q = parse(z.object({ from: zDate.optional(), to: zDate.optional() }), req.query);
    const r = await pool.query(
      `SELECT id, date, kind, label, intervals FROM date_exceptions WHERE business_id = $1 AND ($2::date IS NULL OR date >= $2) AND ($3::date IS NULL OR date <= $3) ORDER BY date`,
      [a.businessId, q.from ?? null, q.to ?? null],
    );
    return { exceptions: r.rows };
  });

  app.post('/api/admin/exceptions', async (req) => {
    const a = await requireOwner(deps, req);
    const body = parse(
      z.object({
        date: zDate,
        kind: z.enum(['closed', 'special_hours']),
        label: z.string().max(100).default(''),
        intervals: z.array(z.object({ startMin: z.number().int().min(0).max(1439), endMin: z.number().int().min(1).max(1440) })).max(10).default([]),
      }),
      req.body,
    );
    if (body.kind === 'special_hours' && (!body.intervals.length || body.intervals.some((i) => i.endMin <= i.startMin))) throw badRequest('特別営業の時間帯を正しく入力してください');
    const r = await pool.query(`INSERT INTO date_exceptions (business_id, date, kind, label, intervals) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [
      a.businessId,
      body.date,
      body.kind,
      body.label,
      JSON.stringify(body.kind === 'closed' ? [] : body.intervals),
    ]);
    // warn about existing bookings on that date (never cancelled automatically)
    const tz = (await getBusiness(pool, a.businessId)).timezone;
    const affected = await pool.query(
      `SELECT count(*)::int AS n FROM bookings WHERE business_id = $1 AND status IN ('confirmed','checked_in') AND (start_at AT TIME ZONE $3)::date = $2::date`,
      [a.businessId, body.date, tz],
    );
    await audit(pool, a.businessId, a.actor, 'exception.create', 'date_exception', r.rows[0].id, { date: body.date, kind: body.kind });
    return { id: r.rows[0].id, existingBookings: affected.rows[0].n };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/exceptions/:id', async (req) => {
    const a = await requireOwner(deps, req);
    const r = await pool.query(`DELETE FROM date_exceptions WHERE id = $1 AND business_id = $2 RETURNING date`, [parse(z.string().uuid(), req.params.id), a.businessId]);
    if (!r.rows[0]) throw notFound();
    await audit(pool, a.businessId, a.actor, 'exception.delete', 'date_exception', req.params.id, { date: r.rows[0].date });
    return { ok: true };
  });

  // ---------------------------------------------------------------- services
  const serviceDto = (s: Record<string, any>) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    category: s.category,
    durationMin: s.duration_min,
    bufferBeforeMin: s.buffer_before_min,
    bufferAfterMin: s.buffer_after_min,
    priceText: s.price_text,
    capacity: s.capacity,
    maxPartySize: s.max_party_size,
    requiresStaff: s.requires_staff,
    bookingMode: s.booking_mode,
    slotIntervalMin: s.slot_interval_min,
    acceptsBookings: s.accepts_bookings,
    isPublic: s.is_public,
    sortOrder: s.sort_order,
    notes: s.notes,
    archived: !!s.archived_at,
    staffIds: s.staff_ids ?? [],
    resourceIds: s.resource_ids ?? [],
  });

  app.get('/api/admin/services', async (req) => {
    const a = await requireMember(deps, req);
    const r = await pool.query(
      `SELECT s.*, COALESCE((SELECT array_agg(staff_id) FROM staff_services x WHERE x.service_id = s.id), '{}') AS staff_ids,
              COALESCE((SELECT array_agg(resource_id) FROM service_resources x WHERE x.service_id = s.id), '{}') AS resource_ids
         FROM services s WHERE s.business_id = $1 ORDER BY s.archived_at NULLS FIRST, s.sort_order, s.name`,
      [a.businessId],
    );
    return { services: r.rows.map(serviceDto) };
  });

  async function saveService(businessId: string, id: string | null, s: z.infer<typeof zService>): Promise<string> {
    if (s.maxPartySize > s.capacity) throw badRequest('1予約の最大人数は定員以下にしてください');
    return withTx(pool, async (tx) => {
      await lockBusiness(tx, businessId);
      await assertOwned(tx, 'staff', businessId, s.staffIds);
      await assertOwned(tx, 'resources', businessId, s.resourceIds);
      let sid = id;
      const vals = [s.name, s.description, s.category, s.durationMin, s.bufferBeforeMin, s.bufferAfterMin, s.priceText, s.capacity, s.maxPartySize, s.requiresStaff, s.bookingMode, s.slotIntervalMin, s.acceptsBookings, s.isPublic, s.sortOrder, s.notes];
      if (sid) {
        const r = await tx.query(
          `UPDATE services SET name=$3, description=$4, category=$5, duration_min=$6, buffer_before_min=$7, buffer_after_min=$8, price_text=$9, capacity=$10,
                  max_party_size=$11, requires_staff=$12, booking_mode=$13, slot_interval_min=$14, accepts_bookings=$15, is_public=$16, sort_order=$17, notes=$18, updated_at=now()
            WHERE id=$1 AND business_id=$2 RETURNING id`,
          [sid, businessId, ...vals],
        );
        if (!r.rows[0]) throw notFound('サービス');
      } else {
        sid = (
          await tx.query(
            `INSERT INTO services (business_id, name, description, category, duration_min, buffer_before_min, buffer_after_min, price_text, capacity, max_party_size,
                                   requires_staff, booking_mode, slot_interval_min, accepts_bookings, is_public, sort_order, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
            [businessId, ...vals],
          )
        ).rows[0].id as string;
      }
      await tx.query(`DELETE FROM staff_services WHERE service_id = $1`, [sid]);
      for (const st of s.staffIds) await tx.query(`INSERT INTO staff_services (business_id, staff_id, service_id) VALUES ($1,$2,$3)`, [businessId, st, sid]);
      await tx.query(`DELETE FROM service_resources WHERE service_id = $1`, [sid]);
      for (const r of s.resourceIds) await tx.query(`INSERT INTO service_resources (business_id, service_id, resource_id) VALUES ($1,$2,$3)`, [businessId, sid, r]);
      return sid!;
    });
  }

  app.post('/api/admin/services', async (req) => {
    const a = await requireOwner(deps, req);
    const s = parse(zService, req.body);
    const id = await saveService(a.businessId, null, s);
    await audit(pool, a.businessId, a.actor, 'service.create', 'service', id, { name: s.name });
    return { id };
  });

  app.put<{ Params: { id: string } }>('/api/admin/services/:id', async (req) => {
    const a = await requireOwner(deps, req);
    const s = parse(zService, req.body);
    const id = await saveService(a.businessId, parse(z.string().uuid(), req.params.id), s);
    await audit(pool, a.businessId, a.actor, 'service.update', 'service', id, { name: s.name, durationMin: s.durationMin, bufferBeforeMin: s.bufferBeforeMin, bufferAfterMin: s.bufferAfterMin });
    return { id };
  });

  for (const [table, entity] of [
    ['services', 'service'],
    ['staff', 'staff'],
    ['resources', 'resource'],
    ['questions', 'question'],
  ] as const) {
    app.post<{ Params: { id: string } }>(`/api/admin/${table}/:id/archive`, async (req) => {
      const a = await requireOwner(deps, req);
      const r = await pool.query(`UPDATE ${table} SET archived_at = now() WHERE id = $1 AND business_id = $2 AND archived_at IS NULL RETURNING id`, [parse(z.string().uuid(), req.params.id), a.businessId]);
      if (!r.rows[0]) throw notFound();
      await audit(pool, a.businessId, a.actor, `${entity}.archive`, entity, req.params.id, {});
      return { ok: true };
    });
    app.post<{ Params: { id: string } }>(`/api/admin/${table}/:id/restore`, async (req) => {
      const a = await requireOwner(deps, req);
      const r = await pool.query(`UPDATE ${table} SET archived_at = NULL WHERE id = $1 AND business_id = $2 RETURNING id`, [parse(z.string().uuid(), req.params.id), a.businessId]);
      if (!r.rows[0]) throw notFound();
      await audit(pool, a.businessId, a.actor, `${entity}.restore`, entity, req.params.id, {});
      return { ok: true };
    });
  }

  // ---------------------------------------------------------------- staff
  app.get('/api/admin/staff', async (req) => {
    const a = await requireMember(deps, req);
    const r = await pool.query(
      `SELECT s.*, COALESCE((SELECT array_agg(service_id) FROM staff_services x WHERE x.staff_id = s.id), '{}') AS service_ids,
              (SELECT json_agg(json_build_object('weekday', weekday, 'startMin', start_min, 'endMin', end_min) ORDER BY weekday, start_min) FROM weekly_hours w WHERE w.owner_kind = 'staff' AND w.owner_id = s.id) AS hours,
              (SELECT json_agg(json_build_object('weekday', weekday, 'startMin', start_min, 'endMin', end_min) ORDER BY weekday, start_min) FROM weekly_hours w WHERE w.owner_kind = 'staff_break' AND w.owner_id = s.id) AS breaks,
              (SELECT json_agg(json_build_object('userId', m.user_id, 'email', u.email, 'name', u.name)) FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.business_id = s.business_id AND m.staff_id = s.id) AS logins
         FROM staff s WHERE s.business_id = $1 ORDER BY s.archived_at NULLS FIRST, s.sort_order, s.display_name`,
      [a.businessId],
    );
    const owner = a.role === 'owner';
    return {
      staff: r.rows.map((s) => ({
        id: s.id,
        displayName: s.display_name,
        internalName: owner ? s.internal_name : undefined,
        email: owner ? s.email : undefined,
        profile: s.profile,
        acceptsBookings: s.accepts_bookings,
        usesBusinessHours: s.uses_business_hours,
        maxParticipants: s.max_participants,
        color: s.color,
        sortOrder: s.sort_order,
        archived: !!s.archived_at,
        serviceIds: s.service_ids,
        hours: s.hours ?? [],
        breaks: s.breaks ?? [],
        logins: owner ? (s.logins ?? []) : undefined,
      })),
    };
  });

  async function saveStaff(businessId: string, id: string | null, s: z.infer<typeof zStaff>): Promise<string> {
    return withTx(pool, async (tx) => {
      await lockBusiness(tx, businessId);
      await assertOwned(tx, 'services', businessId, s.serviceIds);
      const vals = [s.displayName, s.internalName, s.email ?? null, s.profile, s.acceptsBookings, s.usesBusinessHours, s.maxParticipants, s.color, s.sortOrder];
      let sid = id;
      if (sid) {
        const r = await tx.query(
          `UPDATE staff SET display_name=$3, internal_name=$4, email=$5, profile=$6, accepts_bookings=$7, uses_business_hours=$8, max_participants=$9, color=$10, sort_order=$11
            WHERE id=$1 AND business_id=$2 RETURNING id`,
          [sid, businessId, ...vals],
        );
        if (!r.rows[0]) throw notFound('スタッフ');
      } else {
        sid = (
          await tx.query(
            `INSERT INTO staff (business_id, display_name, internal_name, email, profile, accepts_bookings, uses_business_hours, max_participants, color, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [businessId, ...vals],
          )
        ).rows[0].id as string;
      }
      await tx.query(`DELETE FROM staff_services WHERE staff_id = $1`, [sid]);
      for (const sv of s.serviceIds) await tx.query(`INSERT INTO staff_services (business_id, staff_id, service_id) VALUES ($1,$2,$3)`, [businessId, sid, sv]);
      await replaceHours(tx, businessId, 'staff', sid!, s.usesBusinessHours ? [] : s.hours);
      await replaceHours(tx, businessId, 'staff_break', sid!, s.breaks);
      return sid!;
    });
  }

  app.post('/api/admin/staff', async (req) => {
    const a = await requireOwner(deps, req);
    const s = parse(zStaff, req.body);
    const id = await saveStaff(a.businessId, null, s);
    await audit(pool, a.businessId, a.actor, 'staff.create', 'staff', id, { displayName: s.displayName });
    return { id };
  });

  app.put<{ Params: { id: string } }>('/api/admin/staff/:id', async (req) => {
    const a = await requireOwner(deps, req);
    const s = parse(zStaff, req.body);
    const id = await saveStaff(a.businessId, parse(z.string().uuid(), req.params.id), s);
    await audit(pool, a.businessId, a.actor, 'staff.update', 'staff', id, { displayName: s.displayName, acceptsBookings: s.acceptsBookings });
    return { id };
  });

  // invite a login for a staff member (or another owner)
  app.post('/api/admin/invites', async (req) => {
    const a = await requireOwner(deps, req);
    const body = parse(
      z.object({
        email: z.string().trim().email().max(200),
        role: z.enum(['owner', 'staff']),
        staffId: z.string().uuid().nullable().default(null),
        permissions: z.object({ viewAllBookings: z.boolean(), manageBookings: z.boolean(), viewCustomers: z.boolean(), manageOwnBlocks: z.boolean() }).partial().default({}),
        sendEmail: z.boolean().default(true),
      }),
      req.body,
    );
    if (body.role === 'staff' && !body.staffId) throw badRequest('スタッフを選んでください');
    if (body.staffId) await assertOwned(pool, 'staff', a.businessId, [body.staffId]);
    const token = randomToken(32);
    const r = await pool.query(
      `INSERT INTO invites (business_id, token_hash, email, role, staff_id, permissions, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6, now() + interval '7 days', $7) RETURNING id`,
      [a.businessId, sha256Hex(token), body.email, body.role, body.staffId, JSON.stringify(body.permissions), a.userId],
    );
    if (body.sendEmail)
      await enqueue(pool, { businessId: a.businessId, kind: 'staff_invite', recipient: body.email, dedupeKey: `invite:${r.rows[0].id}`, payload: { sealedToken: sealSecret(deps.cfg.appSecret, token) } });
    await audit(pool, a.businessId, a.actor, 'member.invite', 'invite', r.rows[0].id, { role: body.role, staffId: body.staffId });
    return { inviteUrl: `${deps.cfg.publicBaseUrl}/invite#t=${token}`, expiresInDays: 7 };
  });

  app.get('/api/admin/members', async (req) => {
    const a = await requireOwner(deps, req);
    const r = await pool.query(
      `SELECT m.user_id, u.name, u.email, m.role, m.staff_id, m.permissions, s.display_name AS staff_name
         FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN staff s ON s.id = m.staff_id WHERE m.business_id = $1 ORDER BY m.role, u.name`,
      [a.businessId],
    );
    const inv = await pool.query(`SELECT id, email, role, expires_at, used_at FROM invites WHERE business_id = $1 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC`, [a.businessId]);
    return { members: r.rows, invites: inv.rows };
  });

  app.put<{ Params: { userId: string } }>('/api/admin/members/:userId', async (req) => {
    const a = await requireOwner(deps, req);
    const body = parse(
      z.object({ permissions: z.object({ viewAllBookings: z.boolean(), manageBookings: z.boolean(), viewCustomers: z.boolean(), manageOwnBlocks: z.boolean() }), staffId: z.string().uuid().nullable() }),
      req.body,
    );
    if (body.staffId) await assertOwned(pool, 'staff', a.businessId, [body.staffId]);
    const r = await pool.query(`UPDATE memberships SET permissions = $3, staff_id = $4 WHERE user_id = $1 AND business_id = $2 AND role = 'staff' RETURNING user_id`, [
      parse(z.string().uuid(), req.params.userId),
      a.businessId,
      JSON.stringify(body.permissions),
      body.staffId,
    ]);
    if (!r.rows[0]) throw notFound('スタッフのログイン');
    await audit(pool, a.businessId, a.actor, 'member.permissions', 'user', req.params.userId, body.permissions);
    return { ok: true };
  });

  app.delete<{ Params: { userId: string } }>('/api/admin/members/:userId', async (req) => {
    const a = await requireOwner(deps, req);
    const uid = parse(z.string().uuid(), req.params.userId);
    if (uid === a.userId) throw badRequest('自分自身は削除できません');
    const r = await pool.query(`DELETE FROM memberships WHERE user_id = $1 AND business_id = $2 RETURNING role`, [uid, a.businessId]);
    if (!r.rows[0]) throw notFound();
    await pool.query(`DELETE FROM sessions WHERE user_id = $1 AND business_id = $2`, [uid, a.businessId]);
    await audit(pool, a.businessId, a.actor, 'member.remove', 'user', uid, { role: r.rows[0].role });
    return { ok: true };
  });

  // ---------------------------------------------------------------- resources
  app.get('/api/admin/resources', async (req) => {
    const a = await requireMember(deps, req);
    const r = await pool.query(
      `SELECT r.*, COALESCE((SELECT array_agg(service_id) FROM service_resources x WHERE x.resource_id = r.id), '{}') AS service_ids,
              (SELECT json_agg(json_build_object('weekday', weekday, 'startMin', start_min, 'endMin', end_min) ORDER BY weekday, start_min) FROM weekly_hours w WHERE w.owner_kind = 'resource' AND w.owner_id = r.id) AS hours
         FROM resources r WHERE r.business_id = $1 ORDER BY r.archived_at NULLS FIRST, r.sort_order, r.name`,
      [a.businessId],
    );
    return {
      resources: r.rows.map((x) => ({
        id: x.id,
        name: x.name,
        kind: x.kind,
        quantity: x.quantity,
        personCapacity: x.person_capacity,
        hasHours: x.has_hours,
        hours: x.hours ?? [],
        sortOrder: x.sort_order,
        archived: !!x.archived_at,
        serviceIds: x.service_ids,
      })),
    };
  });

  async function saveResource(businessId: string, id: string | null, s: z.infer<typeof zResource>): Promise<string> {
    return withTx(pool, async (tx) => {
      await lockBusiness(tx, businessId);
      await assertOwned(tx, 'services', businessId, s.serviceIds);
      let rid = id;
      const vals = [s.name, s.kind, s.quantity, s.personCapacity, s.hasHours, s.sortOrder];
      if (rid) {
        const r = await tx.query(`UPDATE resources SET name=$3, kind=$4, quantity=$5, person_capacity=$6, has_hours=$7, sort_order=$8 WHERE id=$1 AND business_id=$2 RETURNING id`, [rid, businessId, ...vals]);
        if (!r.rows[0]) throw notFound('リソース');
      } else {
        rid = (await tx.query(`INSERT INTO resources (business_id, name, kind, quantity, person_capacity, has_hours, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [businessId, ...vals])).rows[0].id as string;
      }
      await tx.query(`DELETE FROM service_resources WHERE resource_id = $1`, [rid]);
      for (const sv of s.serviceIds) await tx.query(`INSERT INTO service_resources (business_id, service_id, resource_id) VALUES ($1,$2,$3)`, [businessId, sv, rid]);
      await replaceHours(tx, businessId, 'resource', rid!, s.hasHours ? s.hours : []);
      return rid!;
    });
  }

  app.post('/api/admin/resources', async (req) => {
    const a = await requireOwner(deps, req);
    const s = parse(zResource, req.body);
    const id = await saveResource(a.businessId, null, s);
    await audit(pool, a.businessId, a.actor, 'resource.create', 'resource', id, { name: s.name });
    return { id };
  });

  app.put<{ Params: { id: string } }>('/api/admin/resources/:id', async (req) => {
    const a = await requireOwner(deps, req);
    const s = parse(zResource, req.body);
    const id = await saveResource(a.businessId, parse(z.string().uuid(), req.params.id), s);
    await audit(pool, a.businessId, a.actor, 'resource.update', 'resource', id, { name: s.name, quantity: s.quantity });
    return { id };
  });

  // ---------------------------------------------------------------- questions
  app.get('/api/admin/questions', async (req) => {
    const a = await requireMember(deps, req);
    const r = await pool.query(
      `SELECT id, service_id AS "serviceId", type, label, help_text AS "helpText", required, options, sort_order AS "sortOrder", archived_at IS NOT NULL AS archived
         FROM questions WHERE business_id = $1 ORDER BY archived_at NULLS FIRST, sort_order, created_at`,
      [a.businessId],
    );
    return { questions: r.rows };
  });

  function normalizeOptions(type: string, options: Array<{ id?: string; label: string }>) {
    if (type !== 'single_choice' && type !== 'multi_choice') return [];
    if (options.length < 2) throw badRequest('選択肢を2つ以上入力してください');
    const seen = new Set<string>();
    return options.map((o) => {
      let id = o.id && /^[a-zA-Z0-9_-]{1,40}$/.test(o.id) ? o.id : randomToken(6);
      while (seen.has(id)) id = randomToken(6);
      seen.add(id);
      return { id, label: o.label };
    });
  }

  app.post('/api/admin/questions', async (req) => {
    const a = await requireOwner(deps, req);
    const q = parse(zQuestion, req.body);
    if (q.serviceId) await assertOwned(pool, 'services', a.businessId, [q.serviceId]);
    const r = await pool.query(
      `INSERT INTO questions (business_id, service_id, type, label, help_text, required, options, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [a.businessId, q.serviceId, q.type, q.label, q.helpText, q.required, JSON.stringify(normalizeOptions(q.type, q.options)), q.sortOrder],
    );
    await audit(pool, a.businessId, a.actor, 'question.create', 'question', r.rows[0].id, { type: q.type });
    return { id: r.rows[0].id };
  });

  app.put<{ Params: { id: string } }>('/api/admin/questions/:id', async (req) => {
    const a = await requireOwner(deps, req);
    const q = parse(zQuestion, req.body);
    if (q.serviceId) await assertOwned(pool, 'services', a.businessId, [q.serviceId]);
    // Editing never rewrites past answers: bookings keep their own snapshot of label/options.
    const r = await pool.query(
      `UPDATE questions SET service_id=$3, type=$4, label=$5, help_text=$6, required=$7, options=$8, sort_order=$9, updated_at=now() WHERE id=$1 AND business_id=$2 RETURNING id`,
      [parse(z.string().uuid(), req.params.id), a.businessId, q.serviceId, q.type, q.label, q.helpText, q.required, JSON.stringify(normalizeOptions(q.type, q.options)), q.sortOrder],
    );
    if (!r.rows[0]) throw notFound('質問');
    await audit(pool, a.businessId, a.actor, 'question.update', 'question', req.params.id, { type: q.type });
    return { id: req.params.id };
  });
}

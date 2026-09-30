import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { addDays, localDateOf, localToInstant, weekdayOf } from '../engine/time.js';
import { hashPassword } from '../lib/crypto.js';
import { SYSTEM } from '../services/audit.js';
import { cancelBooking, changeStatus, createBooking, rescheduleBooking } from '../services/bookings.js';
import { createRule } from '../services/recurrence.js';

export interface SampleResult {
  businessId: string;
  ownerUserId: string;
  staffUserId: string;
  slug: string;
  services: Record<'consult' | 'lesson' | 'photo' | 'workshop', string>;
  staff: Record<'aki' | 'mika', string>;
  resources: Record<'roomA' | 'studioB' | 'camera', string>;
  closedDate: string;
  halfDayDate: string;
  workshopAlmostFull: { occurrenceId: string; start: string } | null;
}

const TZ = 'Asia/Tokyo';

/** Next local date (>= from) whose weekday is not in `avoid`. */
function nextOpen(from: string, avoid: number[] = [3]): string {
  let d = from;
  while (avoid.includes(weekdayOf(d))) d = addDays(d, 1);
  return d;
}

/**
 * Fictional business "Sample Studio". Everything is created relative to `now`, so the sample is always current.
 * The business is flagged is_sample: notifications for it are never actually e-mailed.
 */
export async function seedSample(pool: pg.Pool, o: { ownerEmail: string; ownerPassword: string; staffEmail?: string; staffPassword?: string; slug?: string; now?: number }): Promise<SampleResult> {
  const now = o.now ?? Date.now();
  const slug = o.slug ?? 'sample-studio';
  const q = (sql: string, args: unknown[] = []) => pool.query(sql, args);
  const one = async (sql: string, args: unknown[] = []) => (await q(sql, args)).rows[0];

  const ownerHash = await hashPassword(o.ownerPassword);
  const owner = await one(
    `INSERT INTO users (email, email_normalized, name, password_hash) VALUES ($1, lower($1), 'サンプル オーナー', $2)
     ON CONFLICT (email_normalized) DO UPDATE SET password_hash = EXCLUDED.password_hash RETURNING id`,
    [o.ownerEmail, ownerHash],
  );
  const biz = await one(
    `INSERT INTO businesses (slug, name, brand_name, description, phone, email, timezone, slot_interval_min, min_notice_min, max_advance_days,
                             change_deadline_min, cancel_deadline_min, reminder_hours_before, theme_color, completion_message, notes, phone_requirement,
                             consent_text, published, is_sample, website_url)
     VALUES ($1, 'Sample Studio', 'Sample Studio（サンプル）', 'レッスン・撮影・オンライン相談の架空スタジオです。このページはデモ用のサンプルです。',
             '03-0000-0000', 'studio@example.com', $2, 30, 120, 60, 1440, 1440, 24, '#2f6f5e',
             'ご予約ありがとうございます。当日は5分前までにお越しください。', '・遅れる場合はお電話ください。\n・駐車場はありません。', 'optional',
             '予約内容の確認のため、入力した情報を事業者が利用することに同意します。', true, true, 'https://example.com')
     RETURNING id`,
    [slug, TZ],
  );
  const B = biz.id as string;
  await q(`INSERT INTO memberships (user_id, business_id, role) VALUES ($1,$2,'owner') ON CONFLICT DO NOTHING`, [owner.id, B]);

  // hours: Mon-Sun 10:00-19:00, Wednesday regular holiday
  for (const wd of [0, 1, 2, 4, 5, 6]) await q(`INSERT INTO weekly_hours (business_id, owner_kind, owner_id, weekday, start_min, end_min) VALUES ($1,'business',$1,$2,600,1140)`, [B, wd]);

  const res = async (name: string, kind: string, quantity = 1, personCapacity: number | null = null) =>
    (await one(`INSERT INTO resources (business_id, name, kind, quantity, person_capacity) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [B, name, kind, quantity, personCapacity])).id as string;
  const roomA = await res('Room A', 'room', 1, 8);
  const studioB = await res('Studio B', 'studio');
  const camera = await res('Camera Set 1', 'equipment');

  const svc = async (name: string, f: Record<string, unknown>) =>
    (
      await one(
        `INSERT INTO services (business_id, name, description, category, duration_min, buffer_before_min, buffer_after_min, price_text, capacity, max_party_size,
                               requires_staff, booking_mode, sort_order, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12,$13) RETURNING id`,
        [B, name, f.description, f.category, f.duration, f.before ?? 0, f.after ?? 0, f.price, f.capacity ?? 1, f.maxParty ?? 1, f.mode ?? 'slots', f.order, f.notes ?? ''],
      )
    ).id as string;
  const consult = await svc('30分オンライン相談', { description: 'ビデオ通話での相談です。URLは前日にお送りします。', category: '相談', duration: 30, after: 10, price: '3,300円', order: 1 });
  const lesson = await svc('60分個人レッスン', { description: 'Room A でのマンツーマンレッスン。', category: 'レッスン', duration: 60, before: 15, after: 15, price: '6,600円', order: 2, notes: '動きやすい服装でお越しください' });
  const photo = await svc('90分撮影', { description: 'Studio B と機材一式を使った撮影プラン。', category: '撮影', duration: 90, before: 15, after: 15, price: '22,000円〜', order: 3 });
  const workshop = await svc('6名定員ワークショップ', { description: '少人数制のワークショップ（開催日程から選択）。', category: 'ワークショップ', duration: 120, before: 15, after: 15, price: '4,400円/名', capacity: 6, maxParty: 3, mode: 'sessions', order: 4 });
  for (const [s, r] of [[lesson, roomA], [photo, studioB], [photo, camera], [workshop, roomA]]) await q(`INSERT INTO service_resources (business_id, service_id, resource_id) VALUES ($1,$2,$3)`, [B, s, r]);

  const staff = async (name: string, f: { profile: string; own?: boolean; order: number; color: string }) =>
    (await one(`INSERT INTO staff (business_id, display_name, internal_name, profile, uses_business_hours, sort_order, color) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [B, name, `${name}（社員）`, f.profile, !f.own, f.order, f.color])).id as string;
  const aki = await staff('Aki', { profile: 'レッスン・ワークショップ担当', own: true, order: 1, color: '#c0504d' });
  const mika = await staff('Mika', { profile: '撮影・相談担当', order: 2, color: '#4a7bd0' });
  // Aki works 09:30-19:00 (prep before opening) with a lunch break 12:30-13:30
  for (const wd of [0, 1, 2, 4, 5, 6]) {
    await q(`INSERT INTO weekly_hours (business_id, owner_kind, owner_id, weekday, start_min, end_min) VALUES ($1,'staff',$2,$3,570,1140)`, [B, aki, wd]);
    await q(`INSERT INTO weekly_hours (business_id, owner_kind, owner_id, weekday, start_min, end_min) VALUES ($1,'staff_break',$2,$3,750,810)`, [B, aki, wd]);
  }
  for (const [st, sv] of [[aki, consult], [aki, lesson], [aki, workshop], [mika, consult], [mika, photo], [mika, lesson]]) await q(`INSERT INTO staff_services (business_id, staff_id, service_id) VALUES ($1,$2,$3)`, [B, st, sv]);

  // questions
  await q(`INSERT INTO questions (business_id, service_id, type, label, required, options, sort_order) VALUES ($1,NULL,'single_choice','ご利用は初めてですか？',true,$2,1)`, [
    B,
    JSON.stringify([{ id: 'first', label: '初めて' }, { id: 'repeat', label: '2回目以降' }]),
  ]);
  await q(`INSERT INTO questions (business_id, service_id, type, label, help_text, required, sort_order) VALUES ($1,$2,'long_text','撮影のイメージ・ご希望','参考URLなどもどうぞ',false,2)`, [B, photo]);
  await q(`INSERT INTO questions (business_id, service_id, type, label, required, sort_order) VALUES ($1,NULL,'confirm','キャンセル・変更は前日までに予約管理リンクから行うことを確認しました',true,3)`, [B]);

  // exceptions relative to today
  const today = localDateOf(now, TZ);
  const closedDate = nextOpen(addDays(today, 9));
  await q(`INSERT INTO date_exceptions (business_id, date, kind, label) VALUES ($1,$2,'closed','臨時休業（設備点検）')`, [B, closedDate]);
  const specialDate = nextOpen(addDays(today, 16), []);
  await q(`INSERT INTO date_exceptions (business_id, date, kind, label, intervals) VALUES ($1,$2,'special_hours','短縮営業',$3)`, [B, specialDate, JSON.stringify([{ startMin: 600, endMin: 900 }])]);
  // Mika half-day off (afternoon) and a business block
  const halfDayDate = nextOpen(addDays(today, 5));
  await q(`INSERT INTO blocks (business_id, scope, target_id, start_at, end_at, reason) VALUES ($1,'staff',$2,$3,$4,'半休（午後）')`, [B, mika, new Date(localToInstant(halfDayDate, 13 * 60, TZ)), new Date(localToInstant(halfDayDate, 19 * 60, TZ))]);
  const blockDate = nextOpen(addDays(today, 6));
  await q(`INSERT INTO blocks (business_id, scope, target_id, start_at, end_at, reason) VALUES ($1,'resource',$2,$3,$4,'機材メンテナンス')`, [B, camera, new Date(localToInstant(blockDate, 10 * 60, TZ)), new Date(localToInstant(blockDate, 14 * 60, TZ))]);

  // weekly workshop: Saturday 13:00 with Aki
  const rule = await createRule(pool, B, { service_id: workshop, staff_id: aki, freq: 'weekly', interval_n: 1, weekdays: [6], nth: null, month_day: null, start_time_min: 13 * 60, start_date: today, end_date: null, capacity: null }, SYSTEM);
  void rule;

  // staff login for Aki
  let staffUserId = '';
  if (o.staffEmail && o.staffPassword) {
    const su = await one(
      `INSERT INTO users (email, email_normalized, name, password_hash) VALUES ($1, lower($1), 'Aki', $2)
       ON CONFLICT (email_normalized) DO UPDATE SET password_hash = EXCLUDED.password_hash RETURNING id`,
      [o.staffEmail, await hashPassword(o.staffPassword)],
    );
    staffUserId = su.id;
    await q(`INSERT INTO memberships (user_id, business_id, role, staff_id, permissions) VALUES ($1,$2,'staff',$3,$4) ON CONFLICT DO NOTHING`, [
      su.id,
      B,
      aki,
      JSON.stringify({ viewAllBookings: false, manageBookings: true, viewCustomers: true, manageOwnBlocks: true }),
    ]);
  }

  // bookings — created through the same booking service (same validation) with a simulated creation time
  const answersFor = async (serviceId: string) => {
    const qs = (await q(`SELECT id, type FROM questions WHERE business_id = $1 AND (service_id IS NULL OR service_id = $2)`, [B, serviceId])).rows;
    return qs.map((x) => ({ questionId: x.id, value: x.type === 'single_choice' ? 'first' : x.type === 'confirm' ? true : 'サンプル回答' }));
  };
  const people = [
    ['佐藤 美咲', 'misaki.sample@example.com', '090-1111-0001'],
    ['鈴木 健太', 'kenta.sample@example.com', '090-1111-0002'],
    ['高橋 優子', 'yuko.sample@example.com', null],
    ['田中 翔', 'sho.sample@example.com', '090-1111-0004'],
    ['伊藤 さくら', 'sakura.sample@example.com', '090-1111-0005'],
    ['渡辺 大輔', 'daisuke.sample@example.com', null],
    ['山本 彩', 'aya.sample@example.com', '090-1111-0007'],
  ] as const;
  const book = async (i: number, serviceId: string, staffId: string | null, date: string, hh: number, mm: number, createdAt: number, extra: Partial<Parameters<typeof createBooking>[1]> = {}) =>
    createBooking(pool, {
      businessId: B,
      serviceId,
      staffId,
      start: localToInstant(date, hh * 60 + mm, TZ),
      partySize: 1,
      customer: { name: people[i][0], email: people[i][1], phone: people[i][2] },
      answers: await answersFor(serviceId),
      source: 'public',
      mode: 'admin',
      actor: { type: 'customer' },
      idempotencyKey: randomUUID(),
      now: createdAt,
      ...extra,
    });

  const DAY = 86_400_000;
  // past: completed / no-show (created 10 days before)
  const past1 = nextOpen(addDays(today, -3));
  const b1 = await book(0, lesson, aki, past1, 10, 30, now - 10 * DAY);
  await changeStatus(pool, { businessId: B, bookingId: b1.bookingId, to: 'checked_in', actor: SYSTEM, now });
  await changeStatus(pool, { businessId: B, bookingId: b1.bookingId, to: 'completed', actor: SYSTEM, now });
  const b2 = await book(1, consult, mika, past1, 15, 0, now - 10 * DAY);
  await changeStatus(pool, { businessId: B, bookingId: b2.bookingId, to: 'no_show', actor: SYSTEM, now });
  // today (if open): upcoming bookings for reception demo
  const t0 = nextOpen(today);
  const hourNow = Number(new Date(now).toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }));
  if (t0 === today && hourNow < 17) {
    await book(2, consult, mika, today, Math.max(hourNow + 1, 11), 0, now - 2 * DAY, { source: 'phone' }).catch(() => null);
  }
  // future: normal, rescheduled, cancelled
  const d1 = nextOpen(addDays(today, 2));
  await book(3, lesson, aki, d1, 11, 0, now - DAY);
  const moved = await book(4, photo, mika, d1, 14, 0, now - DAY);
  await rescheduleBooking(pool, { businessId: B, bookingId: moved.bookingId, start: localToInstant(nextOpen(addDays(d1, 1)), 10 * 60 + 30, TZ), mode: 'admin', actor: SYSTEM, byCustomer: false });
  const cancelled = await book(5, lesson, mika, d1, 15, 0, now - DAY);
  // waitlist for that date, then cancellation frees the slot → candidate shown to the owner
  await q(
    `INSERT INTO waitlist_entries (business_id, name, email, phone, service_id, date_from, date_to, time_from_min, time_to_min, note, expires_at)
     VALUES ($1,'中村 陽','hinata.sample@example.com',NULL,$2,$3,$3,780,1080,'午後ならいつでも', now() + interval '30 days')`,
    [B, lesson, d1],
  );
  await cancelBooking(pool, { businessId: B, bookingId: cancelled.bookingId, by: 'customer', reason: '体調不良のため', actor: { type: 'customer' }, now: now - DAY / 2 });

  // workshop: 5 of 6 seats taken on the next occurrence
  const occ = (await q(`SELECT id, start_at FROM session_occurrences WHERE business_id = $1 AND start_at > $2 AND status = 'scheduled' ORDER BY start_at LIMIT 1`, [B, new Date(now + 3 * 3_600_000)])).rows[0];
  let workshopAlmostFull: SampleResult['workshopAlmostFull'] = null;
  if (occ) {
    const parties = [2, 2, 1];
    for (let i = 0; i < parties.length; i++)
      await createBooking(pool, {
        businessId: B,
        serviceId: workshop,
        staffId: null,
        occurrenceId: occ.id,
        partySize: parties[i],
        customer: { name: people[i + 4][0], email: people[i + 4][1], phone: people[i + 4][2] },
        answers: await answersFor(workshop),
        source: 'public',
        mode: 'admin',
        actor: { type: 'customer' },
        idempotencyKey: randomUUID(),
        now: now - DAY,
      });
    workshopAlmostFull = { occurrenceId: occ.id, start: occ.start_at.toISOString() };
  }
  // sample notifications are never delivered (is_sample) — mark the seeded ones as skipped for clarity
  await q(`UPDATE notifications SET status = 'skipped', last_error = 'サンプルデータのため送信しません' WHERE business_id = $1 AND status = 'pending'`, [B]);

  return {
    businessId: B,
    ownerUserId: owner.id,
    staffUserId,
    slug,
    services: { consult, lesson, photo, workshop },
    staff: { aki, mika },
    resources: { roomA, studioB, camera },
    closedDate,
    halfDayDate,
    workshopAlmostFull,
  };
}

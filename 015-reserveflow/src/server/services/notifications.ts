import nodemailer, { type Transporter } from 'nodemailer';
import type pg from 'pg';
import type { Config } from '../config.js';
import type { Queryable } from '../db/pool.js';
import { formatLocalJa } from '../engine/time.js';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { issueManageToken, manageUrl, revokeTokenByPlain } from './tokens.js';
import { getBusiness, type BusinessRow } from './loader.js';

export type NotificationKind =
  | 'booking_confirmed'
  | 'booking_changed'
  | 'booking_cancelled'
  | 'owner_new_booking'
  | 'owner_booking_changed'
  | 'owner_booking_cancelled'
  | 'reminder'
  | 'waitlist_opening'
  | 'manage_link'
  | 'staff_invite';

export const KIND_LABEL: Record<NotificationKind, string> = {
  booking_confirmed: '予約確定（お客様）',
  booking_changed: '予約変更（お客様）',
  booking_cancelled: 'キャンセル（お客様）',
  owner_new_booking: '新規予約（事業者）',
  owner_booking_changed: '予約変更（事業者）',
  owner_booking_cancelled: 'キャンセル（事業者）',
  reminder: 'リマインド（お客様）',
  waitlist_opening: '空き発生・待機候補（事業者）',
  manage_link: '予約管理リンク再発行（お客様）',
  staff_invite: 'スタッフ招待',
};

export interface EnqueueOpts {
  businessId: string;
  bookingId?: string | null;
  kind: NotificationKind;
  recipient: string | null | undefined;
  dedupeKey: string;
  scheduledAt?: Date;
  payload?: Record<string, unknown>;
}

/** Idempotent enqueue: the (business, dedupe_key) unique index makes re-runs harmless. */
export async function enqueue(q: Queryable, o: EnqueueOpts): Promise<boolean> {
  if (!o.recipient) return false;
  const r = await q.query(
    `INSERT INTO notifications (business_id, booking_id, kind, recipient, dedupe_key, scheduled_at, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (business_id, dedupe_key) DO NOTHING`,
    [o.businessId, o.bookingId ?? null, o.kind, o.recipient, o.dedupeKey, o.scheduledAt ?? new Date(), JSON.stringify(o.payload ?? {})],
  );
  return (r.rowCount ?? 0) > 0;
}

export function ownerRecipient(b: Pick<BusinessRow, 'owner_notify_email' | 'email' | 'notify_owner_new_booking'>): string | null {
  if (!b.notify_owner_new_booking) return null;
  return b.owner_notify_email || b.email || null;
}

/** Enqueue the reminder for a booking (idempotent per booking + start time). Skipped when already inside the window. */
export async function enqueueReminder(q: Queryable, business: BusinessRow, booking: { id: string; start_at: Date }, email: string | null, now = new Date()): Promise<void> {
  if (!email || business.reminder_hours_before <= 0) return;
  const at = new Date(booking.start_at.getTime() - business.reminder_hours_before * 3_600_000);
  if (at.getTime() <= now.getTime()) return;
  await enqueue(q, {
    businessId: business.id,
    bookingId: booking.id,
    kind: 'reminder',
    recipient: email,
    dedupeKey: `reminder:${booking.id}:${booking.start_at.toISOString()}`,
    scheduledAt: at,
  });
}

export async function cancelPendingForBooking(q: Queryable, bookingId: string, kinds: NotificationKind[] = ['reminder']): Promise<void> {
  await q.query(`UPDATE notifications SET status = 'cancelled' WHERE booking_id = $1 AND status IN ('pending','failed') AND kind = ANY($2)`, [bookingId, kinds]);
}

// ---------------------------------------------------------------------------
// secret payloads (staff invite token) – AES-256-GCM, purged after sending

function keyFrom(secret: string): Buffer {
  return createHash('sha256').update(`rf-payload:${secret}`).digest();
}

export function sealSecret(secret: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

export function openSecret(secret: string, sealed: string): string {
  const [iv, tag, enc] = sealed.split('.');
  const d = createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// templates (plain text only — no HTML is ever generated, so no HTML injection)

/** Remove control characters (keeps \n in bodies). */
export function clean(v: unknown, keepNewlines = false): string {
  const s = v === null || v === undefined ? '' : String(v);
  return keepNewlines ? s.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '') : s.replace(/[\u0000-\u001F\u007F]/g, ' ');
}

/** Expand {{var}} placeholders with sanitized values. Unknown variables become empty. */
export function renderTemplate(tpl: string, vars: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k: string) => clean(vars[k]));
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

interface BookingView {
  id: string;
  ref_code: string;
  status: string;
  start_at: Date;
  end_at: Date;
  party_size: number;
  service_name: string;
  staff_name: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  source: string;
  cancel_reason: string | null;
  rescheduled_from_start: Date | null;
}

async function loadBookingView(q: Queryable, bookingId: string): Promise<BookingView | null> {
  const r = await q.query<BookingView>(
    `SELECT b.id, b.ref_code, b.status, b.start_at, b.end_at, b.party_size, b.service_snapshot->>'name' AS service_name,
            s.display_name AS staff_name, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
            b.source, b.cancel_reason, pb.start_at AS rescheduled_from_start
       FROM bookings b JOIN customers c ON c.id = b.customer_id
       LEFT JOIN staff s ON s.id = b.staff_id
       LEFT JOIN bookings pb ON pb.id = b.rescheduled_from_id
      WHERE b.id = $1`,
    [bookingId],
  );
  return r.rows[0] ?? null;
}

function footer(b: BusinessRow): string {
  const lines = [`――――――――――`, clean(b.brand_name || b.name)];
  if (b.phone) lines.push(`電話: ${clean(b.phone)}`);
  if (b.email) lines.push(`メール: ${clean(b.email)}`);
  if (b.email_signature) lines.push(clean(b.email_signature, true));
  lines.push('※このメールは送信専用です。');
  return lines.join('\n');
}

function bookingLines(b: BusinessRow, v: BookingView): string {
  const tz = b.timezone;
  const lines = [
    `予約番号: ${v.ref_code}`,
    `日時: ${formatLocalJa(v.start_at.getTime(), tz)}〜${formatLocalJa(v.end_at.getTime(), tz).slice(-5)}（${tz}）`,
    `メニュー: ${clean(v.service_name)}`,
  ];
  if (v.staff_name) lines.push(`担当: ${clean(v.staff_name)}`);
  if (v.party_size > 1) lines.push(`人数: ${v.party_size}名`);
  return lines.join('\n');
}

export async function renderMail(
  q: Queryable,
  cfg: Config,
  n: { kind: NotificationKind; business_id: string; booking_id: string | null; recipient: string; payload: Record<string, unknown> },
  mintedTokens: string[],
): Promise<Mail | { skip: string }> {
  const b = await getBusiness(q, n.business_id);
  if (b.is_sample) return { skip: 'サンプル事業者のため送信しません' };
  const shop = clean(b.brand_name || b.name);
  const v = n.booking_id ? await loadBookingView(q, n.booking_id) : null;
  const to = n.recipient;
  const mintLink = async () => {
    if (!v) return '';
    const t = await issueManageToken(q, b.id, v.id, v.end_at);
    mintedTokens.push(t);
    return manageUrl(cfg.publicBaseUrl, t);
  };
  const deadlineNote = () =>
    `変更は開始の${Math.round(b.change_deadline_min / 60)}時間前、キャンセルは${Math.round(b.cancel_deadline_min / 60)}時間前まで上記リンクから手続きできます。`;

  switch (n.kind) {
    case 'booking_confirmed': {
      if (!v) return { skip: 'booking not found' };
      if (v.status !== 'confirmed') return { skip: `status ${v.status}` };
      const link = await mintLink();
      return {
        to,
        subject: `【${shop}】ご予約を承りました（${v.ref_code}）`,
        text: [`${clean(v.customer_name)} 様`, '', 'ご予約ありがとうございます。以下の内容で承りました。', '', bookingLines(b, v), '', '▼予約の確認・変更・キャンセル', link, deadlineNote(), '', b.notes ? `【注意事項】\n${clean(b.notes, true)}\n` : '', footer(b)].join('\n'),
      };
    }
    case 'booking_changed': {
      if (!v) return { skip: 'booking not found' };
      const link = await mintLink();
      return {
        to,
        subject: `【${shop}】ご予約の日時を変更しました（${v.ref_code}）`,
        text: [`${clean(v.customer_name)} 様`, '', 'ご予約の変更を承りました。変更後の内容は以下のとおりです。', '', bookingLines(b, v), v.rescheduled_from_start ? `（変更前: ${formatLocalJa(v.rescheduled_from_start.getTime(), b.timezone)}）` : '', '', '▼予約の確認・変更・キャンセル', link, '', footer(b)].join('\n'),
      };
    }
    case 'booking_cancelled': {
      if (!v) return { skip: 'booking not found' };
      return {
        to,
        subject: `【${shop}】ご予約のキャンセルを承りました（${v.ref_code}）`,
        text: [`${clean(v.customer_name)} 様`, '', v.status === 'cancelled_by_business' ? '誠に恐れ入りますが、以下のご予約はお店の都合によりキャンセルとなりました。' : '以下のご予約のキャンセルを承りました。', '', bookingLines(b, v), v.cancel_reason && v.status === 'cancelled_by_business' ? `理由: ${clean(v.cancel_reason)}` : '', '', 'またのご利用をお待ちしております。', '', footer(b)].join('\n'),
      };
    }
    case 'reminder': {
      if (!v) return { skip: 'booking not found' };
      if (v.status !== 'confirmed') return { skip: `status ${v.status}` };
      const link = await mintLink();
      return {
        to,
        subject: `【${shop}】ご予約日時のお知らせ（${formatLocalJa(v.start_at.getTime(), b.timezone)}）`,
        text: [`${clean(v.customer_name)} 様`, '', 'ご予約の日時が近づきましたのでお知らせします。', '', bookingLines(b, v), '', '▼予約の確認・変更・キャンセル', link, deadlineNote(), '', b.notes ? `【注意事項】\n${clean(b.notes, true)}\n` : '', footer(b)].join('\n'),
      };
    }
    case 'manage_link': {
      if (!v) return { skip: 'booking not found' };
      const link = await mintLink();
      return {
        to,
        subject: `【${shop}】予約管理リンクを再発行しました（${v.ref_code}）`,
        text: [`${clean(v.customer_name)} 様`, '', '予約の確認・変更・キャンセル用リンクを再発行しました。以前のリンクは使えなくなりました。', '', bookingLines(b, v), '', link, '', footer(b)].join('\n'),
      };
    }
    case 'owner_new_booking':
    case 'owner_booking_changed':
    case 'owner_booking_cancelled': {
      if (!v) return { skip: 'booking not found' };
      const title = n.kind === 'owner_new_booking' ? '新しい予約が入りました' : n.kind === 'owner_booking_changed' ? '予約が変更されました' : '予約がキャンセルされました';
      return {
        to,
        subject: `【ReserveFlow】${title}: ${formatLocalJa(v.start_at.getTime(), b.timezone)} ${clean(v.customer_name)} 様`,
        text: [title, '', bookingLines(b, v), `お客様: ${clean(v.customer_name)} 様`, `経路: ${clean(v.source)}`, '', `管理画面: ${cfg.publicBaseUrl}/app/bookings/${v.id}`].join('\n'),
      };
    }
    case 'waitlist_opening': {
      const count = Number(n.payload.count ?? 0);
      const when = typeof n.payload.start === 'string' ? formatLocalJa(Date.parse(n.payload.start), b.timezone) : '';
      return {
        to,
        subject: `【ReserveFlow】キャンセルで空きが出ました（待機候補 ${count} 件）`,
        text: [`${when} の枠が空きました。`, `待機リストに該当しそうな方が ${count} 件あります。`, '自動では予約されません。管理画面の「待機リスト」で候補を確認し、お客様へご連絡ください。', '', `${cfg.publicBaseUrl}/app/waitlist`].join('\n'),
      };
    }
    case 'staff_invite': {
      const sealed = n.payload.sealedToken;
      if (typeof sealed !== 'string') return { skip: 'invite token already purged' };
      const token = openSecret(cfg.appSecret, sealed);
      return {
        to,
        subject: `【ReserveFlow】${shop} の管理画面への招待`,
        text: [`${shop} の予約管理画面（ReserveFlow）に招待されました。`, '以下のリンクからパスワードを設定してください（7日間有効）。', '', `${cfg.publicBaseUrl}/invite#t=${token}`, '', '心当たりがない場合はこのメールを破棄してください。'].join('\n'),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// transport

export interface Mailer {
  send(m: Mail, from: string): Promise<string>;
}

/** Development / test driver: never sends. Keeps an in-memory outbox for tests. */
export class LogMailer implements Mailer {
  outbox: Mail[] = [];
  constructor(private readonly print = false) {}
  async send(m: Mail): Promise<string> {
    this.outbox.push(m);
    if (this.print) console.log(`[mail:log] to=${m.to} subject=${m.subject}`);
    return `log:${this.outbox.length}`;
  }
}

export class SmtpMailer implements Mailer {
  private transport: Transporter;
  constructor(url: string) {
    this.transport = nodemailer.createTransport(url);
  }
  async send(m: Mail, from: string): Promise<string> {
    const info = await this.transport.sendMail({ from, to: m.to, subject: clean(m.subject), text: m.text });
    return String(info.messageId ?? '');
  }
}

export function createMailer(cfg: Config): Mailer {
  if (cfg.emailDriver === 'smtp') {
    if (!cfg.smtpUrl) throw new Error('EMAIL_DRIVER=smtp には SMTP_URL が必要です');
    return new SmtpMailer(cfg.smtpUrl);
  }
  return new LogMailer(cfg.nodeEnv !== 'test');
}

// ---------------------------------------------------------------------------
// worker

const BACKOFF_MIN = [1, 5, 15, 60, 180];

export interface RunResult {
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
  staleMarkedUnknown: number;
}

/**
 * Process due notifications once. Safe to run concurrently / repeatedly:
 * rows are claimed with FOR UPDATE SKIP LOCKED and moved to 'sending' before the send,
 * so the same notification can never be sent twice by overlapping runs.
 * A row stuck in 'sending' (crash mid-send) becomes 'unknown' and is NOT resent automatically.
 */
export async function runNotificationsOnce(pool: pg.Pool, cfg: Config, mailer: Mailer, now = new Date(), batch = 25): Promise<RunResult> {
  const res: RunResult = { claimed: 0, sent: 0, failed: 0, skipped: 0, staleMarkedUnknown: 0 };
  const stale = await pool.query(
    `UPDATE notifications SET status = 'unknown', last_error = '送信処理中に中断されました（二重送信防止のため自動再送しません）'
      WHERE status = 'sending' AND claimed_at < $1::timestamptz - interval '10 minutes'`,
    [now],
  );
  res.staleMarkedUnknown = stale.rowCount ?? 0;

  const claimed = await pool.query(
    `UPDATE notifications SET status = 'sending', claimed_at = $1, attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM notifications
         WHERE status IN ('pending','failed') AND scheduled_at <= $1 AND attempts < max_attempts
           AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
         ORDER BY scheduled_at LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING id, business_id, booking_id, kind, recipient, payload, attempts, max_attempts`,
    [now, batch],
  );
  res.claimed = claimed.rowCount ?? 0;

  for (const n of claimed.rows) {
    const minted: string[] = [];
    try {
      const mail = await renderMail(pool, cfg, n, minted);
      if ('skip' in mail) {
        await pool.query(`UPDATE notifications SET status = 'skipped', last_error = $2 WHERE id = $1`, [n.id, mail.skip]);
        res.skipped++;
        continue;
      }
      const id = await mailer.send(mail, cfg.emailFrom);
      await pool.query(
        `UPDATE notifications SET status = 'sent', sent_at = now(), provider_message_id = $2, last_error = NULL,
                payload = payload - 'sealedToken' WHERE id = $1`,
        [n.id, id],
      );
      res.sent++;
    } catch (e) {
      for (const t of minted) await revokeTokenByPlain(pool, t).catch(() => {});
      const terminal = n.attempts >= n.max_attempts;
      const next = new Date(now.getTime() + BACKOFF_MIN[Math.min(n.attempts - 1, BACKOFF_MIN.length - 1)] * 60_000);
      await pool.query(
        `UPDATE notifications SET status = 'failed', last_error = $2, next_attempt_at = $3,
                payload = CASE WHEN $4 THEN payload - 'sealedToken' ELSE payload END WHERE id = $1`,
        [n.id, String((e as Error).message).slice(0, 500), terminal ? null : next, terminal],
      );
      res.failed++;
    }
  }
  return res;
}

export async function retryNotification(q: Queryable, businessId: string, id: string): Promise<boolean> {
  const r = await q.query(
    `UPDATE notifications SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL
      WHERE id = $1 AND business_id = $2 AND status IN ('failed','unknown')`,
    [id, businessId],
  );
  return (r.rowCount ?? 0) > 0;
}

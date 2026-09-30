import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { APP_VERSION, SCHEMA_VERSION } from '../config.js';
import { lockBusiness, withTx, type Queryable } from '../db/pool.js';
import { sha256Hex } from '../lib/crypto.js';
import { badRequest, conflict } from '../lib/errors.js';
import { audit, type Actor } from './audit.js';
import { enqueueReminder } from './notifications.js';
import { getBusiness } from './loader.js';

/** Tables in dependency order. Secrets (users, sessions, manage tokens, invites) are never exported. */
export const BACKUP_TABLES = [
  'weekly_hours',
  'date_exceptions',
  'services',
  'staff',
  'staff_services',
  'resources',
  'service_resources',
  'questions',
  'blocks',
  'customers',
  'recurrence_rules',
  'session_occurrences',
  'bookings',
  'allocations',
  'booking_status_history',
  'notifications',
  'waitlist_entries',
  'audit_logs',
] as const;
type Table = (typeof BACKUP_TABLES)[number];

const SETTINGS_COLUMNS = [
  'name', 'brand_name', 'description', 'phone', 'email', 'address', 'website_url', 'sns_url', 'timezone', 'week_start', 'slot_interval_min',
  'min_notice_min', 'max_advance_days', 'change_deadline_min', 'cancel_deadline_min', 'reminder_hours_before', 'theme_color', 'completion_message',
  'notes', 'phone_requirement', 'consent_text', 'email_signature', 'notify_owner_new_booking', 'owner_notify_email', 'logo_mime',
];

/** Columns holding user ids — users are environment specific, so they are cleared on restore. */
const USER_COLUMNS: Partial<Record<Table, string[]>> = {
  blocks: ['created_by'],
  bookings: ['created_by_user_id'],
  booking_status_history: ['actor_user_id'],
  audit_logs: ['actor_user_id'],
};

const JSONB_COLUMNS: Partial<Record<Table, string[]>> = {
  date_exceptions: ['intervals'],
  questions: ['options'],
  bookings: ['service_snapshot', 'answers'],
  notifications: ['payload'],
  audit_logs: ['summary'],
};

export interface BackupFile {
  format: 'reserveflow-backup';
  schemaVersion: number;
  appVersion: string;
  createdAt: string;
  sourceBusinessId: string;
  counts: Record<string, number>;
  settings: Record<string, unknown>;
  logoBase64: string | null;
  data: Record<Table, Array<Record<string, unknown>>>;
  sha256: string;
}

function canonical(data: unknown): string {
  return JSON.stringify(data);
}

async function dumpTable(q: Queryable, table: Table, businessId: string) {
  const order = table === 'weekly_hours' || table === 'allocations' || table === 'booking_status_history' || table === 'audit_logs' ? 'id' : 'ctid';
  const where = 'business_id = $1';
  // allocations.occupied is a range: export as text
  const cols = table === 'allocations' ? `id, business_id, booking_id, occurrence_id, kind, target_id, occupied::text AS occupied, session_key, active` : '*';
  const r = await q.query(`SELECT ${cols} FROM ${table} WHERE ${where} ORDER BY ${order}`, [businessId]);
  return r.rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) out[k] = v instanceof Date ? v.toISOString() : v;
    return out;
  });
}

export async function createBackup(pool: pg.Pool, businessId: string): Promise<BackupFile> {
  const client = await pool.connect();
  try {
    // consistent snapshot of all tables
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const biz = (await client.query(`SELECT ${SETTINGS_COLUMNS.join(', ')}, encode(logo, 'base64') AS logo_b64 FROM businesses WHERE id = $1`, [businessId])).rows[0];
    const data = {} as BackupFile['data'];
    const counts: Record<string, number> = {};
    for (const t of BACKUP_TABLES) {
      data[t] = await dumpTable(client, t, businessId);
      counts[t] = data[t].length;
    }
    await client.query('COMMIT');
    const settings: Record<string, unknown> = {};
    for (const c of SETTINGS_COLUMNS) settings[c] = biz[c];
    const logo = biz.logo_b64 ? String(biz.logo_b64).replace(/\n/g, '') : null;
    return {
      format: 'reserveflow-backup',
      schemaVersion: SCHEMA_VERSION,
      appVersion: APP_VERSION,
      createdAt: new Date().toISOString(),
      sourceBusinessId: businessId,
      counts,
      settings,
      logoBase64: logo,
      data,
      sha256: sha256Hex(canonical({ settings, logo, data })),
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export interface RestoreCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
  counts: Record<string, number>;
  schemaVersion?: number;
  appVersion?: string;
  createdAt?: string;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Validate a backup file without touching the database. */
export function validateBackup(file: unknown): RestoreCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const f = file as Partial<BackupFile>;
  if (!f || f.format !== 'reserveflow-backup') return { ok: false, errors: ['ReserveFlow のバックアップファイルではありません'], warnings, counts: {} };
  if (typeof f.schemaVersion !== 'number' || f.schemaVersion > SCHEMA_VERSION) errors.push(`このアプリより新しい形式（schemaVersion ${f.schemaVersion}）のため復元できません`);
  if (!f.data || !f.settings) errors.push('データ部分が欠けています');
  const counts: Record<string, number> = {};
  if (f.data) {
    for (const t of BACKUP_TABLES) {
      const rows = f.data[t];
      if (!Array.isArray(rows)) {
        errors.push(`${t} がありません`);
        continue;
      }
      counts[t] = rows.length;
      if (f.counts && f.counts[t] !== rows.length) errors.push(`${t} の件数が記録と一致しません（記録 ${f.counts[t]} / 実際 ${rows.length}）`);
    }
    if (!errors.length && f.sha256 !== sha256Hex(canonical({ settings: f.settings, logo: f.logoBase64 ?? null, data: f.data }))) errors.push('ファイルが破損しているか改変されています（チェックサム不一致）');
    if (!errors.length) {
      // referential integrity inside the file
      const ids = (t: Table) => new Set(f.data![t].map((r) => r.id as string));
      const customers = ids('customers');
      const services = ids('services');
      const staff = ids('staff');
      const bookings = ids('bookings');
      for (const b of f.data.bookings) {
        if (!customers.has(b.customer_id as string)) errors.push(`予約 ${b.ref_code} の顧客が見つかりません`);
        if (!services.has(b.service_id as string)) errors.push(`予約 ${b.ref_code} のサービスが見つかりません`);
        if (b.staff_id && !staff.has(b.staff_id as string)) errors.push(`予約 ${b.ref_code} のスタッフが見つかりません`);
      }
      for (const a of f.data.allocations) if (a.booking_id && !bookings.has(a.booking_id as string)) errors.push('占有データの参照先予約が見つかりません');
      if (errors.length > 20) errors.splice(20, errors.length - 20, '…（以下省略）');
    }
  }
  if (f.schemaVersion !== undefined && f.schemaVersion < SCHEMA_VERSION) warnings.push('古い形式のバックアップです（自動変換して復元します）');
  return { ok: errors.length === 0, errors, warnings, counts, schemaVersion: f.schemaVersion, appVersion: f.appVersion, createdAt: f.createdAt };
}

async function isEmptyBusiness(q: Queryable, businessId: string): Promise<boolean> {
  for (const t of ['services', 'staff', 'resources', 'customers', 'bookings'] as const) {
    const r = await q.query(`SELECT 1 FROM ${t} WHERE business_id = $1 LIMIT 1`, [businessId]);
    if (r.rows[0]) return false;
  }
  return true;
}

/**
 * Restore into an EMPTY business (e.g. a freshly created account in a new environment).
 * All ids are re-generated (so a restore never collides with the source), references are remapped,
 * and everything runs in one transaction: on any failure the current data stays unchanged.
 */
export async function restoreBackup(pool: pg.Pool, targetBusinessId: string, file: BackupFile, actor: Actor): Promise<Record<string, number>> {
  const check = validateBackup(file);
  if (!check.ok) throw badRequest('バックアップを復元できません', { errors: check.errors });
  return withTx(pool, async (tx) => {
    await lockBusiness(tx, targetBusinessId);
    if (!(await isEmptyBusiness(tx, targetBusinessId))) throw conflict('NOT_EMPTY', '復元先にデータがあります。空の事業者（新規作成直後）にのみ復元できます。');

    const map = new Map<string, string>([[file.sourceBusinessId, targetBusinessId]]);
    for (const t of BACKUP_TABLES) for (const row of file.data[t]) if (typeof row.id === 'string' && /^[0-9a-f-]{36}$/.test(row.id)) map.set(row.id, randomUUID());
    const remap = (v: unknown): unknown => {
      if (typeof v === 'string') return v.replace(UUID_RE, (m) => map.get(m) ?? m);
      if (Array.isArray(v)) return v.map(remap);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remap(x)]));
      return v;
    };

    // settings (slug & publish state of the target are kept; published is forced off for safety)
    const s = file.settings;
    const sets = SETTINGS_COLUMNS.map((c, i) => `${c} = $${i + 2}`).join(', ');
    await tx.query(`UPDATE businesses SET ${sets}, logo = $${SETTINGS_COLUMNS.length + 2}, published = false, updated_at = now() WHERE id = $1`, [
      targetBusinessId,
      ...SETTINGS_COLUMNS.map((c) => s[c] ?? null),
      file.logoBase64 ? Buffer.from(file.logoBase64, 'base64') : null,
    ]);

    const inserted: Record<string, number> = {};
    for (const t of BACKUP_TABLES) {
      let n = 0;
      for (const raw of file.data[t]) {
        const row = remap(raw) as Record<string, unknown>;
        row.business_id = targetBusinessId;
        for (const c of USER_COLUMNS[t] ?? []) row[c] = null;
        if (t === 'weekly_hours' || t === 'allocations' || t === 'booking_status_history' || t === 'audit_logs') delete row.id; // serial ids
        if (t === 'notifications' && (row.status === 'pending' || row.status === 'failed' || row.status === 'sending')) {
          row.status = 'skipped';
          row.last_error = 'バックアップから復元（未送信分は再送しません）';
        }
        if (t === 'notifications') row.payload = {};
        const cols = Object.keys(row);
        const jsonCols = JSONB_COLUMNS[t] ?? [];
        const vals = cols.map((c) => (jsonCols.includes(c) && row[c] !== null ? JSON.stringify(row[c]) : row[c]));
        const ph = cols.map((c, i) => (t === 'allocations' && c === 'occupied' ? `$${i + 1}::tstzrange` : `$${i + 1}`));
        // bookings reference each other (rescheduled_from/to): insert without them, then patch
        if (t === 'bookings') {
          const fi = cols.indexOf('rescheduled_from_id');
          const ti = cols.indexOf('rescheduled_to_id');
          if (fi >= 0) vals[fi] = null;
          if (ti >= 0) vals[ti] = null;
        }
        await tx.query(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${ph.join(', ')})`, vals);
        n++;
      }
      inserted[t] = n;
    }
    for (const raw of file.data.bookings) {
      if (raw.rescheduled_from_id || raw.rescheduled_to_id)
        await tx.query(`UPDATE bookings SET rescheduled_from_id = $2, rescheduled_to_id = $3 WHERE id = $1`, [
          map.get(raw.id as string),
          raw.rescheduled_from_id ? map.get(raw.rescheduled_from_id as string) : null,
          raw.rescheduled_to_id ? map.get(raw.rescheduled_to_id as string) : null,
        ]);
    }
    // re-create reminders for upcoming bookings in the new environment
    const biz = await getBusiness(tx, targetBusinessId);
    const upcoming = await tx.query(`SELECT b.id, b.start_at, c.email FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.business_id = $1 AND b.status = 'confirmed' AND b.start_at > now()`, [targetBusinessId]);
    for (const b of upcoming.rows) await enqueueReminder(tx, biz, b, b.email);
    await audit(tx, targetBusinessId, actor, 'backup.restore', 'business', targetBusinessId, { sourceCreatedAt: file.createdAt, schemaVersion: file.schemaVersion, counts: inserted });
    return inserted;
  });
}

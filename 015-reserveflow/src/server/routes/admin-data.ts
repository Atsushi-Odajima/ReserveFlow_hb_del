import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { lockBusiness, withTx } from '../db/pool.js';
import { dayRange, diffDays, formatLocal } from '../engine/time.js';
import { sha256Hex } from '../lib/crypto.js';
import { csvUnsafe, parseCsv, toCsv } from '../lib/csv.js';
import { badRequest, conflict } from '../lib/errors.js';
import { normEmail, normName } from '../lib/normalize.js';
import { audit } from '../services/audit.js';
import { createBackup, restoreBackup, validateBackup, type BackupFile } from '../services/backup.js';
import { createCustomerRecord } from '../services/bookings.js';
import { buildIcs } from '../services/ics.js';
import { getBusiness } from '../services/loader.js';
import { KIND_LABEL, retryNotification } from '../services/notifications.js';
import { parse, requireOwner, zDate, type AppDeps } from '../http.js';

export const STATUS_LABEL: Record<string, string> = {
  confirmed: '予約確定',
  checked_in: '来店/開始済み',
  completed: '完了',
  cancelled_by_customer: '顧客キャンセル',
  cancelled_by_business: '事業者キャンセル',
  no_show: '無断欠席',
  rescheduled: '変更済み',
};
const SOURCE_LABEL: Record<string, string> = { public: '公開予約ページ', phone: '電話', walk_in: '店頭', dm: 'DM/SNS', email: 'メール', admin: '管理画面', other: 'その他' };
const WD = ['日', '月', '火', '水', '木', '金', '土'];

const CUSTOMER_HEADERS = ['氏名', 'メール', '電話', 'メモ', 'タグ'];
const SERVICE_HEADERS = ['名称', '説明', 'カテゴリ', '所要時間(分)', '準備(分)', '片付け(分)', '価格表示', '定員', '1予約最大人数', '公開(1/0)'];

interface ImportRow {
  line: number;
  values: Record<string, string>;
  errors: string[];
  duplicate?: string;
}

export function registerAdminDataRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { pool } = deps;

  // ---------------------------------------------------------------- analytics
  app.get('/api/admin/analytics', async (req) => {
    const a = await requireOwner(deps, req);
    const q = parse(z.object({ from: zDate, to: zDate }), req.query);
    if (q.to < q.from || diffDays(q.from, q.to) > 366) throw badRequest('期間は366日以内で指定してください');
    const biz = await getBusiness(pool, a.businessId);
    const tz = biz.timezone;
    const from = new Date(dayRange(q.from, tz).start);
    const to = new Date(dayRange(q.to, tz).end);
    const base = `FROM bookings b WHERE b.business_id = $1 AND b.start_at >= $2 AND b.start_at < $3`;
    const args = [a.businessId, from, to];
    const totals = (
      await pool.query(
        `SELECT count(*) FILTER (WHERE status <> 'rescheduled')::int AS bookings,
                count(*) FILTER (WHERE status = 'completed')::int AS completed,
                count(*) FILTER (WHERE status = 'cancelled_by_customer')::int AS "cancelledByCustomer",
                count(*) FILTER (WHERE status = 'cancelled_by_business')::int AS "cancelledByBusiness",
                count(*) FILTER (WHERE status = 'no_show')::int AS "noShow",
                count(*) FILTER (WHERE status = 'rescheduled')::int AS reschedules,
                count(*) FILTER (WHERE status IN ('completed','no_show','checked_in'))::int AS "heldOrMissed",
                COALESCE(sum(party_size) FILTER (WHERE status IN ('confirmed','checked_in','completed','no_show')), 0)::int AS participants
           ${base}`,
        args,
      )
    ).rows[0];
    const group = async (expr: string, label: string) =>
      (
        await pool.query(
          `SELECT ${expr} AS key, ${label} AS label, count(*) FILTER (WHERE status <> 'rescheduled')::int AS bookings,
                  count(*) FILTER (WHERE status = 'completed')::int AS completed,
                  count(*) FILTER (WHERE status IN ('cancelled_by_customer','cancelled_by_business'))::int AS cancelled,
                  count(*) FILTER (WHERE status = 'no_show')::int AS "noShow"
             ${base.replace('FROM bookings b', 'FROM bookings b LEFT JOIN staff st ON st.id = b.staff_id')} GROUP BY 1, 2 ORDER BY 1`,
          [...args, tz],
        )
      ).rows;
    const byService = await group(`b.service_id::text`, `b.service_snapshot->>'name'`);
    const byStaff = await group(`COALESCE(b.staff_id::text, '-')`, `COALESCE(st.display_name, '（担当なし）')`);
    const byWeekday = (await group(`extract(dow FROM b.start_at AT TIME ZONE $4)::int`, `''`)).map((r) => ({ ...r, label: WD[r.key] }));
    const byHour = (await group(`extract(hour FROM b.start_at AT TIME ZONE $4)::int`, `''`)).map((r) => ({ ...r, label: `${r.key}時台` }));
    const bySource = (await group(`b.source`, `''`)).map((r) => ({ ...r, label: SOURCE_LABEL[r.key] ?? r.key }));
    const waitlist = (await pool.query(`SELECT count(*)::int AS n FROM waitlist_entries WHERE business_id = $1 AND created_at >= $2 AND created_at < $3`, args)).rows[0].n;
    const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
    return {
      period: { from: q.from, to: q.to, timezone: tz },
      totals: { ...totals, waitlist },
      rates: {
        cancelRate: { value: pct(totals.cancelledByCustomer + totals.cancelledByBusiness, totals.bookings), formula: 'キャンセル件数（顧客＋事業者）÷ 予約件数（開始日時が期間内・変更済みの旧予約を除く）' },
        noShowRate: { value: pct(totals.noShow, totals.heldOrMissed), formula: '無断欠席 ÷（完了＋来店/開始済み＋無断欠席）。期間内に開始した予約が対象' },
        completionRate: { value: pct(totals.completed, totals.bookings), formula: '完了 ÷ 予約件数（開始日時が期間内）' },
      },
      byService,
      byStaff,
      byWeekday,
      byHour,
      bySource,
      note: '件数は予約の「開始日時」が期間内（事業者タイムゾーン）のものを数えています。売上・会計の集計は行いません。',
    };
  });

  // ---------------------------------------------------------------- CSV export
  app.get<{ Params: { kind: string } }>('/api/admin/export/:kind', async (req, reply) => {
    const a = await requireOwner(deps, req);
    const kind = parse(z.enum(['bookings.csv', 'cancellations.csv', 'customers.csv', 'services.csv', 'staff.csv', 'bookings.ics']), req.params.kind);
    const q = parse(z.object({ from: zDate.optional(), to: zDate.optional() }), req.query);
    const biz = await getBusiness(pool, a.businessId);
    const tz = biz.timezone;
    const range = q.from && q.to ? [new Date(dayRange(q.from, tz).start), new Date(dayRange(q.to, tz).end)] : [new Date(0), new Date('9999-12-31')];
    const fmt = (d: Date | null) => (d ? formatLocal(d.getTime(), tz, 'yyyy-MM-dd HH:mm') : '');
    let body: string;
    if (kind === 'bookings.csv' || kind === 'cancellations.csv') {
      const statusFilter = kind === 'cancellations.csv' ? `AND b.status IN ('cancelled_by_customer','cancelled_by_business','no_show')` : '';
      const r = await pool.query(
        `SELECT b.ref_code, b.status, b.start_at, b.end_at, b.party_size, b.source, b.service_snapshot->>'name' AS service, st.display_name AS staff,
                c.customer_no, c.name, c.email, c.phone, b.customer_note, b.staff_note, b.cancel_reason, b.forced, b.created_at, b.answers
           FROM bookings b JOIN customers c ON c.id = b.customer_id LEFT JOIN staff st ON st.id = b.staff_id
          WHERE b.business_id = $1 AND b.start_at >= $2 AND b.start_at < $3 ${statusFilter} ORDER BY b.start_at`,
        [a.businessId, ...range],
      );
      body = toCsv(
        ['予約番号', '状態', '開始', '終了', '人数', '経路', 'サービス', '担当', '顧客番号', '氏名', 'メール', '電話', 'お客様メモ', 'スタッフメモ', 'キャンセル理由', '強制予約', '作成日時', '事前質問回答', 'タイムゾーン'],
        r.rows.map((x) => [
          x.ref_code, STATUS_LABEL[x.status] ?? x.status, fmt(x.start_at), fmt(x.end_at), x.party_size, SOURCE_LABEL[x.source] ?? x.source, x.service, x.staff ?? '',
          x.customer_no, x.name, x.email ?? '', x.phone ?? '', x.customer_note, x.staff_note, x.cancel_reason ?? '', x.forced ? '1' : '', fmt(x.created_at),
          (x.answers as Array<{ label: string; display: string }>).map((an) => `${an.label}: ${an.display}`).join(' / '), tz,
        ]),
      );
    } else if (kind === 'customers.csv') {
      const r = await pool.query(
        `SELECT c.customer_no, c.name, c.email, c.phone, c.admin_note, c.tags, c.created_at, c.archived_at,
                count(b.id) FILTER (WHERE b.status <> 'rescheduled')::int AS total, count(b.id) FILTER (WHERE b.status = 'completed')::int AS completed,
                count(b.id) FILTER (WHERE b.status IN ('cancelled_by_customer','cancelled_by_business'))::int AS cancelled, count(b.id) FILTER (WHERE b.status = 'no_show')::int AS no_show,
                min(b.start_at) FILTER (WHERE b.status <> 'rescheduled') AS first_at, max(b.start_at) FILTER (WHERE b.status <> 'rescheduled') AS last_at
           FROM customers c LEFT JOIN bookings b ON b.customer_id = c.id WHERE c.business_id = $1 AND c.anonymized_at IS NULL GROUP BY c.id ORDER BY c.customer_no`,
        [a.businessId],
      );
      body = toCsv(
        [...CUSTOMER_HEADERS, '顧客番号', '予約数', '完了', 'キャンセル', '無断欠席', '初回予約', '最終予約', '登録日時', 'アーカイブ'],
        r.rows.map((x) => [x.name, x.email ?? '', x.phone ?? '', x.admin_note, x.tags.join(';'), x.customer_no, x.total, x.completed, x.cancelled, x.no_show, fmt(x.first_at), fmt(x.last_at), fmt(x.created_at), x.archived_at ? '1' : '']),
      );
    } else if (kind === 'services.csv') {
      const r = await pool.query(`SELECT * FROM services WHERE business_id = $1 AND archived_at IS NULL ORDER BY sort_order, name`, [a.businessId]);
      body = toCsv(SERVICE_HEADERS, r.rows.map((s) => [s.name, s.description, s.category, s.duration_min, s.buffer_before_min, s.buffer_after_min, s.price_text, s.capacity, s.max_party_size, s.is_public ? 1 : 0]));
    } else if (kind === 'staff.csv') {
      const r = await pool.query(
        `SELECT s.display_name, s.internal_name, s.email, s.accepts_bookings, s.archived_at, (SELECT string_agg(sv.name, ';') FROM staff_services x JOIN services sv ON sv.id = x.service_id WHERE x.staff_id = s.id) AS services
           FROM staff s WHERE s.business_id = $1 ORDER BY s.sort_order`,
        [a.businessId],
      );
      body = toCsv(['表示名', '内部名', 'メール', '受付', '対応サービス', 'アーカイブ'], r.rows.map((s) => [s.display_name, s.internal_name, s.email ?? '', s.accepts_bookings ? '1' : '0', s.services ?? '', s.archived_at ? '1' : '']));
    } else {
      const r = await pool.query(
        `SELECT b.ref_code, b.start_at, b.end_at, b.status, b.service_snapshot->>'name' AS service, c.name, st.display_name AS staff
           FROM bookings b JOIN customers c ON c.id = b.customer_id LEFT JOIN staff st ON st.id = b.staff_id
          WHERE b.business_id = $1 AND b.start_at >= $2 AND b.start_at < $3 AND b.status IN ('confirmed','checked_in','completed') ORDER BY b.start_at`,
        [a.businessId, ...range],
      );
      body = buildIcs(r.rows.map((x) => ({ uid: `${x.ref_code}@reserveflow`, start: x.start_at, end: x.end_at, summary: `${x.service} ${x.name}様${x.staff ? `（${x.staff}）` : ''}`, description: `予約番号 ${x.ref_code}` })));
    }
    await audit(pool, a.businessId, a.actor, 'data.export', 'business', a.businessId, { kind, from: q.from, to: q.to });
    reply
      .header('Content-Type', kind.endsWith('.ics') ? 'text/calendar; charset=utf-8' : 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="reserveflow-${kind}"`)
      .header('Cache-Control', 'no-store');
    return body;
  });

  app.get<{ Params: { kind: string } }>('/api/admin/templates/:kind', async (req, reply) => {
    await requireOwner(deps, req);
    const kind = parse(z.enum(['customers.csv', 'services.csv']), req.params.kind);
    const body =
      kind === 'customers.csv'
        ? toCsv(CUSTOMER_HEADERS, [['山田 花子', 'hanako@example.com', '090-0000-0000', '初回はカウンセリング希望', 'VIP;紹介']])
        : toCsv(SERVICE_HEADERS, [['60分 個人レッスン', '初心者歓迎', 'レッスン', 60, 10, 10, '6,000円', 1, 1, 1]]);
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="template-${kind}"`);
    return body;
  });

  // ---------------------------------------------------------------- CSV import (preview → validate → confirm)
  function analyze(kind: 'customers' | 'services', text: string): { rows: ImportRow[]; headerError: string | null } {
    const table = parseCsv(text);
    const headers = kind === 'customers' ? CUSTOMER_HEADERS : SERVICE_HEADERS;
    if (!table.length) return { rows: [], headerError: 'データがありません' };
    const head = table[0].map((h) => h.trim());
    const missing = headers.filter((h, i) => (kind === 'customers' ? i === 0 : i === 0 || i === 3) && !head.includes(h));
    if (missing.length) return { rows: [], headerError: `必須の列がありません: ${missing.join(', ')}` };
    if (table.length - 1 > 5000) return { rows: [], headerError: '一度に取り込めるのは5,000行までです' };
    const rows: ImportRow[] = [];
    for (let i = 1; i < table.length; i++) {
      const values: Record<string, string> = {};
      head.forEach((h, j) => (values[h] = csvUnsafe((table[i][j] ?? '').trim())));
      const errors: string[] = [];
      if (kind === 'customers') {
        if (!values['氏名']) errors.push('氏名が空です');
        if (values['氏名']?.length > 100) errors.push('氏名は100文字以内');
        if (values['メール'] && !z.string().email().safeParse(values['メール']).success) errors.push('メールの形式が正しくありません');
        if (values['電話'] && !/^[0-9０-９+\-()\s]{0,30}$/.test(values['電話'])) errors.push('電話番号の形式が正しくありません');
      } else {
        if (!values['名称']) errors.push('名称が空です');
        const num = (k: string, min: number, max: number, def?: number) => {
          const v = values[k];
          if ((v === undefined || v === '') && def !== undefined) return;
          const n = Number(v);
          if (!Number.isInteger(n) || n < min || n > max) errors.push(`${k} は${min}〜${max}の整数`);
        };
        num('所要時間(分)', 5, 1440);
        num('準備(分)', 0, 240, 0);
        num('片付け(分)', 0, 240, 0);
        num('定員', 1, 500, 1);
        num('1予約最大人数', 1, 500, 1);
        if (Number(values['1予約最大人数'] || 1) > Number(values['定員'] || 1)) errors.push('1予約最大人数は定員以下');
      }
      rows.push({ line: i + 1, values, errors });
    }
    return { rows, headerError: null };
  }

  async function markDuplicates(businessId: string, kind: 'customers' | 'services', rows: ImportRow[]) {
    if (kind === 'customers') {
      const existing = await pool.query(`SELECT name_normalized, email_normalized FROM customers WHERE business_id = $1 AND anonymized_at IS NULL`, [businessId]);
      const keys = new Set(existing.rows.map((r) => `${r.name_normalized}|${r.email_normalized ?? ''}`));
      const inFile = new Set<string>();
      for (const r of rows) {
        const k = `${normName(r.values['氏名'] ?? '')}|${normEmail(r.values['メール']) ?? ''}`;
        if (keys.has(k)) r.duplicate = '同じ氏名・メールの顧客が既にいます（取り込みません）';
        else if (inFile.has(k)) r.duplicate = 'ファイル内で重複しています（取り込みません）';
        inFile.add(k);
      }
    } else {
      const existing = new Set((await pool.query(`SELECT name FROM services WHERE business_id = $1 AND archived_at IS NULL`, [businessId])).rows.map((r) => r.name));
      for (const r of rows) if (existing.has(r.values['名称'])) r.duplicate = '同名のサービスが既にあります（取り込みません）';
    }
  }

  app.post<{ Params: { kind: string } }>('/api/admin/import/:kind/preview', async (req) => {
    const a = await requireOwner(deps, req);
    const kind = parse(z.enum(['customers', 'services']), req.params.kind);
    const { csv } = parse(z.object({ csv: z.string().max(5_000_000) }), req.body);
    const hash = sha256Hex(csv);
    const already = (await pool.query(`SELECT created_at FROM import_batches WHERE business_id = $1 AND kind = $2 AND file_sha256 = $3`, [a.businessId, kind, hash])).rows[0];
    const { rows, headerError } = analyze(kind, csv);
    if (!headerError) await markDuplicates(a.businessId, kind, rows);
    return {
      fileHash: hash,
      alreadyImportedAt: already?.created_at ?? null,
      headerError,
      total: rows.length,
      valid: rows.filter((r) => !r.errors.length && !r.duplicate).length,
      errorRows: rows.filter((r) => r.errors.length).length,
      duplicateRows: rows.filter((r) => r.duplicate).length,
      rows: rows.slice(0, 500),
    };
  });

  app.post<{ Params: { kind: string } }>('/api/admin/import/:kind/commit', async (req) => {
    const a = await requireOwner(deps, req);
    const kind = parse(z.enum(['customers', 'services']), req.params.kind);
    const { csv, fileHash } = parse(z.object({ csv: z.string().max(5_000_000), fileHash: z.string().length(64) }), req.body);
    const hash = sha256Hex(csv);
    if (hash !== fileHash) throw badRequest('プレビューしたファイルと内容が異なります。もう一度プレビューしてください。');
    const { rows, headerError } = analyze(kind, csv);
    if (headerError) throw badRequest(headerError);
    if (rows.some((r) => r.errors.length)) throw badRequest('エラーのある行があります。修正してから取り込んでください。');
    await markDuplicates(a.businessId, kind, rows);
    const target = rows.filter((r) => !r.duplicate);
    return withTx(pool, async (tx) => {
      await lockBusiness(tx, a.businessId);
      try {
        await tx.query(`INSERT INTO import_batches (business_id, kind, file_sha256, row_count, created_by) VALUES ($1,$2,$3,$4,$5)`, [a.businessId, kind, hash, target.length, a.userId]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw conflict('ALREADY_IMPORTED', 'このファイルは既に取り込み済みです（二重取込防止）');
        throw e;
      }
      for (const r of target) {
        const v = r.values;
        if (kind === 'customers') {
          await createCustomerRecord(tx, a.businessId, {
            name: v['氏名'],
            email: v['メール'] || null,
            phone: v['電話'] || null,
            adminNote: v['メモ'] ?? '',
            tags: (v['タグ'] ?? '').split(/[;；]/).map((t) => t.trim()).filter(Boolean).slice(0, 20),
          });
        } else {
          await tx.query(
            `INSERT INTO services (business_id, name, description, category, duration_min, buffer_before_min, buffer_after_min, price_text, capacity, max_party_size, is_public)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [a.businessId, v['名称'], v['説明'] ?? '', v['カテゴリ'] ?? '', Number(v['所要時間(分)']), Number(v['準備(分)'] || 0), Number(v['片付け(分)'] || 0), v['価格表示'] ?? '', Number(v['定員'] || 1), Number(v['1予約最大人数'] || 1), (v['公開(1/0)'] ?? '1') !== '0'],
          );
        }
      }
      await audit(tx, a.businessId, a.actor, 'data.import', kind, null, { rows: target.length, skippedDuplicates: rows.length - target.length, fileHash: hash.slice(0, 16) });
      return { imported: target.length, skippedDuplicates: rows.length - target.length };
    });
  });

  // ---------------------------------------------------------------- backup / restore
  app.get('/api/admin/backup', async (req, reply) => {
    const a = await requireOwner(deps, req);
    const file = await createBackup(pool, a.businessId);
    await audit(pool, a.businessId, a.actor, 'backup.create', 'business', a.businessId, { counts: file.counts });
    reply.header('Content-Disposition', `attachment; filename="reserveflow-backup-${file.createdAt.slice(0, 10)}.json"`).header('Cache-Control', 'no-store');
    return file;
  });

  app.post('/api/admin/restore/preview', { bodyLimit: 200 * 1024 * 1024 }, async (req) => {
    await requireOwner(deps, req);
    const body = req.body as { file?: unknown };
    return validateBackup(body?.file);
  });

  app.post('/api/admin/restore/commit', { bodyLimit: 200 * 1024 * 1024 }, async (req) => {
    const a = await requireOwner(deps, req);
    const body = req.body as { file?: BackupFile; confirm?: boolean };
    if (body?.confirm !== true) throw badRequest('確認が必要です');
    const counts = await restoreBackup(pool, a.businessId, body.file as BackupFile, a.actor);
    return { ok: true, counts };
  });

  // ---------------------------------------------------------------- notifications / audit
  app.get('/api/admin/notifications', async (req) => {
    const a = await requireOwner(deps, req);
    const q = parse(z.object({ status: z.string().max(100).optional(), page: z.coerce.number().int().min(1).max(10000).default(1) }), req.query);
    const r = await pool.query(
      `SELECT n.id, n.kind, n.recipient, n.status, n.scheduled_at AS "scheduledAt", n.sent_at AS "sentAt", n.attempts, n.last_error AS "lastError",
              n.created_at AS "createdAt", b.id AS "bookingId", b.ref_code AS "refCode"
         FROM notifications n LEFT JOIN bookings b ON b.id = n.booking_id
        WHERE n.business_id = $1 AND ($2::text[] IS NULL OR n.status = ANY($2)) ORDER BY n.created_at DESC LIMIT 100 OFFSET $3`,
      [a.businessId, q.status ? q.status.split(',') : null, (q.page - 1) * 100],
    );
    return { notifications: r.rows.map((n) => ({ ...n, kindLabel: KIND_LABEL[n.kind as keyof typeof KIND_LABEL] ?? n.kind })), emailDriver: deps.cfg.emailDriver };
  });

  app.post<{ Params: { id: string } }>('/api/admin/notifications/:id/retry', async (req) => {
    const a = await requireOwner(deps, req);
    const id = parse(z.string().uuid(), req.params.id);
    if (!(await retryNotification(pool, a.businessId, id))) throw badRequest('再送できる状態ではありません');
    await audit(pool, a.businessId, a.actor, 'notification.retry', 'notification', id, {});
    return { ok: true };
  });

  app.get('/api/admin/audit', async (req) => {
    const a = await requireOwner(deps, req);
    const q = parse(z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), action: z.string().max(50).optional() }), req.query);
    const r = await pool.query(
      `SELECT l.id, l.actor_type AS "actorType", u.name AS "actorName", l.action, l.entity_type AS "entityType", l.entity_id AS "entityId", l.summary, l.at
         FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_user_id
        WHERE l.business_id = $1 AND ($2::text IS NULL OR l.action LIKE $2 || '%') ORDER BY l.at DESC, l.id DESC LIMIT 100 OFFSET $3`,
      [a.businessId, q.action ?? null, (q.page - 1) * 100],
    );
    return { logs: r.rows };
  });
}

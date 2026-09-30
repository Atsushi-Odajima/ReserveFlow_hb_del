import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { del, download, get, post, put, qs } from '../api';
import { Confirm, ErrorAlert, Field, Loading, useLoad, useToast } from '../components/ui';
import { addDays, fmtShortDateTime, todayIn } from '../format';
import { NOTIFICATION_STATUS_LABEL, WEEKDAYS } from '../../shared/labels';
import { useSession } from './session';

// ------------------------------------------------------------------ analytics
export function AnalyticsPage() {
  const { tz } = useSession();
  const today = todayIn(tz);
  const [from, setFrom] = useState(addDays(today, -29));
  const [to, setTo] = useState(today);
  const { data, error, loading } = useLoad<any>(() => get(`/api/admin/analytics${qs({ from, to })}`), [from, to]);
  const Table = ({ title, rows }: { title: string; rows: any[] }) => (
    <div className="card">
      <h2>{title}</h2>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>区分</th><th className="right">予約</th><th className="right">完了</th><th className="right">キャンセル</th><th className="right">無断欠席</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const max = Math.max(1, ...rows.map((x) => x.bookings));
              return (
                <tr key={r.key}>
                  <td>{r.label}</td>
                  <td className="right"><span aria-hidden="true" style={{ display: 'inline-block', height: 8, width: `${(r.bookings / max) * 60}px`, background: 'var(--brand)', marginRight: 6, borderRadius: 2 }} />{r.bookings}</td>
                  <td className="right">{r.completed}</td>
                  <td className="right">{r.cancelled}</td>
                  <td className="right">{r.noShow}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
  return (
    <div>
      <h1>分析</h1>
      <div className="row card">
        <label htmlFor="an-from">期間</label>
        <input id="an-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 170 }} />〜
        <input aria-label="期間の終了" type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 170 }} />
        <div className="btn-row">
          {[7, 30, 90].map((n) => <button key={n} className="btn-sm" onClick={() => { setFrom(addDays(today, -(n - 1))); setTo(today); }}>直近{n}日</button>)}
        </div>
      </div>
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : data && (
        <>
          <p className="small muted">{data.note}</p>
          <div className="kpis">
            <div className="kpi"><div className="v">{data.totals.bookings}</div><div className="l">予約件数</div></div>
            <div className="kpi"><div className="v">{data.totals.completed}</div><div className="l">完了</div></div>
            <div className="kpi"><div className="v">{data.totals.cancelledByCustomer} / {data.totals.cancelledByBusiness}</div><div className="l">キャンセル（顧客 / 事業者）</div></div>
            <div className="kpi"><div className="v">{data.totals.noShow}</div><div className="l">無断欠席</div></div>
            <div className="kpi"><div className="v">{data.totals.reschedules}</div><div className="l">日時変更</div></div>
            <div className="kpi"><div className="v">{data.totals.participants}</div><div className="l">参加人数（有効予約）</div></div>
            <div className="kpi"><div className="v">{data.totals.waitlist}</div><div className="l">待機登録（期間内に登録）</div></div>
          </div>
          <div className="card">
            <h2>率（分母を明示）</h2>
            <table className="table"><tbody>
              {[['キャンセル率', data.rates.cancelRate], ['無断欠席率', data.rates.noShowRate], ['完了率', data.rates.completionRate]].map(([l, r]: any) => (
                <tr key={l}><th>{l}</th><td className="right"><strong>{r.value === null ? '—' : `${r.value}%`}</strong></td><td className="small muted">{r.formula}</td></tr>
              ))}
            </tbody></table>
          </div>
          <Table title="サービス別" rows={data.byService} />
          <Table title="スタッフ別" rows={data.byStaff} />
          <Table title="曜日別（事業者タイムゾーン）" rows={data.byWeekday} />
          <Table title="時間帯別（開始時刻）" rows={data.byHour} />
          <Table title="予約経路別" rows={data.bySource} />
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ CSV / backup
export function DataPage() {
  const { tz } = useSession();
  const toast = useToast();
  const today = todayIn(tz);
  const [range, setRange] = useState({ from: addDays(today, -90), to: addDays(today, 90) });
  const [err, setErr] = useState<unknown>(null);
  const [imp, setImp] = useState<{ kind: 'customers' | 'services'; csv: string; preview: any } | null>(null);
  const [restore, setRestore] = useState<{ file: any; check: any } | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const dl = async (kind: string, withRange = true) => {
    setErr(null);
    try {
      await download(`/api/admin/export/${kind}${withRange ? qs(range) : ''}`, `reserveflow-${kind}`);
    } catch (e) {
      setErr(e);
    }
  };
  const readFile = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsText(f, 'utf-8'); });
  return (
    <div>
      <h1>CSV・バックアップ</h1>
      <ErrorAlert error={err} />
      <div className="card">
        <h2>CSV出力（UTF-8 BOM・Excel対応）</h2>
        <p className="small muted">セルの先頭が = + - @ の値は数式として実行されないよう先頭に ' を付けて出力します。</p>
        <div className="row" style={{ marginBottom: 8 }}>
          <label htmlFor="ex-from">予約の期間</label>
          <input id="ex-from" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} style={{ width: 170 }} />〜
          <input aria-label="期間の終了" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} style={{ width: 170 }} />
        </div>
        <div className="btn-row">
          <button onClick={() => dl('bookings.csv')}>予約</button>
          <button onClick={() => dl('cancellations.csv')}>キャンセル・無断欠席</button>
          <button onClick={() => dl('customers.csv', false)}>顧客</button>
          <button onClick={() => dl('services.csv', false)}>サービス</button>
          <button onClick={() => dl('staff.csv', false)}>スタッフ</button>
          <button onClick={() => dl('bookings.ics')}>予約をカレンダー形式（.ics）で出力</button>
        </div>
      </div>
      <div className="card">
        <h2>CSV取込（顧客・サービス）</h2>
        <p className="small">手順: テンプレートをダウンロード → 記入 → ファイルを選択（プレビュー・検証）→ エラーがなければ「取り込む」。同じファイルは二重に取り込めません。</p>
        <div className="btn-row" style={{ marginBottom: 8 }}>
          <button className="btn-sm" onClick={() => download('/api/admin/templates/customers.csv', 'template-customers.csv')}>顧客テンプレート</button>
          <button className="btn-sm" onClick={() => download('/api/admin/templates/services.csv', 'template-services.csv')}>サービステンプレート</button>
        </div>
        {(['customers', 'services'] as const).map((kind) => (
          <div key={kind} className="field">
            <label htmlFor={`imp-${kind}`}>{kind === 'customers' ? '顧客CSVを選択' : 'サービスCSVを選択'}</label>
            <input
              id={`imp-${kind}`}
              type="file"
              accept=".csv,text/csv"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                setErr(null);
                try {
                  const csv = await readFile(f);
                  setImp({ kind, csv, preview: await post(`/api/admin/import/${kind}/preview`, { csv }) });
                } catch (x) {
                  setErr(x);
                }
                e.target.value = '';
              }}
            />
          </div>
        ))}
        {imp && (
          <div className="card">
            <h3>プレビュー（{imp.kind === 'customers' ? '顧客' : 'サービス'}）</h3>
            {imp.preview.headerError ? <div className="alert alert-error">{imp.preview.headerError}</div> : (
              <>
                <p>全{imp.preview.total}行 ・ 取込可能 <strong>{imp.preview.valid}</strong> ・ エラー <strong>{imp.preview.errorRows}</strong> ・ 重複（取り込まない） {imp.preview.duplicateRows}</p>
                {imp.preview.alreadyImportedAt && <div className="alert alert-warn">このファイルは {fmtShortDateTime(imp.preview.alreadyImportedAt, tz)} に取り込み済みです。</div>}
                <div className="table-wrap" style={{ maxHeight: 280, overflowY: 'auto' }}>
                  <table className="table small">
                    <thead><tr><th>行</th><th>内容</th><th>判定</th></tr></thead>
                    <tbody>
                      {imp.preview.rows.map((r: any) => (
                        <tr key={r.line}>
                          <td>{r.line}</td>
                          <td>{Object.values(r.values).slice(0, 3).join(' / ')}</td>
                          <td>{r.errors.length ? <span style={{ color: 'var(--danger)' }}>✕ {r.errors.join('、')}</span> : r.duplicate ? <span className="muted">— {r.duplicate}</span> : '✓ 取込'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="btn-row" style={{ marginTop: 8 }}>
                  <button onClick={() => setImp(null)}>やめる</button>
                  <button
                    className="btn-primary"
                    disabled={imp.preview.errorRows > 0 || imp.preview.valid === 0 || !!imp.preview.alreadyImportedAt}
                    onClick={async () => {
                      try {
                        const r = await post(`/api/admin/import/${imp.kind}/commit`, { csv: imp.csv, fileHash: imp.preview.fileHash });
                        toast(`${r.imported}件を取り込みました`);
                        setImp(null);
                      } catch (x) {
                        setErr(x);
                      }
                    }}
                  >
                    {imp.preview.valid}件を取り込む
                  </button>
                </div>
                {imp.preview.errorRows > 0 && <p className="small">エラーのある行を修正してから、もう一度ファイルを選択してください。</p>}
              </>
            )}
          </div>
        )}
      </div>
      <div className="card">
        <h2>バックアップ</h2>
        <p className="small">設定・サービス・スタッフ・リソース・営業時間・例外・予約・顧客・質問/回答・通知履歴・操作ログを1つのファイル（JSON）に保存します。パスワードやリンク用トークンは含みません。<strong>ファイルには個人情報が含まれるため、安全な場所に保管してください。</strong></p>
        <button className="btn-primary" onClick={async () => { try { await download('/api/admin/backup', `reserveflow-backup-${today}.json`); toast('バックアップを保存しました'); } catch (e) { setErr(e); } }}>バックアップをダウンロード</button>
      </div>
      <div className="card">
        <h2>復元</h2>
        <p className="small">新しく作成した<strong>空の事業者</strong>にだけ復元できます（既存データの上書きはしません）。復元前にファイルを検証し、途中で失敗した場合は何も変更されません。復元後、予約ページは非公開になります。</p>
        <label htmlFor="restore-file" className="label">バックアップファイルを選択</label>
        <input
          id="restore-file"
          type="file"
          accept=".json,application/json"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setErr(null);
            try {
              const file = JSON.parse(await readFile(f));
              setRestore({ file, check: await post('/api/admin/restore/preview', { file }) });
            } catch (x) {
              setErr(x instanceof SyntaxError ? new Error('JSONファイルとして読み込めません') : x);
            }
            e.target.value = '';
          }}
        />
        {restore && (
          <div style={{ marginTop: 8 }}>
            {restore.check.ok ? <div className="alert alert-ok">検証OK: 形式 v{restore.check.schemaVersion} / アプリ {restore.check.appVersion} / 作成 {restore.check.createdAt && fmtShortDateTime(restore.check.createdAt, tz)}</div> : <ErrorAlert error={{ message: '検証エラー', details: { errors: restore.check.errors } } as any} />}
            {restore.check.warnings.map((w: string) => <div key={w} className="alert alert-warn">{w}</div>)}
            <table className="table small"><tbody>{Object.entries(restore.check.counts).map(([k, v]) => <tr key={k}><td>{k}</td><td className="right">{String(v)}</td></tr>)}</tbody></table>
            <button className="btn-danger" disabled={!restore.check.ok} onClick={() => setConfirmRestore(true)}>この内容で復元する</button>
          </div>
        )}
      </div>
      {confirmRestore && restore && (
        <Confirm title="復元を実行" message={<p>この事業者にバックアップの内容を復元します。よろしいですか？</p>} confirmLabel="復元する" danger onClose={() => setConfirmRestore(false)} onConfirm={async () => { const r = await post('/api/admin/restore/commit', { file: restore.file, confirm: true }); toast(`復元しました（予約 ${r.counts.bookings} 件）`); setRestore(null); }} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ notifications & audit
export function NotificationsPage() {
  const { tz } = useSession();
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') ?? '';
  const { data, error, loading, reload } = useLoad<any>(() => get(`/api/admin/notifications${qs({ status })}`), [status]);
  return (
    <div>
      <h1>通知履歴</h1>
      {data?.emailDriver === 'log' && <div className="alert alert-warn">メール送信が設定されていません（EMAIL_DRIVER=log）。通知は記録されますが、実際には送信されません。運用手順書の「メール設定」を参照してください。</div>}
      <div className="seg" role="group" aria-label="状態で絞り込み" style={{ marginBottom: 12 }}>
        {[['', 'すべて'], ['pending', '送信待ち'], ['sent', '送信済み'], ['failed,unknown', '失敗・不明']].map(([v, l]) => <button key={v} aria-pressed={status === v} onClick={() => setSp(v ? { status: v } : {})}>{l}</button>)}
      </div>
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>作成</th><th>種類</th><th>宛先</th><th>予定</th><th>状態</th><th>試行</th><th /></tr></thead>
            <tbody>
              {data.notifications.map((n: any) => (
                <tr key={n.id}>
                  <td className="nowrap small">{fmtShortDateTime(n.createdAt, tz)}</td>
                  <td>{n.kindLabel}{n.bookingId && <div className="small"><Link to={`/app/bookings/${n.bookingId}`}>{n.refCode}</Link></div>}</td>
                  <td className="small">{n.recipient}</td>
                  <td className="nowrap small">{fmtShortDateTime(n.scheduledAt, tz)}</td>
                  <td>{NOTIFICATION_STATUS_LABEL[n.status]}{n.lastError && <div className="small muted">{n.lastError}</div>}{n.sentAt && <div className="small muted">{fmtShortDateTime(n.sentAt, tz)}</div>}</td>
                  <td>{n.attempts}</td>
                  <td>{['failed', 'unknown'].includes(n.status) && <button className="btn-sm" onClick={async () => { await post(`/api/admin/notifications/${n.id}/retry`); reload(); }}>再送</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">「不明」は送信処理中に中断されたもので、二重送信を防ぐため自動では再送しません。お客様に届いたか不明な場合のみ「再送」してください。</p>
    </div>
  );
}

export function AuditPage() {
  const { tz } = useSession();
  const [page, setPage] = useState(1);
  const { data, error, loading } = useLoad<any>(() => get(`/api/admin/audit${qs({ page })}`), [page]);
  return (
    <div>
      <h1>操作ログ（監査）</h1>
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : (
        <div className="table-wrap">
          <table className="table small">
            <thead><tr><th>日時</th><th>操作者</th><th>操作</th><th>対象</th><th>内容</th></tr></thead>
            <tbody>
              {data.logs.map((l: any) => (
                <tr key={l.id}>
                  <td className="nowrap">{fmtShortDateTime(l.at, tz)}</td>
                  <td>{l.actorType === 'customer' ? 'お客様' : l.actorType === 'system' ? 'システム' : l.actorName ?? '—'}</td>
                  <td>{l.action}</td>
                  <td>{l.entityType === 'booking' && l.entityId ? <Link to={`/app/bookings/${l.entityId}`}>予約</Link> : l.entityType}</td>
                  <td><code style={{ fontSize: '0.75rem', wordBreak: 'break-all' }}>{JSON.stringify(l.summary)}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="btn-row" style={{ marginTop: 8 }}>
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>新しい</button>
        <button disabled={(data?.logs.length ?? 0) < 100} onClick={() => setPage(page + 1)}>古い</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ members
export function MembersPage() {
  const { me } = useSession();
  const { data, error, loading, reload } = useLoad<any>(async () => ({ ...(await get('/api/admin/members')), ...(await get('/api/admin/staff')) }), []);
  const [invite, setInvite] = useState({ email: '', role: 'owner' });
  const [res, setRes] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  if (loading && !data) return <Loading />;
  return (
    <div>
      <h1>ログインユーザー</h1>
      <ErrorAlert error={error || err} />
      <table className="table">
        <thead><tr><th>氏名</th><th>メール</th><th>権限</th><th>スタッフ</th><th /></tr></thead>
        <tbody>
          {data.members.map((m: any) => (
            <tr key={m.user_id}>
              <td>{m.name}</td><td>{m.email}</td><td>{m.role === 'owner' ? 'オーナー' : 'スタッフ'}</td><td>{m.staff_name ?? '—'}</td>
              <td>{m.user_id !== me.user.id && <button className="btn-sm" onClick={async () => { if (confirm(`${m.name} のログイン権限を削除しますか？`)) { await del(`/api/admin/members/${m.user_id}`); reload(); } }}>削除</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted">スタッフのログイン招待は「スタッフ」画面の各スタッフから行えます。</p>
      <div className="card">
        <h2>共同オーナーを招待</h2>
        <form className="row" onSubmit={async (e) => { e.preventDefault(); setErr(null); try { const r = await post('/api/admin/invites', { email: invite.email, role: 'owner', staffId: null, sendEmail: true }); setRes(r.inviteUrl); reload(); } catch (x) { setErr(x); } }}>
          <input type="email" aria-label="メールアドレス" placeholder="メールアドレス" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} style={{ flex: 1 }} />
          <button className="btn-primary">招待</button>
        </form>
        {res && <p className="small" style={{ wordBreak: 'break-all' }}>招待リンク（7日間有効・1回限り）: <code>{res}</code></p>}
      </div>
      {data.invites.length > 0 && (
        <div className="card"><h2>未使用の招待</h2><ul>{data.invites.map((i: any) => <li key={i.id}>{i.email}（{i.role === 'owner' ? 'オーナー' : 'スタッフ'}）</li>)}</ul></div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ settings
const TIMEZONES = ['Asia/Tokyo', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Taipei', 'Asia/Singapore', 'Asia/Bangkok', 'Australia/Sydney', 'Pacific/Auckland', 'Pacific/Honolulu', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'Europe/Paris', 'UTC'];

export function SettingsPage() {
  const { reload: reloadMe } = useSession();
  const toast = useToast();
  const [sp] = useSearchParams();
  const { data, error, loading, reload } = useLoad<any>(() => get('/api/admin/settings'), []);
  const [f, setF] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  useEffect(() => {
    if (data) setF({ ...data });
  }, [data]);
  if (loading || !f) return <Loading />;
  const fe = (k: string) => err?.fieldErrors?.[k];
  const bind = (k: string, type: 'text' | 'number' = 'text') => ({ value: f[k] ?? '', onChange: (e: any) => setF({ ...f, [k]: type === 'number' ? Number(e.target.value) : e.target.value }) });
  const hoursSel = (k: string, opts: number[]) => (
    <select value={f[k]} onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })} aria-label={k}>
      {opts.map((m) => <option key={m} value={m}>{m === 0 ? 'なし（直前まで）' : m % 1440 === 0 ? `${m / 1440}日前` : m % 60 === 0 ? `${m / 60}時間前` : `${m}分前`}</option>)}
    </select>
  );
  return (
    <div>
      <h1>事業者設定・公開</h1>
      {sp.get('welcome') && <div className="alert alert-ok">登録ありがとうございます。基本情報を確認し、「営業時間」「サービス」「スタッフ」を設定してから予約ページを公開してください。</div>}
      <ErrorAlert error={error} />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          try {
            await put('/api/admin/settings', f);
            toast('保存しました');
            reload();
            reloadMe();
          } catch (x) {
            setErr(x);
          }
        }}
      >
        <div className="card">
          <h2>予約ページの公開</h2>
          <label className="check"><input type="checkbox" checked={f.published} onChange={(e) => setF({ ...f, published: e.target.checked })} /><span><strong>予約ページを公開する</strong>（URL: <code>/book/{f.slug}</code>）</span></label>
          <Field label="予約ページのURL名" hint="半角英小文字・数字・ハイフン" error={fe('slug')}>{(p) => <input {...p} type="text" {...bind('slug')} />}</Field>
          {f.published && <p className="small">お客様への案内用URL: <a href={`/book/${f.slug}`} target="_blank" rel="noopener">{window.location.origin}/book/{f.slug}</a>（SNSのプロフィール等に貼ってください）</p>}
        </div>
        <div className="card">
          <h2>基本情報</h2>
          <div className="grid-2">
            <Field label="事業者名" required error={fe('name')}>{(p) => <input {...p} type="text" {...bind('name')} />}</Field>
            <Field label="ブランド名（予約ページの表示名・任意）">{(p) => <input {...p} type="text" {...bind('brandName')} />}</Field>
          </div>
          <Field label="説明">{(p) => <textarea {...p} {...bind('description')} />}</Field>
          <div className="grid-2">
            <Field label="電話（任意）">{(p) => <input {...p} type="tel" {...bind('phone')} />}</Field>
            <Field label="メール（予約ページ・メールに表示）" error={fe('email')}>{(p) => <input {...p} type="email" {...bind('email')} />}</Field>
          </div>
          <Field label="住所（任意）">{(p) => <input {...p} type="text" {...bind('address')} />}</Field>
          <div className="grid-2">
            <Field label="Webサイト（任意）" error={fe('websiteUrl')}>{(p) => <input {...p} type="url" {...bind('websiteUrl')} />}</Field>
            <Field label="SNS（任意）" error={fe('snsUrl')}>{(p) => <input {...p} type="url" {...bind('snsUrl')} />}</Field>
          </div>
          <div className="grid-2">
            <Field label="テーマ色">{(p) => <input {...p} type="color" {...bind('themeColor')} style={{ width: 80, minHeight: 44 }} />}</Field>
            <LogoField hasLogo={f.hasLogo} onChange={reload} />
          </div>
        </div>
        <div className="card">
          <h2>予約ルール</h2>
          <div className="grid-2">
            <Field label="タイムゾーン" hint="予約時刻の計算・表示に使います（夏時間のある地域にも対応）" error={fe('timezone')}>
              {(p) => <select {...p} value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>{[...new Set([f.timezone, ...TIMEZONES])].map((t) => <option key={t} value={t}>{t}</option>)}</select>}
            </Field>
            <Field label="週の始まり">{(p) => <select {...p} value={f.weekStart} onChange={(e) => setF({ ...f, weekStart: Number(e.target.value) })}>{WEEKDAYS.map((w, i) => <option key={i} value={i}>{w}曜日</option>)}</select>}</Field>
          </div>
          <div className="grid-3">
            <Field label="開始時刻の刻み">{(p) => <select {...p} value={f.slotIntervalMin} onChange={(e) => setF({ ...f, slotIntervalMin: Number(e.target.value) })}>{[5, 10, 15, 20, 30, 60].map((m) => <option key={m} value={m}>{m}分</option>)}</select>}</Field>
            <div className="field"><label>最短受付時間（何分前まで予約可）</label>{hoursSel('minNoticeMin', [0, 30, 60, 120, 180, 360, 720, 1440, 2880])}</div>
            <Field label="予約可能期間（何日先まで）">{(p) => <input {...p} type="number" min={1} max={365} {...bind('maxAdvanceDays', 'number')} />}</Field>
          </div>
          <div className="grid-3">
            <div className="field"><label>変更締切（お客様）</label>{hoursSel('changeDeadlineMin', [0, 60, 180, 720, 1440, 2880, 4320])}</div>
            <div className="field"><label>キャンセル締切（お客様）</label>{hoursSel('cancelDeadlineMin', [0, 60, 180, 720, 1440, 2880, 4320])}</div>
            <Field label="リマインド（開始の何時間前）" hint="0 で送らない">{(p) => <input {...p} type="number" min={0} max={168} {...bind('reminderHoursBefore', 'number')} />}</Field>
          </div>
          <Field label="電話番号の入力">{(p) => <select {...p} value={f.phoneRequirement} onChange={(e) => setF({ ...f, phoneRequirement: e.target.value })}><option value="optional">任意</option><option value="required">必須</option><option value="hidden">聞かない</option></select>}</Field>
        </div>
        <div className="card">
          <h2>表示文・通知</h2>
          <Field label="注意事項（予約ページ・確認メールに表示）">{(p) => <textarea {...p} {...bind('notes')} />}</Field>
          <Field label="予約完了メッセージ">{(p) => <textarea {...p} {...bind('completionMessage')} />}</Field>
          <Field label="同意文（入力すると確定前に同意チェックを表示）" hint="例: 入力した情報を予約管理の目的で利用することに同意します">{(p) => <textarea {...p} {...bind('consentText')} />}</Field>
          <Field label="メール署名">{(p) => <textarea {...p} {...bind('emailSignature')} />}</Field>
          <label className="check"><input type="checkbox" checked={f.notifyOwnerNewBooking} onChange={(e) => setF({ ...f, notifyOwnerNewBooking: e.target.checked })} /><span>新規予約・お客様による変更/キャンセルを事業者にメールで知らせる</span></label>
          <Field label="事業者の通知先メール（空欄なら上のメール）" error={fe('ownerNotifyEmail')}>{(p) => <input {...p} type="email" {...bind('ownerNotifyEmail')} />}</Field>
        </div>
        <ErrorAlert error={err} />
        <div className="sticky-actions" style={{ position: 'sticky' }}><button className="btn-primary">設定を保存</button></div>
      </form>
    </div>
  );
}

function LogoField({ hasLogo, onChange }: { hasLogo: boolean; onChange: () => void }) {
  const [err, setErr] = useState<unknown>(null);
  return (
    <div className="field">
      <label htmlFor="logo">ロゴ（PNG/JPEG/WebP・256KBまで）{hasLogo && ' ・ 設定済み'}</label>
      <input
        id="logo"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setErr(null);
          const buf = new Uint8Array(await file.arrayBuffer());
          let bin = '';
          for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
          try {
            await put('/api/admin/settings/logo', { mime: file.type, dataBase64: btoa(bin) });
            onChange();
          } catch (x) {
            setErr(x);
          }
        }}
      />
      {hasLogo && <button type="button" className="btn-sm" onClick={async () => { await del('/api/admin/settings/logo'); onChange(); }}>ロゴを削除</button>}
      <ErrorAlert error={err} />
    </div>
  );
}

export function AccountPage() {
  const { me } = useSession();
  const toast = useToast();
  const [f, setF] = useState({ current: '', next: '' });
  const [err, setErr] = useState<unknown>(null);
  return (
    <div>
      <h1>アカウント</h1>
      <p>{me.user.name}（{me.user.email}）</p>
      {me.businesses.length > 1 && (
        <div className="card">
          <h2>事業者の切り替え</h2>
          {me.businesses.map((b) => (
            <button key={b.id} disabled={b.id === me.business?.id} onClick={async () => { await post('/api/auth/switch-business', { businessId: b.id }); window.location.href = '/app'; }} style={{ marginRight: 8 }}>{b.name}</button>
          ))}
        </div>
      )}
      <form className="card" onSubmit={async (e) => { e.preventDefault(); setErr(null); try { await post('/api/auth/password', f); toast('パスワードを変更しました（他の端末はログアウトされます）'); setF({ current: '', next: '' }); } catch (x) { setErr(x); } }}>
        <h2>パスワード変更</h2>
        <Field label="現在のパスワード">{(p) => <input {...p} type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} />}</Field>
        <Field label="新しいパスワード（10文字以上）">{(p) => <input {...p} type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} />}</Field>
        <ErrorAlert error={err} />
        <button className="btn-primary">変更する</button>
      </form>
    </div>
  );
}

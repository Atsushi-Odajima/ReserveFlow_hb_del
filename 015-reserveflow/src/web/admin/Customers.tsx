import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { download, get, post, put, qs } from '../api';
import { Confirm, ErrorAlert, Field, Loading, Modal, StatusBadge, useLoad, useToast } from '../components/ui';
import { dateLabel, fmtDate, fmtShortDateTime, fmtTime, minToTime } from '../format';
import { useSession } from './session';

export function CustomersList() {
  const { tz } = useSession();
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const page = Number(sp.get('page') ?? 1);
  const archived = sp.get('archived') ?? '0';
  const [input, setInput] = useState(q);
  const [adding, setAdding] = useState(false);
  const { data, error, loading, reload } = useLoad<any>(() => get(`/api/admin/customers${qs({ q, page, archived })}`), [q, page, archived]);
  return (
    <div>
      <div className="row"><h1 style={{ margin: 0 }}>顧客</h1><span className="spacer" /><button className="btn-primary" onClick={() => setAdding(true)}>＋ 顧客を追加</button></div>
      <form className="row card" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); setSp({ q: input, archived }); }}>
        <input type="search" aria-label="顧客検索" placeholder="氏名（前方一致）・電話・メール・顧客番号" value={input} onChange={(e) => setInput(e.target.value)} style={{ flex: 1 }} />
        <button type="submit">検索</button>
        <label className="check" style={{ minHeight: 0 }}><input type="checkbox" checked={archived === '1'} onChange={(e) => setSp({ q, archived: e.target.checked ? '1' : '0' })} /><span>アーカイブ済み</span></label>
      </form>
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : data && (
        <>
          <p className="small muted">{data.total} 名</p>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>No.</th><th>氏名</th><th className="hide-mobile">連絡先</th><th>予約数</th><th className="hide-mobile">初回</th><th>最終</th></tr></thead>
              <tbody>
                {data.customers.map((c: any) => (
                  <tr key={c.id}>
                    <td>{c.customerNo}</td>
                    <td><Link to={`/app/customers/${c.id}`}>{c.name}</Link> {c.tags.map((t: string) => <span key={t} className="tag">{t}</span>)}</td>
                    <td className="hide-mobile small">{c.phone}<br />{c.email}</td>
                    <td>{c.total}</td>
                    <td className="hide-mobile small">{c.firstAt ? fmtDate(c.firstAt, tz) : '—'}</td>
                    <td className="small">{c.lastAt ? fmtDate(c.lastAt, tz) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button disabled={page <= 1} onClick={() => setSp({ q, archived, page: String(page - 1) })}>前へ</button>
            <span className="small">{page} / {Math.max(1, Math.ceil(data.total / data.pageSize))}</span>
            <button disabled={page * data.pageSize >= data.total} onClick={() => setSp({ q, archived, page: String(page + 1) })}>次へ</button>
          </div>
        </>
      )}
      {adding && <CustomerEdit onClose={() => setAdding(false)} onSaved={reload} />}
    </div>
  );
}

function CustomerEdit({ customer, onClose, onSaved }: { customer?: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: customer?.name ?? '', email: customer?.email ?? '', phone: customer?.phone ?? '', adminNote: customer?.adminNote ?? '', tags: (customer?.tags ?? []).join(', ') });
  const [err, setErr] = useState<any>(null);
  const nav = useNavigate();
  return (
    <Modal title={customer ? '顧客情報の編集' : '顧客を追加'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          const body = { ...f, tags: f.tags.split(/[,、]/).map((t: string) => t.trim()).filter(Boolean) };
          try {
            if (customer) await put(`/api/admin/customers/${customer.id}`, body);
            else {
              const r = await post('/api/admin/customers', body);
              nav(`/app/customers/${r.id}`);
            }
            onClose();
            onSaved();
          } catch (x) {
            setErr(x);
          }
        }}
      >
        <Field label="氏名" required error={err?.fieldErrors?.name}>{(p) => <input {...p} type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="メール" error={err?.fieldErrors?.email}>{(p) => <input {...p} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
        <Field label="電話">{(p) => <input {...p} type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />}</Field>
        <Field label="管理メモ" hint="お客様には表示されません">{(p) => <textarea {...p} value={f.adminNote} onChange={(e) => setF({ ...f, adminNote: e.target.value })} />}</Field>
        <Field label="タグ（カンマ区切り・任意）">{(p) => <input {...p} type="text" value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} />}</Field>
        <ErrorAlert error={err} />
        <div className="btn-row"><button type="button" onClick={onClose}>やめる</button><button className="btn-primary">保存</button></div>
      </form>
    </Modal>
  );
}

export function CustomerDetail() {
  const { id = '' } = useParams();
  const { tz, isOwner } = useSession();
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<any>(() => get(`/api/admin/customers/${id}`), [id]);
  const [edit, setEdit] = useState(false);
  const [anon, setAnon] = useState(false);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorAlert error={error} />;
  const c = data.customer;
  const s = data.stats;
  return (
    <div>
      <p><Link to="/app/customers">← 顧客一覧</Link></p>
      <div className="row">
        <h1 style={{ margin: 0 }}>{c.name} <span className="small muted">No.{c.customerNo}</span></h1>
        {c.archived && <span className="tag">アーカイブ</span>}
        <span className="spacer" />
        {!c.anonymizedAt && (
          <div className="btn-row">
            <Link className="btn btn-primary" to={`/app/new${qs({ customerId: c.id, customerName: `${c.name}（No.${c.customerNo}）` })}`}>予約を作成</Link>
            <button onClick={() => setEdit(true)}>編集</button>
            <button onClick={async () => { await post(`/api/admin/customers/${id}/archive`, { archived: !c.archived }); toast(c.archived ? 'アーカイブを解除しました' : 'アーカイブしました'); reload(); }}>{c.archived ? 'アーカイブ解除' : 'アーカイブ'}</button>
          </div>
        )}
      </div>
      <div className="grid-2" style={{ marginTop: 12 }}>
        <div className="card">
          <dl className="summary">
            <dt>電話</dt><dd>{c.phone ? <a href={`tel:${c.phone}`}>{c.phone}</a> : '—'}</dd>
            <dt>メール</dt><dd>{c.email ?? '—'}</dd>
            <dt>タグ</dt><dd>{c.tags.length ? c.tags.map((t: string) => <span key={t} className="tag">{t}</span>) : '—'}</dd>
            <dt>管理メモ</dt><dd style={{ whiteSpace: 'pre-wrap', fontWeight: 400 }}>{c.adminNote || '—'}</dd>
          </dl>
        </div>
        <div className="card">
          <h2>利用状況（予約履歴から自動集計）</h2>
          <table className="table"><tbody>
            <tr><th>予約数（変更前の旧予約を除く）</th><td className="right">{s.total}</td></tr>
            <tr><th>完了</th><td className="right">{s.completed}</td></tr>
            <tr><th>顧客キャンセル</th><td className="right">{s.cancelledByCustomer}</td></tr>
            <tr><th>事業者キャンセル</th><td className="right">{s.cancelledByBusiness}</td></tr>
            <tr><th>無断欠席</th><td className="right">{s.noShow}</td></tr>
            <tr><th>日時変更</th><td className="right">{s.rescheduled}</td></tr>
            <tr><th>初回予約</th><td className="right">{s.firstAt ? fmtDate(s.firstAt, tz) : '—'}</td></tr>
            <tr><th>最終来店</th><td className="right">{s.lastVisitAt ? fmtDate(s.lastVisitAt, tz) : '—'}</td></tr>
            <tr><th>次回予約</th><td className="right">{s.nextAt ? fmtShortDateTime(s.nextAt, tz) : '—'}</td></tr>
          </tbody></table>
        </div>
      </div>
      {data.duplicateCandidates.length > 0 && (
        <div className="alert alert-warn">
          <strong>重複の可能性がある顧客</strong>（自動では統合しません。確認のうえ必要なら片方をアーカイブしてください）
          <ul style={{ margin: '6px 0 0' }}>
            {data.duplicateCandidates.map((d: any) => <li key={d.id}><Link to={`/app/customers/${d.id}`}>{d.name}（No.{d.customerNo}）</Link> {d.phone} {d.email}</li>)}
          </ul>
        </div>
      )}
      <div className="card">
        <h2>予約履歴</h2>
        <ul className="list">
          {data.bookings.map((b: any) => (
            <li key={b.id}>
              <Link className="list-item" to={`/app/bookings/${b.id}`}>
                <span className="small nowrap">{fmtShortDateTime(b.start, tz)}</span>
                <span style={{ flex: 1 }}>{b.serviceName}{b.staffName ? ` ・ ${b.staffName}` : ''}</span>
                <StatusBadge status={b.status} />
              </Link>
            </li>
          ))}
        </ul>
      </div>
      {isOwner && !c.anonymizedAt && (
        <div className="card">
          <h2>個人データ</h2>
          <p className="small">開示請求にはエクスポート、削除依頼には「削除（匿名化）」を使います。削除すると氏名・連絡先・回答・メモが消去され、予約件数などの統計に必要な履歴だけが匿名で残ります。</p>
          <div className="btn-row">
            <button onClick={() => download(`/api/admin/customers/${id}/export`, `customer-${c.customerNo}.json`)}>この顧客のデータをエクスポート</button>
            <button className="btn-danger" onClick={() => setAnon(true)}>削除（匿名化）</button>
          </div>
        </div>
      )}
      {edit && <CustomerEdit customer={c} onClose={() => setEdit(false)} onSaved={reload} />}
      {anon && (
        <Confirm title="顧客データを削除（匿名化）" message={<p>{c.name} 様の個人情報を消去します。元に戻せません。今後の予約がある場合は先にキャンセルしてください。</p>} confirmLabel="削除する" danger onClose={() => setAnon(false)} onConfirm={async () => { await post(`/api/admin/customers/${id}/anonymize`, { confirm: true }); reload(); }} />
      )}
    </div>
  );
}

export function WaitlistPage() {
  const { tz } = useSession();
  const [status, setStatus] = useState('waiting,contacted');
  const { data, error, loading, reload } = useLoad<any>(() => get(`/api/admin/waitlist${qs({ status })}`), [status]);
  const [cand, setCand] = useState<{ entry: any; slots: any[] | null } | null>(null);
  const setSt = async (id: string, s: string) => {
    await put(`/api/admin/waitlist/${id}`, { status: s });
    reload();
  };
  return (
    <div>
      <h1>待機リスト（空き待ち）</h1>
      <p className="small muted">空き待ちは予約の保証ではありません。キャンセルで空きが出ると候補に「空きあり」が付きます。自動で予約は確定されないため、お客様へ連絡し「新規予約」から予約してください。</p>
      <div className="seg" role="group" aria-label="状態で絞り込み" style={{ marginBottom: 12 }}>
        {[['waiting,contacted', '対応中'], ['booked', '予約済み'], ['expired,cancelled', '終了']].map(([v, l]) => <button key={v} aria-pressed={status === v} onClick={() => setStatus(v)}>{l}</button>)}
      </div>
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : data.entries.length === 0 ? <p className="muted">ありません。</p> : (
        data.entries.map((w: any) => (
          <div key={w.id} className="card">
            <div className="row">
              <strong>{w.name} 様</strong>
              {w.lastMatchAt && <span className="pill st-checked_in">★ 空きあり（{fmtShortDateTime(w.lastMatchAt, tz)}に検知）</span>}
              <span className="spacer" />
              <span className="tag">{{ waiting: '待機中', contacted: '連絡済み', booked: '予約済み', expired: '期限切れ', cancelled: '取消' }[w.status as string]}</span>
            </div>
            <div className="small">
              {w.serviceName}{w.staffName ? ` ・ 担当希望 ${w.staffName}` : ''} ・ {w.partySize}名 ・ 希望 {dateLabel(w.dateFrom)}〜{dateLabel(w.dateTo)} {minToTime(w.timeFromMin)}〜{minToTime(w.timeToMin)}
              <br />
              {w.phone && <a href={`tel:${w.phone}`}>{w.phone}</a>} {w.email} {w.note && `・ ${w.note}`}
            </div>
            <div className="btn-row" style={{ marginTop: 8 }}>
              <button className="btn-sm" onClick={async () => { setCand({ entry: w, slots: null }); const r = await get(`/api/admin/waitlist/${w.id}/candidates`); setCand({ entry: w, slots: r.slots }); }}>現在の空き候補</button>
              {w.status === 'waiting' && <button className="btn-sm" onClick={() => setSt(w.id, 'contacted')}>連絡済みにする</button>}
              {['waiting', 'contacted'].includes(w.status) && <button className="btn-sm" onClick={() => setSt(w.id, 'booked')}>予約済みにする</button>}
              {['waiting', 'contacted'].includes(w.status) && <button className="btn-sm" onClick={() => setSt(w.id, 'cancelled')}>取消</button>}
            </div>
          </div>
        ))
      )}
      {cand && (
        <Modal title={`${cand.entry.name} 様の希望に合う空き`} onClose={() => setCand(null)}>
          {!cand.slots ? <Loading /> : cand.slots.length === 0 ? <p>現在、条件に合う空きはありません。</p> : (
            <ul className="list">
              {cand.slots.map((s) => (
                <li key={s.start + (s.occurrenceId ?? '')} className="list-item">
                  <span>{fmtShortDateTime(s.start, tz)}〜{fmtTime(s.end, tz)}</span>
                  <span className="spacer" />
                  <Link className="btn btn-sm" to={`/app/new${qs({ serviceId: cand.entry.serviceId, staffId: cand.entry.staffId ?? undefined, customerId: cand.entry.customerId ?? undefined })}`}>予約画面へ</Link>
                </li>
              ))}
            </ul>
          )}
          <p className="small muted">予約前にお客様へ確認してください。</p>
        </Modal>
      )}
    </div>
  );
}

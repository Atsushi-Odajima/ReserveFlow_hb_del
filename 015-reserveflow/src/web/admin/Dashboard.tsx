import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, put, qs } from '../api';
import { Confirm, ErrorAlert, Loading, Modal, StatusBadge, useLoad, useToast } from '../components/ui';
import { addDays, dateLabel, fmtShortDateTime, fmtTime, todayIn } from '../format';
import { SOURCE_LABEL, STATUS_LABEL } from '../../shared/labels';
import { useSession } from './session';

export interface BookingRow {
  id: string;
  refCode: string;
  status: string;
  start: string;
  end: string;
  partySize: number;
  source: string;
  serviceId: string;
  serviceName: string;
  staffId: string | null;
  staffName: string | null;
  staffColor: string | null;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  customerNo: number;
  occurrenceId: string | null;
  forced: boolean;
  customerNote: string;
  staffNote: string;
  answers?: Array<{ label: string; display: string }>;
  completedVisits?: number;
  noShows?: number;
}

export function Dashboard() {
  const { tz, me } = useSession();
  const { data, error, loading } = useLoad<any>(() => get('/api/admin/dashboard'), []);
  if (loading) return <Loading />;
  if (error) return <ErrorAlert error={error} />;
  const d = data;
  return (
    <div>
      <h1>今日 {dateLabel(d.today)}</h1>
      {!d.published && me.role === 'owner' && (
        <div className="alert alert-warn">予約ページはまだ公開されていません。<Link to="/app/settings">事業者設定</Link>で公開できます。</div>
      )}
      <div className="kpis">
        <div className="kpi"><div className="v">{d.todayBookings.filter((b: BookingRow) => ['confirmed', 'checked_in', 'completed', 'no_show'].includes(b.status)).length}</div><div className="l">今日の予約</div></div>
        <div className="kpi"><div className="v">{d.weekBookings}</div><div className="l">今週の予約</div></div>
        <div className="kpi"><div className="v">{d.waitlist.n}</div><div className="l">待機中{d.waitlist.matched ? `（空き候補 ${d.waitlist.matched}件）` : ''}</div></div>
        <div className="kpi"><div className="v">{d.noShow30d}</div><div className="l">無断欠席（30日）</div></div>
      </div>
      {d.failedNotifications > 0 && (
        <div className="alert alert-error">送信に失敗した通知が {d.failedNotifications} 件あります。<Link to="/app/notifications?status=failed,unknown">通知履歴を確認</Link></div>
      )}
      {d.unhandled.length > 0 && (
        <div className="card">
          <h2>未対応（終了時刻を過ぎて「完了/無断欠席」が未記録）</h2>
          <ul className="list">
            {d.unhandled.map((b: BookingRow) => (
              <li key={b.id}><Link className="list-item" to={`/app/bookings/${b.id}`}><span className="list-time">{fmtShortDateTime(b.start, tz)}</span><span>{b.customerName} 様 ・ {b.serviceName}</span><span className="spacer" /><StatusBadge status={b.status} /></Link></li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid-2">
        <div className="card">
          <div className="row"><h2 style={{ margin: 0 }}>次の予約</h2><span className="spacer" /><Link to="/app/today">受付画面へ</Link></div>
          {d.nextBookings.length === 0 ? <p className="muted">予定されている予約はありません。</p> : (
            <ul className="list">
              {d.nextBookings.map((b: BookingRow) => (
                <li key={b.id}><Link className="list-item" to={`/app/bookings/${b.id}`}><span className="list-time">{fmtTime(b.start, tz)}</span><span><strong>{b.customerName} 様</strong><br /><span className="small muted">{dateLabel(new Date(b.start).toLocaleDateString('sv-SE', { timeZone: tz }))} ・ {b.serviceName}{b.staffName ? ` ・ ${b.staffName}` : ''}</span></span></Link></li>
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <h2>スタッフ別 今日の予定</h2>
          <table className="table"><tbody>
            {d.staffToday.map((s: any) => (<tr key={s.id}><td><span aria-hidden="true" style={{ color: s.color }}>●</span> {s.name}</td><td className="right">{s.bookings} 件</td></tr>))}
          </tbody></table>
          <h2 style={{ marginTop: 16 }}>空き枠（公開ページ基準）</h2>
          <table className="table"><thead><tr><th>サービス</th><th className="right">今日</th><th className="right">明日</th></tr></thead><tbody>
            {d.openSlots.map((s: any) => (<tr key={s.serviceId}><td>{s.serviceName}</td><td className="right">{s.today}</td><td className="right">{s.tomorrow}</td></tr>))}
          </tbody></table>
          <p className="small"><Link to="/app/new">空き検索・新規予約</Link></p>
        </div>
      </div>
      <div className="card">
        <h2>最近の変更・キャンセル（7日）</h2>
        {d.recentChanges.length === 0 ? <p className="muted">ありません。</p> : (
          <table className="table"><thead><tr><th>日時</th><th>予約</th><th>内容</th></tr></thead><tbody>
            {d.recentChanges.map((c: any, i: number) => (
              <tr key={i}><td className="nowrap">{fmtShortDateTime(c.at, tz)}</td><td><Link to={`/app/bookings/${c.id}`}>{c.customerName} 様（{fmtShortDateTime(c.start, tz)}）</Link></td><td>{STATUS_LABEL[c.to]}{c.actorType === 'customer' ? '（お客様）' : ''}</td></tr>
            ))}
          </tbody></table>
        )}
      </div>
    </div>
  );
}

export function TodayPage() {
  const { tz } = useSession();
  const toast = useToast();
  const [date, setDate] = useState(todayIn(tz));
  const { data, error, loading, reload } = useLoad<{ bookings: BookingRow[]; serviceNotes: Array<{ id: string; notes: string }> }>(() => get(`/api/admin/today${qs({ date })}`), [date]);
  const [cancel, setCancel] = useState<BookingRow | null>(null);
  const [memo, setMemo] = useState<BookingRow | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const act = async (b: BookingRow, to: string, label: string) => {
    setErr(null);
    try {
      await post(`/api/admin/bookings/${b.id}/status`, { to });
      toast(`${b.customerName} 様: ${label}`);
      reload();
    } catch (e) {
      setErr(e);
    }
  };
  const notes = new Map((data?.serviceNotes ?? []).map((s) => [s.id, s.notes]));
  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>受付 {dateLabel(date)}</h1>
        <span className="spacer" />
        <div className="btn-row">
          <button className="btn-sm" onClick={() => setDate(addDays(date, -1))} aria-label="前の日">‹</button>
          <button className="btn-sm" onClick={() => setDate(todayIn(tz))}>今日</button>
          <button className="btn-sm" onClick={() => setDate(addDays(date, 1))} aria-label="次の日">›</button>
        </div>
      </div>
      <ErrorAlert error={err || error} />
      {loading && !data ? <Loading /> : data!.bookings.length === 0 ? <p className="muted">この日の予約はありません。</p> : null}
      {data?.bookings.map((b) => {
        const inactive = b.status.startsWith('cancelled');
        return (
          <div key={b.id} className="card" style={{ opacity: inactive ? 0.6 : 1 }}>
            <div className="row">
              <span className="list-time">{fmtTime(b.start, tz)}</span>
              <div style={{ flex: 1, minWidth: 180 }}>
                <Link to={`/app/bookings/${b.id}`} style={{ fontWeight: 800 }}>{b.customerName} 様</Link>
                {b.partySize > 1 && <span> ・ {b.partySize}名</span>}
                <div className="small muted">
                  {fmtTime(b.start, tz)}〜{fmtTime(b.end, tz)} ・ {b.serviceName}{b.staffName ? ` ・ 担当 ${b.staffName}` : ''} ・ {SOURCE_LABEL[b.source]}
                  {typeof b.completedVisits === 'number' && ` ・ 来店${b.completedVisits}回`}
                  {b.noShows ? <strong style={{ color: 'var(--danger)' }}> ・ 無断欠席歴{b.noShows}回</strong> : null}
                </div>
              </div>
              <StatusBadge status={b.status} />
            </div>
            {(b.customerNote || b.staffNote || notes.get(b.serviceId) || (b.answers ?? []).length > 0) && (
              <div className="small" style={{ marginTop: 8, background: '#fafbfb', padding: 8, borderRadius: 6 }}>
                {notes.get(b.serviceId) && <div>注意事項: {notes.get(b.serviceId)}</div>}
                {b.customerNote && <div>お客様より: {b.customerNote}</div>}
                {b.staffNote && <div>スタッフメモ: {b.staffNote}</div>}
                {(b.answers ?? []).map((a, i) => <div key={i}>{a.label}: {a.display || '—'}</div>)}
              </div>
            )}
            <div className="btn-row" style={{ marginTop: 10 }}>
              {b.status === 'confirmed' && <button className="btn-primary" onClick={() => act(b, 'checked_in', '来店/開始を記録')}>来店・開始</button>}
              {(b.status === 'confirmed' || b.status === 'checked_in') && <button className="btn-primary" onClick={() => act(b, 'completed', '完了を記録')}>完了</button>}
              {b.status === 'confirmed' && Date.parse(b.start) <= Date.now() && <button onClick={() => act(b, 'no_show', '無断欠席を記録')}>無断欠席</button>}
              {(b.status === 'checked_in' || b.status === 'no_show') && <button className="btn-sm" onClick={() => act(b, 'confirmed', '予約確定に戻しました')}>取り消す</button>}
              {b.status === 'completed' && <button className="btn-sm" onClick={() => act(b, 'checked_in', '来店/開始済みに戻しました')}>完了を取り消す</button>}
              <button className="btn-sm" onClick={() => setMemo(b)}>メモ</button>
              {b.status === 'confirmed' && <button className="btn-sm" onClick={() => setCancel(b)}>キャンセル</button>}
              {(b.status === 'completed' || b.status === 'checked_in') && (
                <Link className="btn btn-sm" to={`/app/new${qs({ customerId: b.customerId, customerName: b.customerName, serviceId: b.serviceId, staffId: b.staffId ?? undefined })}`}>次回予約</Link>
              )}
            </div>
          </div>
        );
      })}
      {cancel && <CancelDialog booking={cancel} onClose={() => setCancel(null)} onDone={reload} />}
      {memo && <MemoDialog booking={memo} onClose={() => setMemo(null)} onDone={reload} />}
    </div>
  );
}

export function CancelDialog({ booking, onClose, onDone }: { booking: BookingRow; onClose: () => void; onDone: () => void }) {
  const { tz } = useSession();
  const [by, setBy] = useState<'customer' | 'business'>('customer');
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(true);
  const [result, setResult] = useState<number | null>(null);
  if (result !== null)
    return (
      <Modal title="キャンセルしました" onClose={() => { onClose(); onDone(); }}>
        <p>枠は再び予約できる状態になりました。</p>
        {result > 0 && <div className="alert alert-info">この枠に合う待機リストの候補が {result} 件あります。<Link to="/app/waitlist">待機リストを確認</Link>（自動では予約されません）</div>}
        <button className="btn-primary" onClick={() => { onClose(); onDone(); }}>閉じる</button>
      </Modal>
    );
  return (
    <Confirm
      title="予約をキャンセル"
      message={<p>{booking.customerName} 様 {fmtShortDateTime(booking.start, tz)}「{booking.serviceName}」をキャンセルします。</p>}
      confirmLabel="キャンセルする"
      danger
      onClose={onClose}
      onConfirm={async () => {
        const r = await post(`/api/admin/bookings/${booking.id}/cancel`, { by, reason, notifyCustomer: notify });
        setResult(r.waitlistMatches);
        return false as const;
      }}
    >
      <fieldset style={{ border: 0, padding: 0 }}>
        <legend className="label">キャンセルの区分</legend>
        <label className="check"><input type="radio" name="by" checked={by === 'customer'} onChange={() => setBy('customer')} /><span>お客様都合（電話・DM等で連絡あり）</span></label>
        <label className="check"><input type="radio" name="by" checked={by === 'business'} onChange={() => setBy('business')} /><span>事業者都合</span></label>
      </fieldset>
      <div className="field"><label htmlFor="cxl-reason">理由（任意）</label><textarea id="cxl-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></div>
      <label className="check"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /><span>お客様にキャンセルメールを送る（メールアドレスがある場合）</span></label>
    </Confirm>
  );
}

function MemoDialog({ booking, onClose, onDone }: { booking: BookingRow; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState(booking.staffNote);
  const [err, setErr] = useState<unknown>(null);
  return (
    <Modal title="スタッフメモ" onClose={onClose}>
      <div className="field"><label htmlFor="memo">メモ（お客様には表示されません）</label><textarea id="memo" value={v} onChange={(e) => setV(e.target.value)} maxLength={2000} /></div>
      <ErrorAlert error={err} />
      <div className="btn-row">
        <button onClick={onClose}>やめる</button>
        <button className="btn-primary" onClick={async () => { try { await put(`/api/admin/bookings/${booking.id}/notes`, { staffNote: v }); onClose(); onDone(); } catch (e) { setErr(e); } }}>保存</button>
      </div>
    </Modal>
  );
}

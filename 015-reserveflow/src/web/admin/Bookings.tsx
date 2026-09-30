import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, get, post, qs, uuid } from '../api';
import { ErrorAlert, Field, Loading, Modal, StatusBadge, useLoad, useOnline, useToast } from '../components/ui';
import { addDays, dateLabel, fmtDateTime, fmtShortDateTime, fmtTime, localToIso, timeToMin, todayIn } from '../format';
import { NOTIFICATION_STATUS_LABEL, SOURCE_LABEL, STATUS_LABEL } from '../../shared/labels';
import { useSession } from './session';
import { CancelDialog, type BookingRow } from './Dashboard';

export function BookingsList() {
  const { tz } = useSession();
  const [sp, setSp] = useSearchParams();
  const today = todayIn(tz);
  const f = {
    from: sp.get('from') ?? today,
    to: sp.get('to') ?? addDays(today, 30),
    status: sp.get('status') ?? '',
    staffId: sp.get('staffId') ?? '',
    q: sp.get('q') ?? '',
    page: Number(sp.get('page') ?? 1),
  };
  const set = (patch: Partial<typeof f>) => setSp(Object.fromEntries(Object.entries({ ...f, page: 1, ...patch }).filter(([, v]) => v !== '' && v !== undefined).map(([k, v]) => [k, String(v)])));
  const staff = useLoad<{ staff: Array<{ id: string; displayName: string }> }>(() => get('/api/admin/staff'), []);
  const { data, error, loading } = useLoad<{ total: number; bookings: BookingRow[]; pageSize: number }>(
    () => get(`/api/admin/bookings${qs({ from: f.from, to: f.to, status: f.status, staffId: f.staffId, q: f.q, page: f.page })}`),
    [sp.toString()],
  );
  const [q, setQ] = useState(f.q);
  return (
    <div>
      <div className="row"><h1 style={{ margin: 0 }}>予約一覧</h1><span className="spacer" /><Link className="btn btn-primary" to="/app/new">＋ 新規予約</Link></div>
      <form className="card" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); set({ q }); }}>
        <div className="grid-2">
          <div className="grid-2">
            <Field label="期間（から）">{(p) => <input {...p} type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} />}</Field>
            <Field label="期間（まで）">{(p) => <input {...p} type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} />}</Field>
          </div>
          <div className="grid-2">
            <Field label="状態">
              {(p) => (
                <select {...p} value={f.status} onChange={(e) => set({ status: e.target.value })}>
                  <option value="">すべて</option>
                  <option value="confirmed,checked_in">予約中（確定・来店済み）</option>
                  {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              )}
            </Field>
            <Field label="担当">
              {(p) => (
                <select {...p} value={f.staffId} onChange={(e) => set({ staffId: e.target.value })}>
                  <option value="">すべて</option>
                  {staff.data?.staff.map((s) => <option key={s.id} value={s.id}>{s.displayName}</option>)}
                </select>
              )}
            </Field>
          </div>
        </div>
        <div className="row">
          <input type="search" aria-label="氏名・予約番号・電話・メールで検索" placeholder="氏名・予約番号・電話・メール" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
          <button type="submit">検索</button>
        </div>
      </form>
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : data && (
        <>
          <p className="small muted">{data.total} 件</p>
          <div className="table-wrap hide-mobile">
            <table className="table">
              <thead><tr><th>日時</th><th>顧客</th><th>サービス</th><th>担当</th><th>人数</th><th>経路</th><th>状態</th><th>予約番号</th></tr></thead>
              <tbody>
                {data.bookings.map((b) => (
                  <tr key={b.id}>
                    <td className="nowrap"><Link to={`/app/bookings/${b.id}`}>{fmtShortDateTime(b.start, tz)}</Link></td>
                    <td>{b.customerName}</td><td>{b.serviceName}</td><td>{b.staffName ?? '—'}</td><td>{b.partySize}</td><td>{SOURCE_LABEL[b.source]}</td>
                    <td><StatusBadge status={b.status} />{b.forced && <span className="tag">強制</span>}</td><td className="small">{b.refCode}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="list hide-desktop">
            {data.bookings.map((b) => (
              <li key={b.id}>
                <Link className="list-item" to={`/app/bookings/${b.id}`}>
                  <span className="list-time small">{fmtShortDateTime(b.start, tz)}</span>
                  <span style={{ flex: 1 }}><strong>{b.customerName}</strong><br /><span className="small muted">{b.serviceName}{b.staffName ? ` ・ ${b.staffName}` : ''}</span></span>
                  <StatusBadge status={b.status} />
                </Link>
              </li>
            ))}
          </ul>
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button disabled={f.page <= 1} onClick={() => set({ page: f.page - 1 })}>前へ</button>
            <span className="small">{f.page} / {Math.max(1, Math.ceil(data.total / data.pageSize))}</span>
            <button disabled={f.page * data.pageSize >= data.total} onClick={() => set({ page: f.page + 1 })}>次へ</button>
          </div>
        </>
      )}
    </div>
  );
}

export function BookingDetail() {
  const { id = '' } = useParams();
  const { tz, isOwner, me } = useSession();
  const toast = useToast();
  const nav = useNavigate();
  const { data, error, loading, reload } = useLoad<any>(() => get(`/api/admin/bookings/${id}`), [id]);
  const [cancel, setCancel] = useState(false);
  const [link, setLink] = useState<{ url: string | null; emailed: boolean } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorAlert error={error} />;
  const b = data.booking;
  const canManage = isOwner || me.permissions.manageBookings;
  const act = async (to: string) => {
    setErr(null);
    try {
      await post(`/api/admin/bookings/${id}/status`, { to });
      toast(`状態を「${STATUS_LABEL[to]}」にしました`);
      reload();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div>
      <p><Link to="/app/bookings">← 予約一覧</Link></p>
      <div className="row"><h1 style={{ margin: 0 }}>{b.customerName} 様</h1><StatusBadge status={b.status} />{b.forced && <span className="tag">強制予約</span>}</div>
      <ErrorAlert error={err} />
      <div className="grid-2" style={{ marginTop: 12 }}>
        <div className="card">
          <dl className="summary">
            <dt>日時</dt><dd>{fmtDateTime(b.start, tz)}〜{fmtTime(b.end, tz)}</dd>
            <dt>占有時間（準備・片付け含む）</dt><dd className="small">{fmtTime(b.occupiedStart, tz)}〜{fmtTime(b.occupiedEnd, tz)}</dd>
            <dt>サービス</dt><dd>{b.serviceName}（{b.serviceSnapshot.durationMin}分）</dd>
            <dt>担当</dt><dd>{b.staffName ?? '—'}</dd>
            {b.resources.length > 0 && (<><dt>リソース</dt><dd>{b.resources.map((r: any) => r.name).join('、')}</dd></>)}
            <dt>人数</dt><dd>{b.partySize}名</dd>
            <dt>経路</dt><dd>{SOURCE_LABEL[b.source]}</dd>
            <dt>予約番号</dt><dd>{b.refCode}</dd>
            {b.forcedReason && (<><dt>強制予約の理由</dt><dd>{b.forcedReason}</dd></>)}
            {b.cancelReason && (<><dt>キャンセル理由</dt><dd>{b.cancelReason}</dd></>)}
            {b.rescheduledFromId && (<><dt>変更元</dt><dd><Link to={`/app/bookings/${b.rescheduledFromId}`}>変更前の予約</Link></dd></>)}
            {b.rescheduledToId && (<><dt>変更先</dt><dd><Link to={`/app/bookings/${b.rescheduledToId}`}>変更後の予約</Link></dd></>)}
          </dl>
          <div className="btn-row">
            {b.status === 'confirmed' && <button className="btn-primary" onClick={() => act('checked_in')}>来店・開始</button>}
            {['confirmed', 'checked_in'].includes(b.status) && <button className="btn-primary" onClick={() => act('completed')}>完了</button>}
            {b.status === 'confirmed' && Date.parse(b.start) <= Date.now() && <button onClick={() => act('no_show')}>無断欠席</button>}
            {['checked_in', 'no_show'].includes(b.status) && <button onClick={() => act('confirmed')}>予約確定に戻す</button>}
            {b.status === 'confirmed' && canManage && <Link className="btn" to={`/app/new?reschedule=${b.id}`}>日時を変更</Link>}
            {['confirmed', 'checked_in'].includes(b.status) && canManage && <button onClick={() => setCancel(true)}>キャンセル</button>}
            {['completed', 'checked_in'].includes(b.status) && <Link className="btn" to={`/app/new${qs({ customerId: b.customerId, customerName: b.customerName, serviceId: b.serviceId, staffId: b.staffId ?? undefined })}`}>次回予約</Link>}
          </div>
        </div>
        <div className="card">
          <h2>お客様</h2>
          <p>
            {me.permissions.viewCustomers || isOwner ? <Link to={`/app/customers/${b.customerId}`}>{b.customerName}（No.{b.customerNo}）</Link> : b.customerName}
            <br />
            {b.customerPhone && <a href={`tel:${b.customerPhone}`}>{b.customerPhone}</a>} {b.customerEmail && <span className="small">{b.customerEmail}</span>}
          </p>
          {b.customerAdminNote && <p className="small">顧客メモ: {b.customerAdminNote}</p>}
          {b.customerNote && <p className="small">お客様より: {b.customerNote}</p>}
          <h3>事前質問（予約時点の内容）</h3>
          {b.answers.length === 0 ? <p className="muted small">なし</p> : (
            <dl className="summary">{b.answers.map((a: any, i: number) => (<div key={i}><dt>{a.label}</dt><dd>{a.display || '（未回答）'}</dd></div>))}</dl>
          )}
          {canManage && b.status === 'confirmed' && (
            <>
              <h3>予約管理リンク</h3>
              <p className="small muted">リンクを紛失した場合に再発行します（以前のリンクは無効になります）。</p>
              <div className="btn-row">
                <button className="btn-sm" disabled={!b.customerEmail} onClick={async () => { const r = await post(`/api/admin/bookings/${id}/manage-link`, { sendEmail: true }); setLink(r); }}>再発行してメール送信</button>
                <button className="btn-sm" onClick={async () => { const r = await post(`/api/admin/bookings/${id}/manage-link`, { sendEmail: false }); setLink(r); }}>再発行してリンクを表示</button>
              </div>
              {link && (link.url ? <div className="alert alert-info small" style={{ marginTop: 8, wordBreak: 'break-all' }}>このリンクをお客様だけに伝えてください（この画面を閉じると再表示できません）:<br /><code>{link.url}</code></div> : <div className="alert alert-ok small" style={{ marginTop: 8 }}>新しいリンクをメールで送信します。</div>)}
            </>
          )}
        </div>
      </div>
      <div className="card">
        <h2>状態の履歴</h2>
        <table className="table"><thead><tr><th>日時</th><th>変更</th><th>操作者</th><th>メモ</th></tr></thead><tbody>
          {data.history.map((h: any, i: number) => (
            <tr key={i}><td className="nowrap">{fmtShortDateTime(h.at, tz)}</td><td>{h.from ? `${STATUS_LABEL[h.from]} → ` : ''}{STATUS_LABEL[h.to]}</td><td>{h.actorType === 'customer' ? 'お客様' : h.actorType === 'system' ? 'システム' : h.actorName ?? 'スタッフ'}</td><td className="small">{h.reason}</td></tr>
          ))}
        </tbody></table>
      </div>
      <div className="card">
        <h2>通知</h2>
        {data.notifications.length === 0 ? <p className="muted small">なし</p> : (
          <table className="table"><thead><tr><th>種類</th><th>予定</th><th>状態</th><th>送信日時</th></tr></thead><tbody>
            {data.notifications.map((n: any) => (<tr key={n.id}><td>{n.kind}</td><td className="nowrap">{fmtShortDateTime(n.scheduledAt, tz)}</td><td>{NOTIFICATION_STATUS_LABEL[n.status]}{n.lastError ? <div className="small muted">{n.lastError}</div> : null}</td><td>{n.sentAt ? fmtShortDateTime(n.sentAt, tz) : '—'}</td></tr>))}
          </tbody></table>
        )}
      </div>
      {cancel && <CancelDialog booking={b} onClose={() => setCancel(false)} onDone={() => { reload(); nav(`/app/bookings/${id}`); }} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// New booking / availability search / reschedule

interface Draft {
  id: string;
  savedAt: string;
  serviceId: string;
  staffId: string | null;
  start: string;
  occurrenceId: string | null;
  partySize: number;
  customerId?: string;
  customer?: { name: string; email: string; phone: string };
  source: string;
  staffNote: string;
  label: string;
}

function loadDrafts(): Draft[] {
  try {
    return JSON.parse(localStorage.getItem('rf-drafts') ?? '[]');
  } catch {
    return [];
  }
}
function saveDrafts(d: Draft[]) {
  localStorage.setItem('rf-drafts', JSON.stringify(d));
}

export function NewBooking() {
  const { tz, isOwner, me } = useSession();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const online = useOnline();
  const rescheduleId = sp.get('reschedule');
  const services = useLoad<{ services: any[] }>(() => get('/api/admin/services'), []);
  const staff = useLoad<{ staff: any[] }>(() => get('/api/admin/staff'), []);
  const original = useLoad<any>(() => (rescheduleId ? get(`/api/admin/bookings/${rescheduleId}`) : Promise.resolve(null)), [rescheduleId]);
  const today = todayIn(tz);
  const [serviceId, setServiceId] = useState(sp.get('serviceId') ?? '');
  const [staffId, setStaffId] = useState(sp.get('staffId') ?? (me.role === 'staff' && !me.permissions.viewAllBookings ? me.staffId ?? '' : ''));
  const [partySize, setPartySize] = useState(1);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(addDays(today, 6));
  const [win, setWin] = useState({ from: '', to: '' });
  const [results, setResults] = useState<any[] | null>(null);
  const [searchErr, setSearchErr] = useState<unknown>(null);
  const [pick, setPick] = useState<{ start: string; end?: string; staffId: string | null; occurrenceId: string | null } | null>(null);
  const [manual, setManual] = useState({ date: today, time: '10:00' });
  const [manualCheck, setManualCheck] = useState<any>(null);
  const [force, setForce] = useState(false);
  const [forcedReason, setForcedReason] = useState('');
  const [customerId, setCustomerId] = useState(sp.get('customerId') ?? '');
  const [customerLabel, setCustomerLabel] = useState(sp.get('customerName') ?? '');
  const [newCustomer, setNewCustomer] = useState({ name: '', email: '', phone: '' });
  const [source, setSource] = useState('phone');
  const [staffNote, setStaffNote] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [idem] = useState(uuid);
  const [drafts, setDrafts] = useState<Draft[]>(loadDrafts);

  useEffect(() => {
    if (original.data) {
      setServiceId(original.data.booking.serviceId);
      setStaffId(original.data.booking.staffId ?? '');
      setPartySize(original.data.booking.partySize);
    }
  }, [original.data]);

  const svc = services.data?.services.find((s) => s.id === serviceId);
  const staffForSvc = useMemo(() => (staff.data?.staff ?? []).filter((s) => !s.archived && s.serviceIds.includes(serviceId)), [staff.data, serviceId]);
  const staffName = (id: string | null) => staff.data?.staff.find((s) => s.id === id)?.displayName ?? 'おまかせ';

  const search = async () => {
    setSearchErr(null);
    setResults(null);
    setPick(null);
    try {
      const r = await get(`/api/admin/availability${qs({ serviceId, staffId: staffId || undefined, from, to, partySize, timeFromMin: win.from ? timeToMin(win.from) : undefined, timeToMin: win.to ? timeToMin(win.to) : undefined, excludeBookingId: rescheduleId ?? undefined })}`);
      setResults(r.slots);
    } catch (e) {
      setSearchErr(e);
    }
  };

  const checkManual = async () => {
    const iso = localToIso(manual.date, manual.time, tz);
    if (!iso) {
      setManualCheck({ ok: false, reasons: [{ message: 'この時刻は夏時間の切り替えで存在しません' }] });
      return;
    }
    const r = await post('/api/admin/availability/check', { serviceId, staffId: staffId || null, start: iso, partySize, mode: force ? 'force' : 'admin', excludeBookingId: rescheduleId ?? undefined });
    setManualCheck(r);
    if (r.ok) setPick({ start: iso, staffId: r.staffId, occurrenceId: null });
    else setPick(null);
  };

  const confirm = async () => {
    if (!pick) return;
    setBusy(true);
    setErr(null);
    try {
      if (rescheduleId) {
        const r = await post(`/api/admin/bookings/${rescheduleId}/reschedule`, { start: pick.occurrenceId ? undefined : pick.start, occurrenceId: pick.occurrenceId ?? undefined, staffId: pick.occurrenceId ? undefined : pick.staffId, force, forcedReason: force ? forcedReason : undefined });
        toast('日時を変更しました');
        nav(`/app/bookings/${r.id}`);
      } else {
        const r = await post('/api/admin/bookings', {
          serviceId,
          staffId: pick.occurrenceId ? null : pick.staffId,
          start: pick.occurrenceId ? undefined : pick.start,
          occurrenceId: pick.occurrenceId ?? undefined,
          partySize,
          customerId: customerId || undefined,
          customer: customerId ? undefined : { name: newCustomer.name, email: newCustomer.email || null, phone: newCustomer.phone || null },
          source,
          staffNote,
          force,
          forcedReason: force ? forcedReason : undefined,
          idempotencyKey: idem,
        });
        toast(`予約を確定しました（${r.refCode}）`);
        nav(`/app/bookings/${r.id}`);
      }
    } catch (e) {
      setErr(e);
      if (e instanceof ApiError && e.code === 'SLOT_UNAVAILABLE') {
        setPick(null);
        if (results) search();
      }
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = () => {
    if (!pick) return;
    const d: Draft = {
      id: uuid(),
      savedAt: new Date().toISOString(),
      serviceId,
      staffId: pick.staffId,
      start: pick.start,
      occurrenceId: pick.occurrenceId,
      partySize,
      customerId: customerId || undefined,
      customer: customerId ? undefined : newCustomer,
      source,
      staffNote,
      label: `${fmtShortDateTime(pick.start, tz)} ${svc?.name ?? ''} ${customerId ? customerLabel : newCustomer.name}`,
    };
    const next = [d, ...drafts];
    setDrafts(next);
    saveDrafts(next);
    toast('下書き（未確定）として保存しました。接続後に空き状況を再確認して確定してください。');
  };

  const resumeDraft = (d: Draft) => {
    setServiceId(d.serviceId);
    setStaffId(d.staffId ?? '');
    setPartySize(d.partySize);
    setPick({ start: d.start, staffId: d.staffId, occurrenceId: d.occurrenceId });
    if (d.customerId) setCustomerId(d.customerId);
    else if (d.customer) setNewCustomer(d.customer);
    setSource(d.source);
    setStaffNote(d.staffNote);
    const next = drafts.filter((x) => x.id !== d.id);
    setDrafts(next);
    saveDrafts(next);
    setManualCheck(null);
    // always re-validate against the latest availability before confirming
    post('/api/admin/availability/check', { serviceId: d.serviceId, staffId: d.staffId, start: d.start, occurrenceId: d.occurrenceId ?? undefined, partySize: d.partySize, mode: 'admin' })
      .then((r) => {
        setManualCheck(r);
        if (!r.ok) setPick(null);
      })
      .catch((e) => setErr(e));
  };

  const grouped = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const s of results ?? []) {
      if (!m.has(s.date)) m.set(s.date, []);
      m.get(s.date)!.push(s);
    }
    return [...m.entries()];
  }, [results]);

  const customerReady = customerId || newCustomer.name.trim();

  return (
    <div>
      <h1>{rescheduleId ? '予約の日時を変更' : '新規予約・空き検索'}</h1>
      {rescheduleId && original.data && (
        <div className="alert alert-info">変更元: {original.data.booking.customerName} 様 {fmtDateTime(original.data.booking.start, tz)}「{original.data.booking.serviceName}」。新しい枠が確保できた時点で元の枠は解放されます。</div>
      )}
      {drafts.length > 0 && (
        <div className="card">
          <h2>未確定の下書き（オフライン時に作成）</h2>
          <p className="small muted">下書きは予約ではありません。空き状況を再確認してから確定してください。</p>
          <ul className="list">
            {drafts.map((d) => (
              <li key={d.id} className="list-item">
                <span style={{ flex: 1 }}>{d.label}<br /><span className="small muted">保存: {fmtShortDateTime(d.savedAt, tz)}</span></span>
                <button className="btn-sm" disabled={!online} onClick={() => resumeDraft(d)}>空きを再確認</button>
                <button className="btn-sm" onClick={() => { const n = drafts.filter((x) => x.id !== d.id); setDrafts(n); saveDrafts(n); }}>削除</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="card">
        <h2>1. 条件</h2>
        <div className="grid-2">
          <Field label="サービス" required>
            {(p) => (
              <select {...p} value={serviceId} disabled={!!rescheduleId} onChange={(e) => { setServiceId(e.target.value); setResults(null); setPick(null); }}>
                <option value="">選択してください</option>
                {services.data?.services.filter((s) => !s.archived).map((s) => <option key={s.id} value={s.id}>{s.name}（{s.durationMin}分）{s.isPublic ? '' : ' [非公開]'}</option>)}
              </select>
            )}
          </Field>
          <Field label="担当">
            {(p) => (
              <select {...p} value={staffId} onChange={(e) => { setStaffId(e.target.value); setResults(null); setPick(null); }}>
                {(isOwner || me.permissions.viewAllBookings) && <option value="">指名なし（おまかせ）</option>}
                {staffForSvc.map((s) => <option key={s.id} value={s.id}>{s.displayName}</option>)}
              </select>
            )}
          </Field>
        </div>
        <div className="grid-2">
          <div className="grid-2">
            <Field label="検索期間（から）">{(p) => <input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
            <Field label="（まで）">{(p) => <input {...p} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />}</Field>
          </div>
          <div className="grid-2">
            <Field label="時間帯（から）">{(p) => <input {...p} type="time" value={win.from} onChange={(e) => setWin({ ...win, from: e.target.value })} />}</Field>
            <Field label="（まで）">{(p) => <input {...p} type="time" value={win.to} onChange={(e) => setWin({ ...win, to: e.target.value })} />}</Field>
          </div>
        </div>
        {svc && svc.maxPartySize > 1 && !rescheduleId && (
          <Field label="人数">{(p) => <input {...p} type="number" min={1} max={svc.maxPartySize} value={partySize} onChange={(e) => setPartySize(Math.max(1, Number(e.target.value)))} style={{ width: 120 }} />}</Field>
        )}
        <button className="btn-primary" disabled={!serviceId || !online} onClick={search}>空きを検索</button>
        {!online && <p className="small muted">オフライン中は空き検索できません。</p>}
        <ErrorAlert error={searchErr} />
        {results && (
          <div style={{ marginTop: 12 }}>
            {results.length === 0 && <p>条件に合う空きはありません。</p>}
            {grouped.map(([d, list]) => (
              <div key={d} style={{ marginBottom: 12 }}>
                <h3>{dateLabel(d)}</h3>
                <div className="times">
                  {list.flatMap((s: any) =>
                    (s.staff.length ? s.staff : [{ id: null, name: '' }]).map((st: any) => (
                      <button key={s.start + (st.id ?? '') + (s.occurrenceId ?? '')} className="time-btn" aria-pressed={pick?.start === s.start && pick?.staffId === st.id} onClick={() => { setPick({ start: s.start, end: s.end, staffId: s.occurrenceId ? null : st.id, occurrenceId: s.occurrenceId }); setManualCheck(null); }}>
                        <span>{fmtTime(s.start, tz)}</span>
                        <small>{st.name}{s.remaining !== null ? ` 残${s.remaining}` : ''}</small>
                      </button>
                    )),
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {svc && svc.bookingMode === 'slots' && (
          <details style={{ marginTop: 12 }}>
            <summary>時刻を直接指定する（刻みにない時刻・当日の飛び込み等）</summary>
            <div className="row" style={{ marginTop: 8 }}>
              <input type="date" aria-label="日付" value={manual.date} onChange={(e) => setManual({ ...manual, date: e.target.value })} style={{ width: 170 }} />
              <input type="time" aria-label="開始時刻" step={300} value={manual.time} onChange={(e) => setManual({ ...manual, time: e.target.value })} style={{ width: 130 }} />
              <button onClick={checkManual} disabled={!serviceId || !online}>予約できるか確認</button>
            </div>
            {isOwner && (
              <div style={{ marginTop: 8 }}>
                <label className="check"><input type="checkbox" checked={force} onChange={(e) => { setForce(e.target.checked); setManualCheck(null); setPick(null); }} /><span>強制予約（営業時間・勤務時間・ブロックの制限を外す。<strong>他の予約との重複・定員超過はできません</strong>）</span></label>
                {force && <Field label="強制予約の理由" required>{(p) => <input {...p} type="text" value={forcedReason} onChange={(e) => setForcedReason(e.target.value)} maxLength={300} />}</Field>}
              </div>
            )}
            {manualCheck && (manualCheck.ok ? <div className="alert alert-ok">予約できます（担当: {staffName(manualCheck.staffId)}）</div> : <ErrorAlert error={new ApiError(409, 'NG', '予約できません', { reasons: manualCheck.reasons })} />)}
          </details>
        )}
      </div>

      {pick && (
        <div className="card">
          <h2>2. {rescheduleId ? '変更内容の確認' : 'お客様と確定'}</h2>
          <p><strong>{fmtDateTime(pick.start, tz)}</strong> ・ {svc?.name} ・ 担当 {pick.occurrenceId ? '開催回の担当' : staffName(pick.staffId)}{partySize > 1 ? ` ・ ${partySize}名` : ''}</p>
          {!rescheduleId && (
            <>
              <CustomerPicker customerId={customerId} label={customerLabel} onPick={(id, label) => { setCustomerId(id); setCustomerLabel(label); }} />
              {!customerId && (
                <div className="grid-3">
                  <Field label="新しい顧客の氏名" required>{(p) => <input {...p} type="text" value={newCustomer.name} onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })} />}</Field>
                  <Field label="電話">{(p) => <input {...p} type="tel" value={newCustomer.phone} onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })} />}</Field>
                  <Field label="メール" hint="入力すると確認メールが送られます">{(p) => <input {...p} type="email" value={newCustomer.email} onChange={(e) => setNewCustomer({ ...newCustomer, email: e.target.value })} />}</Field>
                </div>
              )}
              <div className="grid-2">
                <Field label="予約経路">
                  {(p) => (
                    <select {...p} value={source} onChange={(e) => setSource(e.target.value)}>
                      {['phone', 'walk_in', 'dm', 'email', 'other'].map((k) => <option key={k} value={k}>{SOURCE_LABEL[k]}</option>)}
                    </select>
                  )}
                </Field>
                <Field label="スタッフメモ">{(p) => <input {...p} type="text" value={staffNote} onChange={(e) => setStaffNote(e.target.value)} maxLength={2000} />}</Field>
              </div>
            </>
          )}
          <ErrorAlert error={err} />
          <div className="btn-row">
            <button className="btn-primary" disabled={busy || !online || (!rescheduleId && !customerReady) || (force && !forcedReason.trim())} onClick={confirm}>
              {busy ? '確定中…' : rescheduleId ? 'この日時に変更する' : '予約を確定する'}
            </button>
            {!rescheduleId && <button onClick={saveDraft} disabled={!customerReady}>下書き（未確定）として保存</button>}
          </div>
          {!online && <p className="small muted">オフラインのため確定できません。下書きに保存し、接続後に空き状況を再確認して確定してください。</p>}
          <p className="small muted">確定時にサーバーで最新の空き状況を再確認します。直前に埋まった場合は確定されません。</p>
        </div>
      )}
      <p className="small muted">時刻は事業者のタイムゾーン（{tz}）で表示しています。</p>
    </div>
  );
}

function CustomerPicker({ customerId, label, onPick }: { customerId: string; label: string; onPick: (id: string, label: string) => void }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<any[] | null>(null);
  const [open, setOpen] = useState(false);
  if (customerId)
    return (
      <div className="row" style={{ marginBottom: 12 }}>
        <span>顧客: <strong>{label}</strong></span>
        <button className="btn-sm" onClick={() => onPick('', '')}>別の顧客にする</button>
      </div>
    );
  return (
    <div className="field">
      <label htmlFor="cust-q">既存の顧客を検索（氏名・電話・メール・顧客番号）</label>
      <div className="row">
        <input id="cust-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), (document.getElementById('cust-q-btn') as HTMLButtonElement).click())} />
        <button id="cust-q-btn" type="button" onClick={async () => { const r = await get(`/api/admin/customers${qs({ q, pageSize: 10 })}`); setList(r.customers); setOpen(true); }}>検索</button>
      </div>
      {open && list && (
        <Modal title="顧客を選択" onClose={() => setOpen(false)}>
          {list.length === 0 && <p>見つかりません。新しい顧客として入力してください。</p>}
          <ul className="list">
            {list.map((c) => (
              <li key={c.id}>
                <button className="list-item" style={{ width: '100%', border: 0, textAlign: 'left' }} onClick={() => { onPick(c.id, `${c.name}（No.${c.customerNo}）`); setOpen(false); }}>
                  <span><strong>{c.name}</strong> <span className="small muted">No.{c.customerNo} {c.phone ?? ''} {c.email ?? ''}</span></span>
                </button>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  );
}

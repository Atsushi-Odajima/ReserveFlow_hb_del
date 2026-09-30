import { useEffect, useRef, useState } from 'react';
import { ApiError, post, saveBlob } from '../api';
import { Confirm, ErrorAlert, Loading, StatusBadge } from '../components/ui';
import { addDays, dateLabel, fmtDateLong, fmtTime, todayIn } from '../format';
import { applyTheme } from './BookingPage';

interface View {
  booking: {
    refCode: string;
    status: string;
    start: string;
    end: string;
    partySize: number;
    serviceName: string;
    staffName: string | null;
    bookingMode: 'slots' | 'sessions';
    customerName: string;
    answers: Array<{ label: string; display: string }>;
    note: string;
    canChange: boolean;
    canCancel: boolean;
    changeDeadline: string;
    cancelDeadline: string;
  };
  business: { slug: string; name: string; phone: string | null; email: string | null; timezone: string; themeColor: string; notes: string };
}

const TOKEN_KEY = 'rf-manage-token';

/** Token arrives in the URL fragment (#t=...). It is moved to sessionStorage and removed from the address bar. */
function takeToken(): string | null {
  const m = window.location.hash.match(/t=([A-Za-z0-9_-]{20,100})/);
  if (m) {
    sessionStorage.setItem(TOKEN_KEY, m[1]);
    history.replaceState(null, '', '/manage');
    return m[1];
  }
  return sessionStorage.getItem(TOKEN_KEY);
}

export default function ManagePage() {
  const [token] = useState(takeToken);
  const [view, setView] = useState<View | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [mode, setMode] = useState<'view' | 'change' | 'cancel'>('view');
  const [msg, setMsg] = useState<string | null>(null);
  const h1 = useRef<HTMLHeadingElement>(null);

  const load = async () => {
    if (!token) return;
    try {
      const v = await post<View>('/api/manage/view', { token });
      setView(v);
      applyTheme(v.business.themeColor);
    } catch (e) {
      setErr(e);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => h1.current?.focus(), [mode, view?.booking.refCode]);

  if (!token || (err instanceof ApiError && err.status === 404))
    return (
      <div className="pub">
        <div className="pub-body">
          <h1>リンクが無効です</h1>
          <p>リンクの有効期限が切れたか、再発行により無効になりました。お手数ですがお店へ直接お問い合わせください。</p>
        </div>
      </div>
    );
  if (!view)
    return (
      <div className="pub">
        <div className="pub-body">
          <ErrorAlert error={err} />
          <Loading />
        </div>
      </div>
    );
  const { booking: bk, business: biz } = view;
  const tz = biz.timezone;

  return (
    <div className="pub">
      <header className="pub-header">
        <div>
          <div style={{ fontWeight: 800 }}>{biz.name}</div>
          <div className="small muted">予約の確認・変更</div>
        </div>
      </header>
      <main className="pub-body">
        {msg && <div className="alert alert-ok" role="status">{msg}</div>}
        {mode === 'view' && (
          <section>
            <h1 tabIndex={-1} ref={h1}>ご予約内容</h1>
            <dl className="summary card">
              <dt>状態</dt>
              <dd><StatusBadge status={bk.status} /></dd>
              <dt>予約番号</dt>
              <dd>{bk.refCode}</dd>
              <dt>日時</dt>
              <dd>{fmtDateLong(bk.start, tz)} {fmtTime(bk.start, tz)}〜{fmtTime(bk.end, tz)}</dd>
              <dt>メニュー</dt>
              <dd>{bk.serviceName}</dd>
              {bk.staffName && (<><dt>担当</dt><dd>{bk.staffName}</dd></>)}
              {bk.partySize > 1 && (<><dt>人数</dt><dd>{bk.partySize}名</dd></>)}
              <dt>お名前</dt>
              <dd>{bk.customerName} 様</dd>
              {bk.answers.map((a, i) => (<div key={i}><dt>{a.label}</dt><dd>{a.display || '（未回答）'}</dd></div>))}
            </dl>
            {bk.status === 'confirmed' && (
              <>
                <div className="btn-row">
                  <button className="btn-primary" disabled={!bk.canChange} onClick={() => setMode('change')}>日時を変更する</button>
                  <button disabled={!bk.canCancel} onClick={() => setMode('cancel')}>キャンセルする</button>
                  <button
                    onClick={async () => {
                      const r = await fetch('/api/manage/ics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
                      if (r.ok) saveBlob(await r.blob(), `booking-${bk.refCode}.ics`);
                    }}
                  >
                    カレンダーに追加
                  </button>
                </div>
                <p className="small muted" style={{ marginTop: 8 }}>
                  変更期限: {fmtDateLong(bk.changeDeadline, tz)} {fmtTime(bk.changeDeadline, tz)} ／ キャンセル期限: {fmtDateLong(bk.cancelDeadline, tz)} {fmtTime(bk.cancelDeadline, tz)}
                </p>
                {(!bk.canChange || !bk.canCancel) && (
                  <div className="alert alert-warn small">期限を過ぎたため、この画面からは手続きできません。お店へ直接ご連絡ください。{biz.phone && <> 電話: <a href={`tel:${biz.phone.replace(/[^0-9+]/g, '')}`}>{biz.phone}</a></>}</div>
                )}
              </>
            )}
            {biz.notes && <div className="alert alert-info small" style={{ whiteSpace: 'pre-wrap', marginTop: 12 }}>{biz.notes}</div>}
            <p className="small muted" style={{ marginTop: 16 }}>このページのURLはあなた専用です。他の人に共有しないでください。</p>
          </section>
        )}
        {mode === 'change' && (
          <Reschedule token={token} view={view} h1={h1} onDone={(v) => { setView(v); setMode('view'); setMsg('日時を変更しました。確認メールをお送りします。'); }} onCancel={() => setMode('view')} />
        )}
        {mode === 'cancel' && (
          <Confirm
            title="予約をキャンセルしますか？"
            message={<p>{fmtDateLong(bk.start, tz)} {fmtTime(bk.start, tz)} の「{bk.serviceName}」をキャンセルします。この操作は取り消せません。</p>}
            confirmLabel="キャンセルする"
            danger
            onClose={() => setMode('view')}
            onConfirm={async () => {
              const reason = (document.getElementById('cancel-reason') as HTMLTextAreaElement | null)?.value ?? '';
              const v = await post<View>('/api/manage/cancel', { token, reason });
              setView(v);
              setMsg('キャンセルを承りました。');
            }}
          >
            <div className="field">
              <label htmlFor="cancel-reason">理由（任意）</label>
              <textarea id="cancel-reason" maxLength={500} />
            </div>
          </Confirm>
        )}
      </main>
    </div>
  );
}

function Reschedule({ token, view, h1, onDone, onCancel }: { token: string; view: View; h1: React.RefObject<HTMLHeadingElement | null>; onDone: (v: View) => void; onCancel: () => void }) {
  const tz = view.business.timezone;
  const today = todayIn(tz);
  const [from, setFrom] = useState(today);
  const [data, setData] = useState<{ dates: Record<string, Array<{ start: string; end: string; occurrenceId: string | null; remaining: number | null }>>; lastDate: string } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<{ start: string; occurrenceId: string | null } | null>(null);
  const load = async () => {
    setErr(null);
    try {
      setData(await post('/api/manage/slots', { token, from, to: addDays(from, 13) }));
    } catch (e) {
      setErr(e);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from]);
  const dates = Object.keys(data?.dates ?? {}).sort();
  return (
    <section>
      <h1 tabIndex={-1} ref={h1}>変更先の日時を選んでください</h1>
      <p className="small muted">現在: {fmtDateLong(view.booking.start, tz)} {fmtTime(view.booking.start, tz)}。新しい日時が確保できた時点で、元の予約は自動で取り消されます（確保できなかった場合は元の予約のまま）。</p>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn-sm" disabled={from <= today} onClick={() => setFrom(addDays(from, -14))}>‹ 前の2週間</button>
        <span className="spacer" />
        <button className="btn-sm" disabled={!!data && addDays(from, 14) > data.lastDate} onClick={() => setFrom(addDays(from, 14))}>次の2週間 ›</button>
      </div>
      <ErrorAlert error={err} />
      {!data ? <Loading /> : dates.length === 0 ? <p>この期間に空きはありません。</p> : null}
      {dates.map((d) => (
        <div key={d} style={{ marginBottom: 12 }}>
          <h2 style={{ fontSize: '1rem' }}>{dateLabel(d)}</h2>
          <div className="times">
            {data!.dates[d].map((s) => (
              <button key={s.start + (s.occurrenceId ?? '')} className="time-btn" aria-pressed={pick?.start === s.start} onClick={() => setPick(s)}>
                {fmtTime(s.start, tz)}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="sticky-actions">
        <button onClick={onCancel} disabled={busy}>やめる</button>
        <button
          className="btn-primary"
          disabled={!pick || busy}
          onClick={async () => {
            if (!pick) return;
            setBusy(true);
            setErr(null);
            try {
              const r = await post<View & { ok: true }>('/api/manage/reschedule', { token, start: pick.occurrenceId ? undefined : pick.start, occurrenceId: pick.occurrenceId ?? undefined });
              onDone(r);
            } catch (e) {
              setErr(e);
              setPick(null);
              load();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? '変更中…' : pick ? `${fmtTime(pick.start, tz)} に変更する` : '時間を選んでください'}
        </button>
      </div>
    </section>
  );
}

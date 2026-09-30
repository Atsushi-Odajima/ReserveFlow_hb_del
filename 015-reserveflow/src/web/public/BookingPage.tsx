import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, get, post, qs, uuid } from '../api';
import { ErrorAlert, Field, Loading, useLoad } from '../components/ui';
import { addDays, dateLabel, fmtDateLong, fmtTime, monthGrid, todayIn } from '../format';
import { WEEKDAYS } from '../../shared/labels';

interface PubService {
  id: string;
  name: string;
  description: string;
  category: string;
  durationMin: number;
  priceText: string;
  capacity: number;
  maxPartySize: number;
  requiresStaff: boolean;
  bookingMode: 'slots' | 'sessions';
  notes: string;
  staffIds: string[];
}
interface PubProfile {
  business: {
    slug: string;
    name: string;
    description: string;
    phone: string | null;
    email: string | null;
    address: string | null;
    websiteUrl: string | null;
    snsUrl: string | null;
    timezone: string;
    weekStart: number;
    themeColor: string;
    completionMessage: string;
    notes: string;
    phoneRequirement: 'required' | 'optional' | 'hidden';
    consentText: string;
    minNoticeMin: number;
    maxAdvanceDays: number;
    changeDeadlineMin: number;
    cancelDeadlineMin: number;
    logoUrl: string | null;
    turnstileSiteKey: string | null;
  };
  services: PubService[];
  staff: Array<{ id: string; name: string; profile: string }>;
}
interface SlotDto {
  start: string;
  end: string;
  remaining: number | null;
  occurrenceId: string | null;
}
interface Question {
  id: string;
  type: 'short_text' | 'long_text' | 'single_choice' | 'multi_choice' | 'yes_no' | 'confirm';
  label: string;
  helpText: string;
  required: boolean;
  options: Array<{ id: string; label: string }>;
}

type Step = 'service' | 'staff' | 'date' | 'time' | 'customer' | 'questions' | 'confirm' | 'done' | 'waitlist';

export function applyTheme(color: string) {
  document.documentElement.style.setProperty('--brand', color);
  document.documentElement.style.setProperty('--brand-soft', `${color}1a`);
}

export default function BookingPage() {
  const { slug = '' } = useParams();
  const { data: profile, error: loadErr, loading } = useLoad<PubProfile>(() => get(`/api/public/${encodeURIComponent(slug)}`), [slug]);
  const storeKey = `rf-book-${slug}`;
  const saved = useMemo(() => {
    try {
      return JSON.parse(sessionStorage.getItem(storeKey) ?? 'null');
    } catch {
      return null;
    }
  }, [storeKey]);

  const [step, setStep] = useState<Step>('service');
  const [serviceId, setServiceId] = useState<string | null>(saved?.serviceId ?? null);
  const [staffId, setStaffId] = useState<string | null>(saved?.staffId ?? null);
  const [partySize, setPartySize] = useState<number>(saved?.partySize ?? 1);
  const [date, setDate] = useState<string | null>(null);
  const [slot, setSlot] = useState<SlotDto | null>(null);
  const [customer, setCustomer] = useState<{ name: string; email: string; phone: string }>(saved?.customer ?? { name: '', email: '', phone: '' });
  const [note, setNote] = useState<string>(saved?.note ?? '');
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitErr, setSubmitErr] = useState<unknown>(null);
  const [alternatives, setAlternatives] = useState<SlotDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ refCode: string; start: string; end: string; manageToken: string | null } | null>(null);
  const [slotsVersion, setSlotsVersion] = useState(0);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const idemKey = useRef<{ sig: string; key: string } | null>(null);
  const startedAt = useRef(Date.now());
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (profile) {
      applyTheme(profile.business.themeColor);
      document.title = `${profile.business.name} | ご予約`;
    }
  }, [profile]);
  useEffect(() => {
    sessionStorage.setItem(storeKey, JSON.stringify({ serviceId, staffId, partySize, customer, note }));
  }, [storeKey, serviceId, staffId, partySize, customer, note]);
  useEffect(() => {
    headingRef.current?.focus();
    window.scrollTo(0, 0);
  }, [step]);

  const service = profile?.services.find((s) => s.id === serviceId) ?? null;
  const tz = profile?.business.timezone ?? 'Asia/Tokyo';
  const needsStaffStep = !!service && service.requiresStaff && service.bookingMode === 'slots' && service.staffIds.length > 1;
  const questions = useLoad<{ questions: Question[] }>(() => (serviceId ? get(`/api/public/${slug}/services/${serviceId}/questions`) : Promise.resolve({ questions: [] })), [slug, serviceId]);
  const qList = questions.data?.questions ?? [];

  const flow: Step[] = ['service', ...(needsStaffStep ? (['staff'] as Step[]) : []), 'date', 'time', 'customer', ...(qList.length ? (['questions'] as Step[]) : []), 'confirm'];
  const stepLabels: Record<string, string> = { service: 'メニュー', staff: '担当', date: '日付', time: '時間', customer: 'お客様情報', questions: '事前質問', confirm: '確認' };
  const go = (s: Step) => setStep(s);
  const next = () => {
    const i = flow.indexOf(step);
    go(flow[Math.min(i + 1, flow.length - 1)]);
  };
  const back = () => {
    const i = flow.indexOf(step);
    if (i > 0) go(flow[i - 1]);
  };

  if (loading) return <div className="pub"><div className="pub-body"><Loading /></div></div>;
  if (loadErr || !profile)
    return (
      <div className="pub">
        <div className="pub-body">
          <h1>予約ページが見つかりません</h1>
          <p className="muted">URLをご確認いただくか、お店に直接お問い合わせください。</p>
        </div>
      </div>
    );

  const b = profile.business;

  const validateCustomer = () => {
    const e: Record<string, string> = {};
    if (!customer.name.trim()) e.name = 'お名前を入力してください';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email.trim())) e.email = 'メールアドレスを正しく入力してください';
    if (b.phoneRequirement === 'required' && !customer.phone.trim()) e.phone = '電話番号を入力してください';
    if (customer.phone && !/^[0-9０-９+\-()\s]*$/.test(customer.phone)) e.phone = '電話番号は数字とハイフンで入力してください';
    setErrors(e);
    return Object.keys(e).length === 0;
  };
  const validateAnswers = () => {
    const e: Record<string, string> = {};
    for (const q of qList) {
      const v = answers[q.id];
      const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) || (q.type === 'confirm' && v !== true);
      if (q.required && empty) e[q.id] = q.type === 'confirm' ? '確認のチェックが必要です' : '回答してください';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!service || !slot) return;
    if (b.consentText && !consent) {
      setErrors({ consent: '同意が必要です' });
      return;
    }
    const sig = JSON.stringify([service.id, staffId, slot.start, slot.occurrenceId, partySize]);
    if (!idemKey.current || idemKey.current.sig !== sig) idemKey.current = { sig, key: uuid() };
    setBusy(true);
    setSubmitErr(null);
    setAlternatives([]);
    try {
      const r = await post(`/api/public/${slug}/bookings`, {
        serviceId: service.id,
        staffId: service.bookingMode === 'slots' ? staffId : null,
        start: service.bookingMode === 'slots' ? slot.start : undefined,
        occurrenceId: slot.occurrenceId ?? undefined,
        partySize,
        customer: { name: customer.name, email: customer.email, phone: b.phoneRequirement === 'hidden' ? null : customer.phone || null },
        answers: qList.map((q) => ({ questionId: q.id, value: answers[q.id] ?? null })),
        note,
        consent,
        idempotencyKey: idemKey.current.key,
        elapsedMs: Date.now() - startedAt.current,
        website: (document.getElementById('rf-website') as HTMLInputElement | null)?.value ?? '',
        turnstileToken: captcha ?? undefined,
      });
      setDone(r);
      sessionStorage.removeItem(storeKey);
      setStep('done');
    } catch (e) {
      setSubmitErr(e);
      if (e instanceof ApiError && e.code === 'SLOT_UNAVAILABLE') {
        setAlternatives(e.details?.alternatives ?? []);
        setSlotsVersion((v) => v + 1);
        idemKey.current = null;
      }
      if (e instanceof ApiError && e.fieldErrors) setErrors(e.fieldErrors);
    } finally {
      setBusy(false);
    }
  };

  const idx = flow.indexOf(step);

  return (
    <div className="pub">
      <a href="#main" className="skip-link">本文へ移動</a>
      <header className="pub-header">
        {b.logoUrl && <img src={b.logoUrl} alt="" />}
        <div>
          <div style={{ fontWeight: 800, fontSize: '1.1rem' }}>{b.name}</div>
          <div className="small muted">オンライン予約</div>
        </div>
      </header>
      {step !== 'done' && step !== 'waitlist' && (
        <ol className="steps" aria-label="予約の進み具合">
          {flow.map((s, i) => (
            <li key={s} aria-current={s === step ? 'step' : undefined} className={i < idx ? 'done' : undefined}>
              {i < idx ? '✓ ' : `${i + 1}. `}
              {stepLabels[s]}
            </li>
          ))}
        </ol>
      )}
      <main id="main" className="pub-body">
        {step === 'service' && (
          <section>
            <h1 tabIndex={-1} ref={headingRef}>メニューを選んでください</h1>
            {b.description && <p className="muted">{b.description}</p>}
            {profile.services.length === 0 && <p>現在オンラインで受け付けているメニューはありません。</p>}
            {profile.services.map((s) => (
              <button
                key={s.id}
                className="choice"
                aria-pressed={serviceId === s.id}
                onClick={() => {
                  if (serviceId !== s.id) {
                    setServiceId(s.id);
                    setStaffId(null);
                    setSlot(null);
                    setDate(null);
                    setPartySize(1);
                    setAnswers({});
                  }
                  go(s.requiresStaff && s.bookingMode === 'slots' && s.staffIds.length > 1 ? 'staff' : 'date');
                }}
              >
                <span className="t">{s.name}</span>
                <span className="small muted">
                  {s.durationMin}分{s.priceText ? ` ・ ${s.priceText}` : ''}
                  {s.capacity > 1 ? ` ・ 定員${s.capacity}名` : ''}
                </span>
                {s.description && <span className="small" style={{ display: 'block', marginTop: 4 }}>{s.description}</span>}
              </button>
            ))}
            {b.notes && (
              <div className="alert alert-info small" style={{ whiteSpace: 'pre-wrap' }}>
                <strong>ご予約前にお読みください</strong>
                <br />
                {b.notes}
              </div>
            )}
            <BusinessContact b={b} />
          </section>
        )}

        {step === 'staff' && service && (
          <section>
            <h1 tabIndex={-1} ref={headingRef}>担当者を選んでください</h1>
            <button className="choice" aria-pressed={staffId === null} onClick={() => { setStaffId(null); setSlot(null); go('date'); }}>
              <span className="t">指名なし（おまかせ）</span>
              <span className="small muted">空いている担当者でご案内します</span>
            </button>
            {profile.staff
              .filter((st) => service.staffIds.includes(st.id))
              .map((st) => (
                <button key={st.id} className="choice" aria-pressed={staffId === st.id} onClick={() => { setStaffId(st.id); setSlot(null); go('date'); }}>
                  <span className="t">{st.name}</span>
                  {st.profile && <span className="small muted">{st.profile}</span>}
                </button>
              ))}
            <div className="sticky-actions"><button onClick={back}>戻る</button></div>
          </section>
        )}

        {(step === 'date' || step === 'time') && service && (
          <DateTimeStep
            key={`${service.id}-${staffId}-${partySize}`}
            slug={slug}
            profile={profile}
            service={service}
            staffId={staffId}
            partySize={partySize}
            setPartySize={(n) => { setPartySize(n); setSlot(null); }}
            date={date}
            setDate={(d) => { setDate(d); setSlot(null); go('time'); }}
            slot={slot}
            setSlot={(s) => { setSlot(s); go('customer'); }}
            step={step}
            headingRef={headingRef}
            onBack={() => (step === 'time' ? go('date') : back())}
            onWaitlist={() => go('waitlist')}
            version={slotsVersion}
          />
        )}

        {step === 'customer' && (
          <section>
            <h1 tabIndex={-1} ref={headingRef}>お客様情報</h1>
            <form
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                if (validateCustomer()) next();
              }}
            >
              <Field label="お名前" required error={errors.name}>
                {(p) => <input {...p} type="text" autoComplete="name" value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} maxLength={100} />}
              </Field>
              <Field label="メールアドレス" required hint="予約確認メールと変更・キャンセル用リンクをお送りします" error={errors.email}>
                {(p) => <input {...p} type="email" inputMode="email" autoComplete="email" value={customer.email} onChange={(e) => setCustomer({ ...customer, email: e.target.value })} maxLength={200} />}
              </Field>
              {b.phoneRequirement !== 'hidden' && (
                <Field label="電話番号" required={b.phoneRequirement === 'required'} error={errors.phone}>
                  {(p) => <input {...p} type="tel" inputMode="tel" autoComplete="tel" value={customer.phone} onChange={(e) => setCustomer({ ...customer, phone: e.target.value })} maxLength={30} />}
                </Field>
              )}
              <Field label="ご要望・連絡事項（任意）">
                {(p) => <textarea {...p} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />}
              </Field>
              <div style={{ position: 'absolute', left: -9999 }} aria-hidden="true">
                <label htmlFor="rf-website">Website</label>
                <input id="rf-website" type="text" tabIndex={-1} autoComplete="off" />
              </div>
              <div className="sticky-actions">
                <button type="button" onClick={back}>戻る</button>
                <button type="submit" className="btn-primary">次へ</button>
              </div>
            </form>
          </section>
        )}

        {step === 'questions' && (
          <section>
            <h1 tabIndex={-1} ref={headingRef}>事前の質問</h1>
            <form
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                if (validateAnswers()) next();
              }}
            >
              {qList.map((q) => (
                <QuestionInput key={q.id} q={q} value={answers[q.id]} error={errors[q.id]} onChange={(v) => setAnswers({ ...answers, [q.id]: v })} />
              ))}
              <div className="sticky-actions">
                <button type="button" onClick={back}>戻る</button>
                <button type="submit" className="btn-primary">確認へ</button>
              </div>
            </form>
          </section>
        )}

        {step === 'confirm' && service && slot && (
          <section>
            <h1 tabIndex={-1} ref={headingRef}>予約内容の確認</h1>
            <p className="muted small">まだ予約は確定していません。内容をご確認のうえ「予約を確定する」を押してください。</p>
            <dl className="summary card">
              <dt>メニュー</dt>
              <dd>{service.name}（{service.durationMin}分{service.priceText ? ` ・ ${service.priceText}` : ''}）</dd>
              <dt>日時</dt>
              <dd>
                {fmtDateLong(slot.start, tz)} {fmtTime(slot.start, tz)}〜{fmtTime(slot.end, tz)}
                {tz !== Intl.DateTimeFormat().resolvedOptions().timeZone && <span className="small muted">（{tz}の時刻）</span>}
              </dd>
              {service.requiresStaff && service.bookingMode === 'slots' && (
                <>
                  <dt>担当</dt>
                  <dd>{staffId ? profile.staff.find((s) => s.id === staffId)?.name : '指名なし（おまかせ）'}</dd>
                </>
              )}
              {service.maxPartySize > 1 && (
                <>
                  <dt>人数</dt>
                  <dd>{partySize}名</dd>
                </>
              )}
              <dt>お名前</dt>
              <dd>{customer.name} 様</dd>
              <dt>メール</dt>
              <dd>{customer.email}</dd>
              {customer.phone && b.phoneRequirement !== 'hidden' && (
                <>
                  <dt>電話</dt>
                  <dd>{customer.phone}</dd>
                </>
              )}
              {qList.map((q) => (
                <div key={q.id}>
                  <dt>{q.label}</dt>
                  <dd>{answerDisplay(q, answers[q.id]) || '（未回答）'}</dd>
                </div>
              ))}
              {note && (
                <>
                  <dt>ご要望</dt>
                  <dd style={{ whiteSpace: 'pre-wrap' }}>{note}</dd>
                </>
              )}
            </dl>
            <p className="small">
              変更は開始の{hoursLabel(b.changeDeadlineMin)}前、キャンセルは{hoursLabel(b.cancelDeadlineMin)}前まで、確認メールのリンクから手続きできます。
            </p>
            {b.consentText && (
              <label className="check">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} aria-invalid={errors.consent ? true : undefined} aria-describedby={errors.consent ? 'consent-err' : undefined} />
                <span>{b.consentText}</span>
              </label>
            )}
            {errors.consent && <div className="error-text" id="consent-err" role="alert">{errors.consent}</div>}
            {b.turnstileSiteKey && <Turnstile siteKey={b.turnstileSiteKey} onToken={setCaptcha} />}
            <div aria-live="assertive">
              <ErrorAlert error={submitErr} />
            </div>
            {alternatives.length > 0 && (
              <div className="card">
                <h2>ほかの空き時間</h2>
                <div className="times">
                  {alternatives.map((a) => (
                    <button key={a.start + (a.occurrenceId ?? '')} className="time-btn" onClick={() => { setSlot({ ...a, remaining: null }); setDate(new Date(a.start).toLocaleDateString('sv-SE', { timeZone: tz })); setAlternatives([]); setSubmitErr(null); }}>
                      <span>{fmtTime(a.start, tz)}</span>
                      <small>{dateLabel(new Date(a.start).toLocaleDateString('sv-SE', { timeZone: tz }))}</small>
                    </button>
                  ))}
                </div>
                <button className="btn-ghost" onClick={() => go('date')}>カレンダーから選び直す</button>
              </div>
            )}
            <div className="sticky-actions">
              <button onClick={back} disabled={busy}>戻る</button>
              <button className="btn-primary" onClick={submit} disabled={busy || (!!b.turnstileSiteKey && !captcha)} aria-busy={busy}>
                {busy ? '送信中…' : '予約を確定する'}
              </button>
            </div>
          </section>
        )}

        {step === 'done' && done && service && (
          <section>
            <div className="done-mark" aria-hidden="true">✓</div>
            <h1 tabIndex={-1} ref={headingRef}>ご予約が確定しました</h1>
            <dl className="summary card">
              <dt>予約番号</dt>
              <dd style={{ fontSize: '1.3rem', letterSpacing: 1 }}>{done.refCode}</dd>
              <dt>日時</dt>
              <dd>{fmtDateLong(done.start, tz)} {fmtTime(done.start, tz)}〜{fmtTime(done.end, tz)}</dd>
              <dt>メニュー</dt>
              <dd>{service.name}</dd>
            </dl>
            {b.completionMessage && <p style={{ whiteSpace: 'pre-wrap' }}>{b.completionMessage}</p>}
            <p className="small">確認メールを {customer.email} にお送りしました。届かない場合は迷惑メールフォルダもご確認ください。</p>
            {done.manageToken && (
              <div className="card">
                <h2>予約の確認・変更・キャンセル</h2>
                <p className="small">このリンクはあなた専用です。他の人に共有しないでください。</p>
                <a className="btn btn-primary btn-block" href={`/manage#t=${done.manageToken}`}>予約を確認・変更する</a>
              </div>
            )}
            <button className="btn-ghost" onClick={() => { setStep('service'); setSlot(null); setDate(null); setDone(null); }}>続けて別の予約をする</button>
            <BusinessContact b={b} />
          </section>
        )}

        {step === 'waitlist' && service && (
          <WaitlistForm slug={slug} service={service} staffId={staffId} partySize={partySize} initialDate={date} customer={customer} onBack={() => go('date')} headingRef={headingRef} tz={tz} />
        )}
      </main>
    </div>
  );
}

function hoursLabel(min: number): string {
  if (min === 0) return '直前';
  if (min % 1440 === 0) return `${min / 1440}日`;
  if (min % 60 === 0) return `${min / 60}時間`;
  return `${min}分`;
}

function answerDisplay(q: Question, v: any): string {
  if (v === undefined || v === null || v === '') return '';
  if (q.type === 'single_choice') return q.options.find((o) => o.id === v)?.label ?? '';
  if (q.type === 'multi_choice') return q.options.filter((o) => (v as string[]).includes(o.id)).map((o) => o.label).join('、');
  if (q.type === 'yes_no') return v === true ? 'はい' : v === false ? 'いいえ' : '';
  if (q.type === 'confirm') return v === true ? '確認しました' : '';
  return String(v);
}

function QuestionInput({ q, value, error, onChange }: { q: Question; value: any; error?: string; onChange: (v: any) => void }) {
  if (q.type === 'confirm')
    return (
      <div className="field">
        <label className="check">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked ? true : null)} aria-invalid={error ? true : undefined} aria-describedby={error ? `q-${q.id}-err` : undefined} />
          <span>
            {q.label}
            {q.required && <span className="req">必須</span>}
          </span>
        </label>
        {q.helpText && <div className="hint">{q.helpText}</div>}
        {error && <div className="error-text" id={`q-${q.id}-err`} role="alert">{error}</div>}
      </div>
    );
  if (q.type === 'single_choice' || q.type === 'multi_choice' || q.type === 'yes_no') {
    const opts = q.type === 'yes_no' ? [{ id: 'yes', label: 'はい' }, { id: 'no', label: 'いいえ' }] : q.options;
    const multi = q.type === 'multi_choice';
    return (
      <fieldset className="field" style={{ border: 0, padding: 0, margin: '0 0 14px' }} aria-invalid={error ? true : undefined} aria-describedby={error ? `q-${q.id}-err` : undefined}>
        <legend className="label">
          {q.label}
          {q.required && <span className="req">必須</span>}
        </legend>
        {q.helpText && <div className="hint">{q.helpText}</div>}
        {opts.map((o) => {
          const checked = q.type === 'yes_no' ? (o.id === 'yes' ? value === true : value === false) : multi ? ((value as string[]) ?? []).includes(o.id) : value === o.id;
          return (
            <label key={o.id} className="check">
              <input
                type={multi ? 'checkbox' : 'radio'}
                name={`q-${q.id}`}
                checked={checked}
                onChange={(e) => {
                  if (q.type === 'yes_no') onChange(o.id === 'yes');
                  else if (multi) {
                    const cur = new Set<string>((value as string[]) ?? []);
                    if (e.target.checked) cur.add(o.id);
                    else cur.delete(o.id);
                    onChange([...cur]);
                  } else onChange(o.id);
                }}
              />
              <span>{o.label}</span>
            </label>
          );
        })}
        {error && <div className="error-text" id={`q-${q.id}-err`} role="alert">{error}</div>}
      </fieldset>
    );
  }
  return (
    <Field label={q.label} required={q.required} hint={q.helpText || undefined} error={error}>
      {(p) => (q.type === 'long_text' ? <textarea {...p} value={value ?? ''} onChange={(e) => onChange(e.target.value)} maxLength={2000} /> : <input {...p} type="text" value={value ?? ''} onChange={(e) => onChange(e.target.value)} maxLength={200} />)}
    </Field>
  );
}

function BusinessContact({ b }: { b: PubProfile['business'] }) {
  if (!b.phone && !b.email && !b.address && !b.websiteUrl && !b.snsUrl) return null;
  return (
    <div className="small muted" style={{ marginTop: 24, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <strong>{b.name}</strong>
      {b.address && <div>{b.address}</div>}
      {b.phone && <div>電話: <a href={`tel:${b.phone.replace(/[^0-9+]/g, '')}`}>{b.phone}</a></div>}
      {b.email && <div>メール: {b.email}</div>}
      {b.websiteUrl && <div><a href={b.websiteUrl} rel="noopener noreferrer" target="_blank">Webサイト</a></div>}
      {b.snsUrl && <div><a href={b.snsUrl} rel="noopener noreferrer" target="_blank">SNS</a></div>}
    </div>
  );
}

function DateTimeStep(props: {
  slug: string;
  profile: PubProfile;
  service: PubService;
  staffId: string | null;
  partySize: number;
  setPartySize: (n: number) => void;
  date: string | null;
  setDate: (d: string) => void;
  slot: SlotDto | null;
  setSlot: (s: SlotDto) => void;
  step: Step;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onBack: () => void;
  onWaitlist: () => void;
  version: number;
}) {
  const { profile, service, staffId, partySize, date, step } = props;
  const tz = profile.business.timezone;
  const today = todayIn(tz);
  const [month, setMonth] = useState((date ?? today).slice(0, 7));
  const grid = monthGrid(month, profile.business.weekStart);
  const from = grid[0] < today ? today : grid[0];
  const to = grid[grid.length - 1];
  const slots = useLoad<{ dates: Record<string, SlotDto[]>; firstDate: string; lastDate: string }>(
    () => get(`/api/public/${props.slug}/slots${qs({ serviceId: service.id, staffId: staffId ?? undefined, from, to, partySize })}`),
    [props.slug, service.id, staffId, from, to, partySize, props.version],
  );
  const dates = slots.data?.dates ?? {};
  const last = slots.data?.lastDate ?? addDays(today, profile.business.maxAdvanceDays);
  const weekdayHeads = Array.from({ length: 7 }, (_, i) => WEEKDAYS[(profile.business.weekStart + i) % 7]);
  const nextMonth = () => {
    const [y, m] = month.split('-').map(Number);
    setMonth(m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`);
  };
  const prevMonth = () => {
    const [y, m] = month.split('-').map(Number);
    setMonth(m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`);
  };
  const canPrev = month > today.slice(0, 7);
  const canNext = `${month}-31` < last;
  const [y, m] = month.split('-').map(Number);

  if (step === 'time' && date) {
    const list = dates[date] ?? [];
    return (
      <section>
        <h1 tabIndex={-1} ref={props.headingRef}>{dateLabel(date)} の時間を選んでください</h1>
        <p className="small muted">{service.name}（{service.durationMin}分）{tz !== Intl.DateTimeFormat().resolvedOptions().timeZone ? ` ・ 時刻は${tz}` : ''}</p>
        {slots.loading ? (
          <Loading label="空き時間を確認しています…" />
        ) : list.length === 0 ? (
          <div className="alert alert-warn">この日は空きがなくなりました。別の日を選んでください。</div>
        ) : (
          <div className="times" role="group" aria-label="開始時刻">
            {list.map((s) => (
              <button key={s.start + (s.occurrenceId ?? '')} className="time-btn" aria-pressed={props.slot?.start === s.start} onClick={() => props.setSlot(s)}>
                <span>{fmtTime(s.start, tz)}</span>
                {s.remaining !== null && <small>残り{s.remaining}名</small>}
              </button>
            ))}
          </div>
        )}
        <p style={{ marginTop: 16 }}>
          <button className="btn-ghost" onClick={props.onWaitlist}>希望の時間が空いていない（空き待ち登録）</button>
        </p>
        <div className="sticky-actions"><button onClick={props.onBack}>日付を選び直す</button></div>
      </section>
    );
  }

  return (
    <section>
      <h1 tabIndex={-1} ref={props.headingRef}>日付を選んでください</h1>
      <p className="small muted">{service.name}（{service.durationMin}分）{staffId ? ` ・ 担当 ${profile.staff.find((s) => s.id === staffId)?.name}` : ''}</p>
      {service.maxPartySize > 1 && (
        <Field label="人数">
          {(p) => (
            <select {...p} value={partySize} onChange={(e) => props.setPartySize(Number(e.target.value))}>
              {Array.from({ length: service.maxPartySize }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>{n}名</option>
              ))}
            </select>
          )}
        </Field>
      )}
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn-sm" onClick={prevMonth} disabled={!canPrev} aria-label="前の月">‹ 前月</button>
        <strong className="spacer" style={{ textAlign: 'center' }} aria-live="polite">{y}年{m}月</strong>
        <button className="btn-sm" onClick={nextMonth} disabled={!canNext} aria-label="次の月">次月 ›</button>
      </div>
      <ErrorAlert error={slots.error} />
      <div className="days" role="group" aria-label={`${y}年${m}月の空き状況`} aria-busy={slots.loading}>
        {weekdayHeads.map((w) => (
          <div key={w} className="dh" aria-hidden="true">{w}</div>
        ))}
        {grid.map((d) => {
          const inMonth = d.slice(0, 7) === month;
          const n = dates[d]?.length ?? 0;
          const selectable = n > 0;
          const outOfRange = d < today || d > last;
          return (
            <button
              key={d}
              className={`day ${selectable ? 'avail' : 'none'}`}
              style={inMonth || selectable ? undefined : { opacity: 0.4 }}
              disabled={!selectable}
              aria-pressed={date === d}
              aria-label={`${dateLabel(d)} ${slots.loading ? '確認中' : outOfRange ? '受付期間外' : n > 0 ? `空きあり ${n}枠` : '空きなし'}`}
              onClick={() => props.setDate(d)}
            >
              {inMonth ? Number(d.slice(8)) : `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`}
              <small aria-hidden="true">{slots.loading ? '' : n > 0 ? '○' : outOfRange ? '' : '×'}</small>
            </button>
          );
        })}
      </div>
      <p className="small muted" style={{ marginTop: 8 }}>○ 空きあり ／ × 空きなし・休業日。{profile.business.maxAdvanceDays}日先まで予約できます。</p>
      <p>
        <button className="btn-ghost" onClick={props.onWaitlist}>空きがない日を希望する（空き待ち登録）</button>
      </p>
      <div className="sticky-actions"><button onClick={props.onBack}>戻る</button></div>
    </section>
  );
}

function WaitlistForm({ slug, service, staffId, partySize, initialDate, customer, onBack, headingRef, tz }: { slug: string; service: PubService; staffId: string | null; partySize: number; initialDate: string | null; customer: { name: string; email: string; phone: string }; onBack: () => void; headingRef: React.RefObject<HTMLHeadingElement | null>; tz: string }) {
  const today = todayIn(tz);
  const [f, setF] = useState({ dateFrom: initialDate ?? today, dateTo: initialDate ?? addDays(today, 7), window: 'any', name: customer.name, email: customer.email, phone: customer.phone, note: '' });
  const [err, setErr] = useState<unknown>(null);
  const [ok, setOk] = useState<string | null>(null);
  const windows: Record<string, [number, number, string]> = { any: [0, 1440, '終日いつでも'], morning: [0, 720, '午前'], afternoon: [720, 1020, '午後'], evening: [1020, 1440, '夕方以降'] };
  if (ok)
    return (
      <section>
        <h1 tabIndex={-1} ref={headingRef}>空き待ちを登録しました</h1>
        <div className="alert alert-ok">{ok}</div>
        <button onClick={onBack}>予約画面に戻る</button>
      </section>
    );
  return (
    <section>
      <h1 tabIndex={-1} ref={headingRef}>空き待ち登録</h1>
      <div className="alert alert-warn small">空き待ちは<strong>予約の確定・保証ではありません</strong>。キャンセル等で空きが出た場合に、お店からご連絡します。</div>
      <p className="small muted">{service.name}</p>
      <form
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          try {
            const [a, b] = windows[f.window];
            const r = await post(`/api/public/${slug}/waitlist`, { serviceId: service.id, staffId, dateFrom: f.dateFrom, dateTo: f.dateTo, timeFromMin: a, timeToMin: b, partySize, name: f.name, email: f.email, phone: f.phone || null, note: f.note });
            setOk(r.message);
          } catch (x) {
            setErr(x);
          }
        }}
      >
        <div className="grid-2">
          <Field label="希望日（から）" required>{(p) => <input {...p} type="date" min={today} value={f.dateFrom} onChange={(e) => setF({ ...f, dateFrom: e.target.value })} />}</Field>
          <Field label="希望日（まで）" required>{(p) => <input {...p} type="date" min={f.dateFrom} value={f.dateTo} onChange={(e) => setF({ ...f, dateTo: e.target.value })} />}</Field>
        </div>
        <Field label="希望の時間帯">
          {(p) => (
            <select {...p} value={f.window} onChange={(e) => setF({ ...f, window: e.target.value })}>
              {Object.entries(windows).map(([k, v]) => <option key={k} value={k}>{v[2]}</option>)}
            </select>
          )}
        </Field>
        <Field label="お名前" required>{(p) => <input {...p} type="text" autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="メールアドレス" required>{(p) => <input {...p} type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
        <Field label="電話番号（任意）">{(p) => <input {...p} type="tel" autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />}</Field>
        <Field label="メモ（任意）">{(p) => <textarea {...p} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={500} />}</Field>
        <ErrorAlert error={err} />
        <div className="sticky-actions">
          <button type="button" onClick={onBack}>戻る</button>
          <button type="submit" className="btn-primary">空き待ちを登録</button>
        </div>
      </form>
    </section>
  );
}

declare global {
  interface Window {
    turnstile?: { render: (el: HTMLElement, o: Record<string, unknown>) => string; remove: (id: string) => void };
  }
}

/** Optional Cloudflare Turnstile widget (only when the operator configured TURNSTILE_SITE_KEY). */
function Turnstile({ siteKey, onToken }: { siteKey: string; onToken: (t: string | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let id: string | null = null;
    const render = () => {
      if (ref.current && window.turnstile) id = window.turnstile.render(ref.current, { sitekey: siteKey, language: 'ja', callback: (t: string) => onToken(t), 'expired-callback': () => onToken(null) });
    };
    if (window.turnstile) render();
    else {
      const sc = document.createElement('script');
      sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      sc.async = true;
      sc.onload = render;
      document.head.appendChild(sc);
    }
    return () => {
      if (id && window.turnstile) window.turnstile.remove(id);
    };
  }, [siteKey, onToken]);
  return <div ref={ref} style={{ margin: '12px 0' }} aria-label="ロボットでないことの確認" />;
}

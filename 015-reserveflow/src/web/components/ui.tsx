import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api';
import { STATUS_ICON, STATUS_LABEL, WEEKDAYS } from '../../shared/labels';
import { minToTime, timeToMin } from '../format';

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`pill st-${status}`}>
      <span aria-hidden="true">{STATUS_ICON[status] ?? '•'}</span>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function Field({
  label,
  required,
  hint,
  error,
  children,
  id: idProp,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: (p: { id: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string; 'aria-required'?: boolean }) => ReactNode;
  id?: string;
}) {
  const auto = useId();
  const id = idProp ?? auto;
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required && <span className="req">必須</span>}
      </label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': [hintId, errId].filter(Boolean).join(' ') || undefined, 'aria-required': required || undefined })}
      {hint && (
        <div className="hint" id={hintId}>
          {hint}
        </div>
      )}
      {error && (
        <div className="error-text" id={errId} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export function ErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof ApiError || error instanceof Error ? error.message : String(error);
  const details = error instanceof ApiError ? error.details : null;
  return (
    <div className="alert alert-error" role="alert">
      {msg}
      {details?.reasons && (
        <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {details.reasons.map((r: { message: string }, i: number) => (
            <li key={i}>{r.message}</li>
          ))}
        </ul>
      )}
      {details?.errors && (
        <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {details.errors.map((r: string, i: number) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Loading({ label = '読み込み中…' }: { label?: string }) {
  return (
    <p className="muted" role="status" aria-live="polite">
      {label}
    </p>
  );
}

/** Load data with loading/error state and a reload function. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: unknown; loading: boolean; reload: () => void; setData: (d: T) => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn()
      .then((d) => {
        if (alive) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, loading, reload: () => setN((x) => x + 1), setData };
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="row" style={{ marginBottom: 8 }}>
          <h2 id={titleId} style={{ margin: 0 }}>
            {title}
          </h2>
          <span className="spacer" />
          <button className="btn-ghost" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const ToastCtx = createContext<(msg: string) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const show = useCallback((m: string) => {
    setMsg(m);
    window.setTimeout(() => setMsg(null), 3500);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div aria-live="polite" role="status">
        {msg && <div className="toast">{msg}</div>}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

export interface HourRow {
  weekday: number;
  startMin: number;
  endMin: number;
}

/** Weekly hours editor: per weekday, multiple intervals. */
export function HoursEditor({ value, onChange, label }: { value: HourRow[]; onChange: (v: HourRow[]) => void; label: string }) {
  const days = [1, 2, 3, 4, 5, 6, 0];
  const update = (wd: number, rows: HourRow[]) => onChange([...value.filter((v) => v.weekday !== wd), ...rows].sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin));
  return (
    <fieldset className="card" style={{ padding: 12 }}>
      <legend className="label">{label}</legend>
      {days.map((wd) => {
        const rows = value.filter((v) => v.weekday === wd);
        return (
          <div key={wd} className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--line)', alignItems: 'flex-start' }}>
            <strong style={{ width: 28 }}>{WEEKDAYS[wd]}</strong>
            <div style={{ flex: 1 }} className="stack">
              {rows.length === 0 && <span className="muted">休み</span>}
              {rows.map((r, i) => (
                <div key={i} className="row" style={{ gap: 6 }}>
                  <input
                    type="time"
                    aria-label={`${WEEKDAYS[wd]}曜 区間${i + 1} 開始`}
                    value={minToTime(r.startMin)}
                    step={300}
                    onChange={(e) => update(wd, rows.map((x, j) => (j === i ? { ...x, startMin: timeToMin(e.target.value || '00:00') } : x)))}
                    style={{ width: 120 }}
                  />
                  〜
                  <input
                    type="time"
                    aria-label={`${WEEKDAYS[wd]}曜 区間${i + 1} 終了`}
                    value={r.endMin >= 1440 ? '23:59' : minToTime(r.endMin)}
                    step={300}
                    onChange={(e) => update(wd, rows.map((x, j) => (j === i ? { ...x, endMin: e.target.value === '23:59' ? 1440 : timeToMin(e.target.value || '00:00') } : x)))}
                    style={{ width: 120 }}
                  />
                  <button type="button" className="btn-sm" onClick={() => update(wd, rows.filter((_, j) => j !== i))} aria-label={`${WEEKDAYS[wd]}曜 区間${i + 1}を削除`}>
                    削除
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="btn-sm" onClick={() => update(wd, [...rows, rows.length ? { weekday: wd, startMin: Math.min(rows[rows.length - 1].endMin + 60, 1380), endMin: Math.min(rows[rows.length - 1].endMin + 180, 1440) } : { weekday: wd, startMin: 600, endMin: 1080 }])}>
              ＋区間
            </button>
          </div>
        );
      })}
      <p className="hint small" style={{ marginTop: 8 }}>
        1日に複数の区間を登録できます（例：10:00〜12:00 と 13:00〜18:00）。23:59 は「24:00まで」として扱います。
      </p>
    </fieldset>
  );
}

export function Confirm({ title, message, confirmLabel = '実行する', danger, onConfirm, onClose, children }: { title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => Promise<void | false> | void | false; onClose: () => void; children?: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <Modal title={title} onClose={onClose}>
      <div style={{ marginBottom: 12 }}>{message}</div>
      {children}
      <ErrorAlert error={err} />
      <div className="btn-row">
        <button onClick={onClose}>やめる</button>
        <button
          className={danger ? 'btn-danger' : 'btn-primary'}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              const r = await onConfirm();
              if (r !== false) onClose();
            } catch (e) {
              setErr(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? '処理中…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function useOnline(): boolean {
  const [on, setOn] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const a = () => setOn(true);
    const b = () => setOn(false);
    window.addEventListener('online', a);
    window.addEventListener('offline', b);
    return () => {
      window.removeEventListener('online', a);
      window.removeEventListener('offline', b);
    };
  }, []);
  return on;
}

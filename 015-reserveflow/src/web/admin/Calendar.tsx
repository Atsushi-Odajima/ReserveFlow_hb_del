import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { DateTime } from 'luxon';
import { get, qs } from '../api';
import { ErrorAlert, Loading, StatusBadge, useLoad } from '../components/ui';
import { addDays, dateLabel, fmtTime, monthGrid, todayIn, weekdayOf } from '../format';
import { STATUS_LABEL, WEEKDAYS } from '../../shared/labels';
import { useSession } from './session';

type View = 'day' | 'week' | 'month' | 'list';
const PX_PER_MIN = 1.1;

interface CalData {
  timezone: string;
  weekStart: number;
  hours: Array<{ weekday: number; startMin: number; endMin: number }>;
  bookings: any[];
  blocks: any[];
  exceptions: any[];
  occurrences: any[];
}

export function CalendarPage() {
  const { tz, me } = useSession();
  const [sp, setSp] = useSearchParams();
  const isMobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 860px)').matches;
  const view = (sp.get('view') as View) ?? (isMobile ? 'list' : 'week');
  const date = sp.get('date') ?? todayIn(tz);
  const staffFilter = sp.get('staffId') ?? '';
  const set = (p: Record<string, string>) => setSp({ view, date, ...(staffFilter ? { staffId: staffFilter } : {}), ...p });
  const weekStart = me.business?.week_start ?? 1;
  const range = useMemo(() => {
    if (view === 'day' || view === 'list') return { from: date, to: view === 'list' ? addDays(date, 6) : date };
    if (view === 'week') {
      const off = (weekdayOf(date) - weekStart + 7) % 7;
      const f = addDays(date, -off);
      return { from: f, to: addDays(f, 6) };
    }
    const g = monthGrid(date.slice(0, 7), weekStart);
    return { from: g[0], to: g[41] };
  }, [view, date, weekStart]);
  const staff = useLoad<{ staff: Array<{ id: string; displayName: string; color: string; archived: boolean }> }>(() => get('/api/admin/staff'), []);
  const { data, error, loading } = useLoad<CalData>(() => get(`/api/admin/calendar${qs({ from: range.from, to: range.to, staffId: staffFilter || undefined })}`), [range.from, range.to, staffFilter]);
  const step = view === 'month' ? 30 : view === 'week' ? 7 : view === 'list' ? 7 : 1;
  const move = (n: number) => {
    if (view === 'month') {
      const d = DateTime.fromISO(`${date.slice(0, 7)}-01`).plus({ months: n });
      set({ date: d.toISODate()! });
    } else set({ date: addDays(date, n * step) });
  };
  const title = view === 'month' ? `${date.slice(0, 4)}年${Number(date.slice(5, 7))}月` : view === 'day' ? dateLabel(date) : `${dateLabel(range.from)} 〜 ${dateLabel(range.to)}`;
  const activeStaff = (staff.data?.staff ?? []).filter((s) => !s.archived && (!staffFilter || s.id === staffFilter));

  return (
    <div>
      <div className="cal-toolbar">
        <h1 style={{ margin: 0, marginRight: 8 }}>{title}</h1>
        <div className="btn-row">
          <button className="btn-sm" onClick={() => move(-1)} aria-label="前へ">‹</button>
          <button className="btn-sm" onClick={() => set({ date: todayIn(tz) })}>今日</button>
          <button className="btn-sm" onClick={() => move(1)} aria-label="次へ">›</button>
        </div>
        <span className="spacer" />
        <div className="seg" role="group" aria-label="表示切替">
          {(['day', 'week', 'month', 'list'] as View[]).map((v) => (
            <button key={v} aria-pressed={view === v} onClick={() => set({ view: v })}>{{ day: '日', week: '週', month: '月', list: '予定リスト' }[v]}</button>
          ))}
        </div>
        <select aria-label="スタッフで絞り込み" value={staffFilter} onChange={(e) => setSp({ view, date, ...(e.target.value ? { staffId: e.target.value } : {}) })} style={{ width: 'auto' }}>
          <option value="">全スタッフ</option>
          {staff.data?.staff.filter((s) => !s.archived).map((s) => <option key={s.id} value={s.id}>{s.displayName}</option>)}
        </select>
        <Link className="btn btn-sm" to="/app/blocks">＋ ブロック</Link>
        <Link className="btn btn-sm btn-primary" to="/app/new">＋ 予約</Link>
      </div>
      <Legend />
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : data && (
        <>
          {view === 'month' && <MonthView data={data} month={date.slice(0, 7)} weekStart={weekStart} onPick={(d) => set({ view: 'day', date: d })} />}
          {view === 'list' && <ListView data={data} from={range.from} to={range.to} />}
          {view === 'week' && <TimeGrid data={data} columns={Array.from({ length: 7 }, (_, i) => ({ key: addDays(range.from, i), label: dateLabel(addDays(range.from, i)), date: addDays(range.from, i), staffId: null }))} />}
          {view === 'day' && (
            <TimeGrid
              data={data}
              columns={[...activeStaff.map((s) => ({ key: s.id, label: s.displayName, date, staffId: s.id as string | null })), ...(staffFilter ? [] : [{ key: 'none', label: '担当なし', date, staffId: '__none__' as string | null }])]}
            />
          )}
        </>
      )}
      <p className="small muted" style={{ marginTop: 8 }}>予約の変更は予約詳細の「日時を変更」から行います（変更時もサーバーで空き状況を再確認します）。</p>
    </div>
  );
}

function Legend() {
  return (
    <div className="row small" style={{ marginBottom: 8 }} aria-label="凡例">
      <span><span className="ev ev-booking" style={{ position: 'static', display: 'inline-block', width: 18, height: 12 }} /> 予約</span>
      <span><span className="ev ev-occ" style={{ position: 'static', display: 'inline-block', width: 18, height: 12 }} /> 開催回</span>
      <span><span className="ev ev-block" style={{ position: 'static', display: 'inline-block', width: 18, height: 12 }} /> ブロック/休み</span>
      <span><span className="cal-closed" style={{ position: 'static', display: 'inline-block', width: 18, height: 12 }} /> 営業時間外・休業</span>
      <span>網掛け部分＝準備/片付け時間</span>
    </div>
  );
}

function localMin(iso: string, tz: string): number {
  const d = DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz);
  return d.hour * 60 + d.minute;
}
function localDate(iso: string, tz: string): string {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz).toISODate()!;
}

function dayHours(data: CalData, date: string): Array<{ startMin: number; endMin: number }> {
  const ex = data.exceptions.filter((e) => e.date === date);
  if (ex.some((e) => e.kind === 'closed')) return [];
  const sp = ex.filter((e) => e.kind === 'special_hours');
  if (sp.length) return sp.flatMap((e) => e.intervals);
  return data.hours.filter((h) => h.weekday === weekdayOf(date));
}

function TimeGrid({ data, columns }: { data: CalData; columns: Array<{ key: string; label: string; date: string; staffId: string | null }> }) {
  const tz = data.timezone;
  // visible range: union of business hours ± 1h, and any events
  let minM = 24 * 60;
  let maxM = 0;
  for (const c of columns) for (const h of dayHours(data, c.date)) { minM = Math.min(minM, h.startMin); maxM = Math.max(maxM, h.endMin); }
  for (const b of data.bookings) { minM = Math.min(minM, localMin(b.occupiedStart, tz)); maxM = Math.max(maxM, localMin(b.occupiedEnd, tz) || 1440); }
  if (minM >= maxM) { minM = 9 * 60; maxM = 19 * 60; }
  minM = Math.max(0, Math.floor(minM / 60) * 60 - 60);
  maxM = Math.min(1440, Math.ceil(maxM / 60) * 60 + 60);
  const height = (maxM - minM) * PX_PER_MIN;
  const y = (m: number) => (m - minM) * PX_PER_MIN;
  const inCol = (c: { date: string; staffId: string | null }, iso: string, staffId: string | null) =>
    localDate(iso, tz) === c.date && (c.staffId === null || (c.staffId === '__none__' ? !staffId : staffId === c.staffId));
  return (
    <div className="table-wrap">
      <div className="cal-grid" style={{ gridTemplateColumns: `52px repeat(${columns.length}, minmax(110px, 1fr))`, minWidth: 52 + columns.length * 110 }}>
        <div className="cal-colhead" style={{ borderLeft: 0 }} />
        {columns.map((c) => {
          const closed = data.exceptions.find((e) => e.date === c.date && e.kind === 'closed');
          const special = data.exceptions.find((e) => e.date === c.date && e.kind === 'special_hours');
          return (
            <div key={c.key} className="cal-colhead">
              {c.label}
              {closed && <div className="small" style={{ color: 'var(--danger)' }}>休業{closed.label ? `（${closed.label}）` : ''}</div>}
              {special && <div className="small" style={{ color: 'var(--warn)' }}>{special.label || '特別営業'}</div>}
            </div>
          );
        })}
        <div className="cal-times" style={{ height }}>
          {Array.from({ length: (maxM - minM) / 60 + 1 }, (_, i) => minM + i * 60).map((m) => (
            <span key={m} className="cal-time" style={{ top: y(m) }}>{String(m / 60).padStart(2, '0')}:00</span>
          ))}
        </div>
        {columns.map((c) => {
          const hours = dayHours(data, c.date);
          const closedRanges: Array<[number, number]> = [];
          let cur = minM;
          for (const h of [...hours].sort((a, b) => a.startMin - b.startMin)) {
            if (h.startMin > cur) closedRanges.push([cur, h.startMin]);
            cur = Math.max(cur, h.endMin);
          }
          if (cur < maxM) closedRanges.push([cur, maxM]);
          return (
            <div key={c.key} className="cal-col" style={{ height }}>
              {closedRanges.map(([a, b], i) => <div key={i} className="cal-closed" style={{ top: y(a), height: (b - a) * PX_PER_MIN }} aria-hidden="true" />)}
              {Array.from({ length: (maxM - minM) / 60 }, (_, i) => <div key={i} className="cal-hour" style={{ top: y(minM + i * 60) }} />)}
              {data.blocks
                .filter((bl) => (bl.scope === 'business' || c.staffId === null || bl.targetId === c.staffId) && localDate(bl.start, tz) <= c.date && localDate(bl.end, tz) >= c.date)
                .map((bl) => {
                  const s = localDate(bl.start, tz) < c.date ? minM : Math.max(minM, localMin(bl.start, tz));
                  const e = localDate(bl.end, tz) > c.date ? maxM : Math.min(maxM, localMin(bl.end, tz) || 1440);
                  if (e <= s) return null;
                  return (
                    <div key={bl.id} className="ev ev-block" style={{ top: y(s), height: Math.max(16, (e - s) * PX_PER_MIN) }} title={bl.reason}>
                      ブロック: {bl.scope === 'business' ? '全体' : bl.targetName} {bl.reason}
                    </div>
                  );
                })}
              {data.occurrences
                .filter((o) => inCol(c, o.start, o.staffId))
                .map((o) => {
                  const s = localMin(o.start, tz);
                  const e = localMin(o.end, tz) || 1440;
                  return (
                    <Link to={`/app/bookings${qs({ from: localDate(o.start, tz), to: localDate(o.start, tz) })}`} key={o.id} className={`ev ev-occ ${o.status === 'cancelled' ? 'ev-cancel' : ''}`} style={{ top: y(s), height: Math.max(18, (e - s) * PX_PER_MIN) }}>
                      {fmtTime(o.start, tz)} {o.serviceName}<br />{o.status === 'cancelled' ? '休止' : `予約 ${o.booked}/${o.capacity}名`}
                    </Link>
                  );
                })}
              {data.bookings
                .filter((b) => b.status !== 'rescheduled' && !b.occurrenceId && inCol(c, b.start, b.staffId))
                .map((b) => {
                  const os = localMin(b.occupiedStart, tz);
                  const s = localMin(b.start, tz);
                  const e = localMin(b.end, tz) || 1440;
                  const oe = localMin(b.occupiedEnd, tz) || 1440;
                  const top = y(Math.max(minM, os));
                  const h = Math.max(22, (Math.min(maxM, oe) - Math.max(minM, os)) * PX_PER_MIN);
                  const cancelled = b.status.startsWith('cancelled');
                  return (
                    <Link
                      key={b.id}
                      to={`/app/bookings/${b.id}`}
                      className={`ev ev-booking ${cancelled ? 'ev-cancel' : ''}`}
                      style={{ top, height: h, borderLeftColor: b.staffColor ?? undefined }}
                      aria-label={`${fmtTime(b.start, tz)}〜${fmtTime(b.end, tz)} ${b.customerName}様 ${b.serviceName} ${STATUS_LABEL[b.status]}`}
                    >
                      {s > os && <span className="buf" style={{ top: 0, height: (s - os) * PX_PER_MIN }} aria-hidden="true" />}
                      {oe > e && <span className="buf" style={{ bottom: 0, height: (oe - e) * PX_PER_MIN }} aria-hidden="true" />}
                      <strong>{fmtTime(b.start, tz)}</strong> {b.customerName}
                      <br />
                      {b.serviceName}
                      {c.staffId === null && b.staffName ? ` ・ ${b.staffName}` : ''} ・ {STATUS_LABEL[b.status]}
                    </Link>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MonthView({ data, month, weekStart, onPick }: { data: CalData; month: string; weekStart: number; onPick: (d: string) => void }) {
  const tz = data.timezone;
  const grid = monthGrid(month, weekStart);
  const today = todayIn(tz);
  const count = new Map<string, number>();
  for (const b of data.bookings) if (['confirmed', 'checked_in', 'completed', 'no_show'].includes(b.status)) count.set(localDate(b.start, tz), (count.get(localDate(b.start, tz)) ?? 0) + 1);
  return (
    <div className="month">
      {Array.from({ length: 7 }, (_, i) => <div key={i} className="dh">{WEEKDAYS[(weekStart + i) % 7]}</div>)}
      {grid.map((d) => {
        const n = count.get(d) ?? 0;
        const closed = dayHours(data, d).length === 0;
        const ex = data.exceptions.find((e) => e.date === d);
        return (
          <button key={d} className={`dc ${d.slice(0, 7) !== month ? 'out' : ''} ${d === today ? 'today' : ''}`} onClick={() => onPick(d)} aria-label={`${dateLabel(d)} 予約${n}件${closed ? ' 休業' : ''}`}>
            <span className="n">{Number(d.slice(8))}</span>
            {closed && <div className="small muted">休{ex?.label ? `・${ex.label}` : ''}</div>}
            {!closed && ex?.kind === 'special_hours' && <div className="small" style={{ color: 'var(--warn)' }}>{ex.label || '特別'}</div>}
            {n > 0 && <div><strong>{n}</strong>件</div>}
          </button>
        );
      })}
    </div>
  );
}

function ListView({ data, from, to }: { data: CalData; from: string; to: string }) {
  const tz = data.timezone;
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return (
    <div>
      {days.map((d) => {
        const items = data.bookings.filter((b) => b.status !== 'rescheduled' && localDate(b.start, tz) === d);
        const blocks = data.blocks.filter((bl) => localDate(bl.start, tz) <= d && localDate(bl.end, tz) >= d);
        const closed = dayHours(data, d).length === 0;
        return (
          <section key={d} className="card" style={{ padding: 0 }}>
            <h2 style={{ padding: '10px 12px', margin: 0, borderBottom: '1px solid var(--line)' }}>{dateLabel(d)} {closed && <span className="tag">休業</span>}</h2>
            {items.length === 0 && blocks.length === 0 && <p className="muted" style={{ padding: 12, margin: 0 }}>予定なし</p>}
            <ul className="list">
              {blocks.map((bl) => (
                <li key={bl.id} className="list-item"><span className="list-time small">{fmtTime(bl.start, tz)}</span><span>ブロック（{bl.scope === 'business' ? '全体' : bl.targetName}）{bl.reason}</span></li>
              ))}
              {items.map((b) => (
                <li key={b.id}>
                  <Link className="list-item" to={`/app/bookings/${b.id}`}>
                    <span className="list-time">{fmtTime(b.start, tz)}</span>
                    <span style={{ flex: 1 }}><strong>{b.customerName}</strong><br /><span className="small muted">{b.serviceName}{b.staffName ? ` ・ ${b.staffName}` : ''}</span></span>
                    <StatusBadge status={b.status} />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

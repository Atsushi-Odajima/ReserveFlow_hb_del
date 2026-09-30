import { describe, expect, it } from 'vitest';
import { checkOccurrence, checkSlot, listSlots } from '../../src/server/engine/availability.js';
import { formatLocal, localToInstant } from '../../src/server/engine/time.js';
import { addBooking, at, baseInput, ctxOf, h, hours, resource, service, staff, TZ, week } from './fixtures.js';

const MON = '2026-10-05'; // Monday
const TUE = '2026-10-06';
const WED = '2026-10-07'; // regular holiday in fixtures
const NOW = at('2026-10-01', 9); // well before

const times = (slots: { start: number }[], tz = TZ) => slots.map((s) => formatLocal(s.start, tz, 'HH:mm'));

describe('必須予約エンジンテスト', () => {
  it('1. 営業10-18・60分サービスで営業時間外の候補が出ない', () => {
    const ctx = ctxOf(baseInput());
    const slots = listSlots(ctx, { serviceId: 's60', staffId: null, fromDate: MON, toDate: MON, partySize: 1, now: NOW, mode: 'public' });
    const t = times(slots);
    expect(t[0]).toBe('10:00');
    expect(t[t.length - 1]).toBe('17:00');
    expect(t).not.toContain('09:30');
    expect(t).not.toContain('17:30');
    for (const s of slots) {
      expect(s.start).toBeGreaterThanOrEqual(at(MON, 10));
      expect(s.end).toBeLessThanOrEqual(at(MON, 18));
    }
  });

  it('2. 60分+前15+後15、10:00予約なら09:45-11:15を占有し、10:30/11:00は入らず11:30が最短', () => {
    const input = baseInput({
      services: [service('s60', { bufferBeforeMin: 15, bufferAfterMin: 15, slotIntervalMin: 15 })],
      staff: [staff('aki', ['s60'], { usesBusinessHours: false, weeklyHours: week(hours(h(9, 30), h(18, 30)), [3]) })],
    });
    const ctx = ctxOf(input);
    const r = checkSlot(ctx, { serviceId: 's60', staffId: 'aki', start: at(MON, 10), partySize: 1, now: NOW, mode: 'public' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(formatLocal(r.occupiedStart, TZ, 'HH:mm')).toBe('09:45');
    expect(formatLocal(r.occupiedEnd, TZ, 'HH:mm')).toBe('11:15');
    addBooking(input, { serviceId: 's60', staffId: 'aki', start: at(MON, 10) });
    const ctx2 = ctxOf(input);
    const t = times(listSlots(ctx2, { serviceId: 's60', staffId: 'aki', fromDate: MON, toDate: MON, partySize: 1, now: NOW, mode: 'public' }));
    expect(t).not.toContain('10:00');
    expect(t).not.toContain('10:30');
    expect(t).not.toContain('11:00');
    expect(t).not.toContain('11:15');
    expect(t).toContain('11:30');
    // the slot before must also end its after-buffer before 09:45: 60+15 after → latest earlier start is none (would start < 10:00)
    expect(t[0]).toBe('11:30');
  });

  it('3. スタッフの既存予約と重なる候補は出ない', () => {
    const input = baseInput();
    addBooking(input, { serviceId: 's60', staffId: 'aki', start: at(MON, 13) });
    const t = times(listSlots(ctxOf(input), { serviceId: 's60', staffId: 'aki', fromDate: MON, toDate: MON, partySize: 1, now: NOW, mode: 'public' }));
    expect(t).not.toContain('12:30');
    expect(t).not.toContain('13:00');
    expect(t).not.toContain('13:30');
    expect(t).toContain('12:00');
    expect(t).toContain('14:00');
  });

  it('4. スタッフが空いていても Room A 使用中なら Room A 必須サービスは不可', () => {
    const input = baseInput({
      resources: [resource('roomA')],
      services: [service('lesson', { resourceIds: ['roomA'] })],
      staff: [staff('aki', ['lesson']), staff('mika', ['lesson'])],
    });
    addBooking(input, { serviceId: 'lesson', staffId: 'mika', start: at(MON, 11) });
    const ctx = ctxOf(input);
    const r = checkSlot(ctx, { serviceId: 'lesson', staffId: 'aki', start: at(MON, 11), partySize: 1, now: NOW, mode: 'public' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.map((x) => x.code)).toContain('RESOURCE_FULL');
    const ok = checkSlot(ctx, { serviceId: 'lesson', staffId: 'aki', start: at(MON, 12), partySize: 1, now: NOW, mode: 'public' });
    expect(ok.ok).toBe(true);
  });

  it('4b. 同時利用数2のリソースは2セッションまで', () => {
    const input = baseInput({
      resources: [resource('bed', { quantity: 2 })],
      services: [service('massage', { resourceIds: ['bed'] })],
      staff: [staff('a', ['massage']), staff('b', ['massage']), staff('c', ['massage'])],
    });
    addBooking(input, { serviceId: 'massage', staffId: 'a', start: at(MON, 11) });
    expect(checkSlot(ctxOf(input), { serviceId: 'massage', staffId: 'b', start: at(MON, 11), partySize: 1, now: NOW, mode: 'public' }).ok).toBe(true);
    addBooking(input, { serviceId: 'massage', staffId: 'b', start: at(MON, 11) });
    const r = checkSlot(ctxOf(input), { serviceId: 'massage', staffId: 'c', start: at(MON, 11, 30), partySize: 1, now: NOW, mode: 'public' });
    expect(r.ok).toBe(false);
  });

  it('5. スタッフの休憩中は不可', () => {
    const input = baseInput({ staff: [staff('aki', ['s60'], { breaks: week(hours(h(12), h(13)), []) })] });
    const t = times(listSlots(ctxOf(input), { serviceId: 's60', staffId: 'aki', fromDate: MON, toDate: MON, partySize: 1, now: NOW, mode: 'public' }));
    expect(t).toContain('11:00');
    expect(t).not.toContain('11:30');
    expect(t).not.toContain('12:00');
    expect(t).not.toContain('12:30');
    expect(t).toContain('13:00');
  });

  it('6. 臨時休業日は不可', () => {
    const input = baseInput({ exceptions: [{ date: MON, kind: 'closed', intervals: [] }] });
    expect(listSlots(ctxOf(input), { serviceId: 's60', staffId: null, fromDate: MON, toDate: MON, partySize: 1, now: NOW, mode: 'public' })).toHaveLength(0);
    expect(listSlots(ctxOf(input), { serviceId: 's60', staffId: null, fromDate: TUE, toDate: TUE, partySize: 1, now: NOW, mode: 'public' }).length).toBeGreaterThan(0);
  });

  it('7. 最短受付2時間なら現在+2時間未満を出さない', () => {
    const input = baseInput();
    input.business.minNoticeMin = 120;
    const now = at(MON, 10, 10);
    const t = times(listSlots(ctxOf(input), { serviceId: 's60', staffId: null, fromDate: MON, toDate: MON, partySize: 1, now, mode: 'public' }));
    expect(t[0]).toBe('12:30');
    expect(t).not.toContain('12:00');
    const r = checkSlot(ctxOf(input), { serviceId: 's60', staffId: null, start: at(MON, 12), partySize: 1, now, mode: 'public' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons[0].code).toBe('TOO_SOON');
  });

  it('8. 予約可能期間30日なら31日先は出さない', () => {
    const input = baseInput();
    input.business.maxAdvanceDays = 30;
    input.business.weeklyHours = week(hours(h(10), h(18)), []);
    const now = at('2026-10-01', 9);
    const d30 = listSlots(ctxOf(input), { serviceId: 's60', staffId: null, fromDate: '2026-10-31', toDate: '2026-10-31', partySize: 1, now, mode: 'public' });
    const d31 = listSlots(ctxOf(input), { serviceId: 's60', staffId: null, fromDate: '2026-11-01', toDate: '2026-11-01', partySize: 1, now, mode: 'public' });
    expect(d30.length).toBeGreaterThan(0);
    expect(d31).toHaveLength(0);
    // admin (電話予約) mode waives the window
    const admin = listSlots(ctxOf(input), { serviceId: 's60', staffId: null, fromDate: '2026-11-01', toDate: '2026-11-01', partySize: 1, now, mode: 'admin' });
    expect(admin.length).toBeGreaterThan(0);
  });

  it('13. 定員6/予約5 → 2名は不可、1名は可（slotsモード）', () => {
    const input = baseInput({ services: [service('ws', { capacity: 6, maxPartySize: 6, durationMin: 120 })], staff: [staff('aki', ['ws'])] });
    addBooking(input, { serviceId: 'ws', staffId: 'aki', start: at(MON, 13), partySize: 3 });
    addBooking(input, { serviceId: 'ws', staffId: 'aki', start: at(MON, 13), partySize: 2 });
    const ctx = ctxOf(input);
    const two = checkSlot(ctx, { serviceId: 'ws', staffId: 'aki', start: at(MON, 13), partySize: 2, now: NOW, mode: 'public' });
    expect(two.ok).toBe(false);
    if (!two.ok) expect(two.reasons.map((r) => r.code)).toContain('CAPACITY_FULL');
    const one = checkSlot(ctx, { serviceId: 'ws', staffId: 'aki', start: at(MON, 13), partySize: 1, now: NOW, mode: 'public' });
    expect(one.ok).toBe(true);
    if (one.ok) {
      expect(one.joinsExisting).toBe(true);
      expect(one.remainingAfter).toBe(0);
    }
    // a different start overlapping the group session is blocked for the same staff
    expect(checkSlot(ctx, { serviceId: 'ws', staffId: 'aki', start: at(MON, 14), partySize: 1, now: NOW, mode: 'public' }).ok).toBe(false);
  });

  it('13b. 定員6/予約5（開催枠モード）→ 2名不可、1名可', () => {
    const input = baseInput({ services: [service('ws', { capacity: 6, maxPartySize: 6, bookingMode: 'sessions', durationMin: 120 })], staff: [staff('aki', ['ws'])] });
    input.occurrences.push({
      id: 'o1', serviceId: 'ws', staffId: 'aki', localDate: MON, start: at(MON, 13), end: at(MON, 15),
      occupiedStart: at(MON, 13), occupiedEnd: at(MON, 15), capacity: 6, status: 'scheduled', resourceIds: [],
    });
    input.bookings.push({ id: 'x1', serviceId: 'ws', staffId: 'aki', sessionKey: 'occ:o1', occurrenceId: 'o1', start: at(MON, 13), partySize: 5 });
    const ctx = ctxOf(input);
    expect(checkOccurrence(ctx, { occurrenceId: 'o1', partySize: 2, now: NOW, mode: 'public' }).ok).toBe(false);
    expect(checkOccurrence(ctx, { occurrenceId: 'o1', partySize: 1, now: NOW, mode: 'public' }).ok).toBe(true);
    const slots = listSlots(ctx, { serviceId: 'ws', staffId: null, fromDate: MON, toDate: MON, partySize: 1, now: NOW, mode: 'public' });
    expect(slots).toHaveLength(1);
    expect(slots[0].remaining).toBe(1);
  });

  it('14. おまかせは空いているスタッフだけに割り当てる', () => {
    const input = baseInput({ staff: [staff('aki', ['s60'], { sortOrder: 1 }), staff('mika', ['s60'], { sortOrder: 2 })] });
    addBooking(input, { serviceId: 's60', staffId: 'aki', start: at(MON, 11) });
    const r = checkSlot(ctxOf(input), { serviceId: 's60', staffId: null, start: at(MON, 11), partySize: 1, now: NOW, mode: 'public' });
    expect(r.ok && r.staffId).toBe('mika');
    // both free → fewer bookings that day wins (aki has 1) → mika
    const r2 = checkSlot(ctxOf(input), { serviceId: 's60', staffId: null, start: at(MON, 15), partySize: 1, now: NOW, mode: 'public' });
    expect(r2.ok && r2.staffId).toBe('mika');
    // equal load → display order → aki on Tuesday
    const r3 = checkSlot(ctxOf(input), { serviceId: 's60', staffId: null, start: at(TUE, 15), partySize: 1, now: NOW, mode: 'public' });
    expect(r3.ok && r3.staffId).toBe('aki');
    // nobody free → not ok
    addBooking(input, { serviceId: 's60', staffId: 'mika', start: at(MON, 11) });
    expect(checkSlot(ctxOf(input), { serviceId: 's60', staffId: null, start: at(MON, 11), partySize: 1, now: NOW, mode: 'public' }).ok).toBe(false);
  });

  it('16. タイムゾーン境界・日付跨ぎ（UTC日付と事業者日付が違う／深夜0時を跨ぐ営業）', () => {
    // Tokyo 08:00 on MON = UTC Sunday 23:00
    const input = baseInput();
    input.business.weeklyHours = week(hours(h(8), h(10)), []);
    const slots = listSlots(ctxOf(input), { serviceId: 's60', staffId: null, fromDate: MON, toDate: MON, partySize: 1, now: NOW, mode: 'public' });
    expect(new Date(slots[0].start).toISOString()).toBe('2026-10-04T23:00:00.000Z');
    // late-night business 20:00-24:00 + 00:00-02:00 → a 90-min booking at 23:30 crossing midnight is valid
    const night = baseInput({ services: [service('s90', { durationMin: 90 })], staff: [staff('aki', ['s90'])] });
    night.business.weeklyHours = week([hours(0, h(2)), hours(h(20), 1440)], []);
    const r = checkSlot(ctxOf(night), { serviceId: 's90', staffId: 'aki', start: at(MON, 23, 30), partySize: 1, now: NOW, mode: 'public' });
    expect(r.ok).toBe(true);
    // but if the next day is closed, it is not
    night.exceptions.push({ date: TUE, kind: 'closed', intervals: [] });
    expect(checkSlot(ctxOf(night), { serviceId: 's90', staffId: 'aki', start: at(MON, 23, 30), partySize: 1, now: NOW, mode: 'public' }).ok).toBe(false);
    // Non-Japan zone: America/Los_Angeles, 60 min. Local 17:00 on MON = UTC TUE 00:00
    const la = baseInput({}, 'America/Los_Angeles');
    const laSlots = listSlots(ctxOf(la), { serviceId: 's60', staffId: null, fromDate: MON, toDate: MON, partySize: 1, now: NOW, mode: 'public' });
    expect(formatLocal(laSlots[laSlots.length - 1].start, 'America/Los_Angeles', 'yyyy-MM-dd HH:mm')).toBe('2026-10-05 17:00');
    expect(new Date(laSlots[laSlots.length - 1].start).toISOString()).toBe('2026-10-06T00:00:00.000Z');
  });

  it('17. DST遷移日（America/New_York 春・秋、Europe/London 春）', () => {
    const NY = 'America/New_York';
    const input = baseInput({}, NY);
    input.business.weeklyHours = week(hours(0, h(6)), []);
    const now = localToInstant('2026-03-01', 0, NY);
    // spring forward 2026-03-08: 02:00-02:59 does not exist
    const spring = listSlots(ctxOf(input), { serviceId: 's60', staffId: null, fromDate: '2026-03-08', toDate: '2026-03-08', partySize: 1, now, mode: 'public' });
    const st = times(spring, NY);
    expect(st).not.toContain('02:00');
    expect(st).not.toContain('02:30');
    expect(st).toContain('01:30');
    const s0130 = spring.find((s) => formatLocal(s.start, NY, 'HH:mm') === '01:30')!;
    expect(formatLocal(s0130.end, NY, 'HH:mm')).toBe('03:30'); // 60 real minutes
    expect(s0130.end - s0130.start).toBe(60 * 60_000);
    // the business day is 5 real hours long → last start 05:00
    expect(st[st.length - 1]).toBe('05:00');
    // fall back 2026-11-01: 01:00 and 01:30 happen twice → offered once (earlier, EDT)
    const fall = listSlots(ctxOf(input), { serviceId: 's60', staffId: null, fromDate: '2026-11-01', toDate: '2026-11-01', partySize: 1, now: localToInstant('2026-10-20', 0, NY), mode: 'public' });
    const ft = times(fall, NY);
    expect(ft.filter((x) => x === '01:00')).toHaveLength(1);
    const f0100 = fall.find((s) => formatLocal(s.start, NY, 'HH:mm') === '01:00')!;
    expect(new Date(f0100.start).toISOString()).toBe('2026-11-01T05:00:00.000Z'); // EDT
    // bookings keep real duration across the switch; slots do not overlap each other in real time
    const starts = fall.map((s) => s.start);
    expect(new Set(starts).size).toBe(starts.length);
    // London spring 2026-03-29: 01:00-01:59 does not exist
    const LON = 'Europe/London';
    const lon = baseInput({}, LON);
    lon.business.weeklyHours = week(hours(0, h(4)), []);
    const lt = times(listSlots(ctxOf(lon), { serviceId: 's60', staffId: null, fromDate: '2026-03-29', toDate: '2026-03-29', partySize: 1, now: localToInstant('2026-03-20', 0, LON), mode: 'public' }), LON);
    expect(lt).not.toContain('01:00');
    expect(lt).not.toContain('01:30');
    expect(lt).toContain('00:00');
    expect(lt).toContain('02:00');
  });

  it('18. ブロックと既存予約の競合（ブロックは新規枠を止めるが既存予約データは消さない）', () => {
    const input = baseInput({ services: [service('s60', { bufferAfterMin: 15 })] });
    const existing = addBooking(input, { serviceId: 's60', staffId: 'aki', start: at(MON, 14) });
    input.blocks.push({ id: 'b1', scope: 'staff', targetId: 'aki', start: at(MON, 13), end: at(MON, 16) });
    input.blocks.push({ id: 'b2', scope: 'business', targetId: null, start: at(MON, 17, 5), end: at(MON, 17, 30) });
    const ctx = ctxOf(input);
    const t = times(listSlots(ctx, { serviceId: 's60', staffId: 'aki', fromDate: MON, toDate: MON, partySize: 1, now: NOW, mode: 'public' }));
    expect(t).not.toContain('12:00'); // 12:00-13:00 + 15 after buffer overlaps block at 13:00
    expect(t).toContain('11:30');
    expect(t).not.toContain('13:00');
    expect(t).not.toContain('16:00'); // ends 17:00 + 15 buffer → overlaps business block 17:05
    expect(t).not.toContain('16:30');
    expect(input.bookings).toContain(existing);
    const r = checkSlot(ctx, { serviceId: 's60', staffId: 'aki', start: at(MON, 13), partySize: 1, now: NOW, mode: 'admin' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.map((x) => x.code)).toEqual(expect.arrayContaining(['STAFF_BLOCKED', 'STAFF_BUSY']));
    // forced booking waives the block but never the overlap with the existing booking
    const f = checkSlot(ctx, { serviceId: 's60', staffId: 'aki', start: at(MON, 14), partySize: 1, now: NOW, mode: 'force' });
    expect(f.ok).toBe(false);
    if (!f.ok) expect(f.reasons.map((x) => x.code)).toContain('STAFF_BUSY');
    const f2 = checkSlot(ctx, { serviceId: 's60', staffId: 'aki', start: at(MON, 12), partySize: 1, now: NOW, mode: 'force' });
    expect(f2.ok).toBe(true);
  });

  it('19. 例外営業と通常定休の優先順位', () => {
    const input = baseInput();
    // Wednesday is a regular holiday → no slots
    expect(listSlots(ctxOf(input), { serviceId: 's60', staffId: null, fromDate: WED, toDate: WED, partySize: 1, now: NOW, mode: 'public' })).toHaveLength(0);
    // special hours on the regular holiday → open 13-15
    input.exceptions.push({ date: WED, kind: 'special_hours', intervals: [hours(h(13), h(15))] });
    expect(times(listSlots(ctxOf(input), { serviceId: 's60', staffId: null, fromDate: WED, toDate: WED, partySize: 1, now: NOW, mode: 'public' }))).toEqual(['13:00', '13:30', '14:00']);
    // closed + special on the same date → closed wins
    input.exceptions.push({ date: WED, kind: 'closed', intervals: [] });
    expect(listSlots(ctxOf(input), { serviceId: 's60', staffId: null, fromDate: WED, toDate: WED, partySize: 1, now: NOW, mode: 'public' })).toHaveLength(0);
    // short hours on a normal day replace weekly hours
    input.exceptions.push({ date: MON, kind: 'special_hours', intervals: [hours(h(10), h(12))] });
    expect(times(listSlots(ctxOf(input), { serviceId: 's60', staffId: null, fromDate: MON, toDate: MON, partySize: 1, now: NOW, mode: 'public' }))).toEqual(['10:00', '10:30', '11:00']);
  });

  it('20. アーカイブ済みスタッフへ新規予約を割り当てない', () => {
    const input = baseInput({ staff: [staff('old', ['s60'], { archived: true, sortOrder: 0 }), staff('mika', ['s60'], { sortOrder: 5 })] });
    const r = checkSlot(ctxOf(input), { serviceId: 's60', staffId: null, start: at(MON, 11), partySize: 1, now: NOW, mode: 'public' });
    expect(r.ok && r.staffId).toBe('mika');
    const direct = checkSlot(ctxOf(input), { serviceId: 's60', staffId: 'old', start: at(MON, 11), partySize: 1, now: NOW, mode: 'admin' });
    expect(direct.ok).toBe(false);
    input.staff[1].archived = true;
    expect(listSlots(ctxOf(input), { serviceId: 's60', staffId: null, fromDate: MON, toDate: MON, partySize: 1, now: NOW, mode: 'public' })).toHaveLength(0);
    // also staff with accepts_bookings=false
    input.staff[1].archived = false;
    input.staff[1].acceptsBookings = false;
    expect(listSlots(ctxOf(input), { serviceId: 's60', staffId: null, fromDate: MON, toDate: MON, partySize: 1, now: NOW, mode: 'public' })).toHaveLength(0);
  });
});

describe('エンジン補足', () => {
  it('キャンセル相当（予約除外）で枠が再開放される', () => {
    const input = baseInput();
    const b = addBooking(input, { serviceId: 's60', staffId: 'aki', start: at(MON, 11) });
    expect(checkSlot(ctxOf(input), { serviceId: 's60', staffId: 'aki', start: at(MON, 11), partySize: 1, now: NOW, mode: 'public' }).ok).toBe(false);
    // reschedule path: excluding own booking allows moving 30 min later on the same staff
    expect(checkSlot(ctxOf(input), { serviceId: 's60', staffId: 'aki', start: at(MON, 11, 30), partySize: 1, now: NOW, mode: 'public', excludeBookingId: b.id }).ok).toBe(true);
  });

  it('公開ページでは刻み外の時刻・非公開サービスを受け付けない', () => {
    const input = baseInput({ services: [service('s60'), service('hidden', { isPublic: false })], staff: [staff('aki', ['s60', 'hidden'])] });
    expect(checkSlot(ctxOf(input), { serviceId: 's60', staffId: 'aki', start: at(MON, 10, 10), partySize: 1, now: NOW, mode: 'public' }).ok).toBe(false);
    expect(checkSlot(ctxOf(input), { serviceId: 's60', staffId: 'aki', start: at(MON, 10, 10), partySize: 1, now: NOW, mode: 'admin' }).ok).toBe(true);
    expect(checkSlot(ctxOf(input), { serviceId: 'hidden', staffId: 'aki', start: at(MON, 11), partySize: 1, now: NOW, mode: 'public' }).ok).toBe(false);
    expect(checkSlot(ctxOf(input), { serviceId: 'hidden', staffId: 'aki', start: at(MON, 11), partySize: 1, now: NOW, mode: 'admin' }).ok).toBe(true);
  });

  it('リソースの利用可能時間は準備/片付けを含む占有時間で判定', () => {
    const input = baseInput({
      resources: [resource('studio', { hasHours: true, weeklyHours: week(hours(h(10), h(18)), []) })],
      services: [service('photo', { durationMin: 90, bufferBeforeMin: 15, resourceIds: ['studio'], requiresStaff: false })],
      staff: [],
    });
    const t = times(listSlots(ctxOf(input), { serviceId: 'photo', staffId: null, fromDate: MON, toDate: MON, partySize: 1, now: NOW, mode: 'public' }));
    expect(t[0]).toBe('10:30'); // 10:00 would need 09:45 in the studio
    expect(t[t.length - 1]).toBe('16:30');
  });

  it('スタッフ不要サービス（レンタルスペース）はリソースのみで判定', () => {
    const input = baseInput({ resources: [resource('roomA')], services: [service('rent', { requiresStaff: false, resourceIds: ['roomA'] })], staff: [] });
    addBooking(input, { serviceId: 'rent', staffId: null, start: at(MON, 10) });
    const t = times(listSlots(ctxOf(input), { serviceId: 'rent', staffId: null, fromDate: MON, toDate: MON, partySize: 1, now: NOW, mode: 'public' }));
    expect(t).not.toContain('10:00');
    expect(t).not.toContain('10:30');
    expect(t).toContain('11:00');
  });
});

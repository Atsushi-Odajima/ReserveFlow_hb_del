/**
 * Measures response times of the main screens/APIs against the load dataset, plus concurrent booking contention.
 * Server must be running against the load DB (see TEST_REPORT.md). Results are written to tests/load/results/.
 * Usage: LOAD_BASE_URL=http://127.0.0.1:8791 npx tsx tests/load/run-load.ts
 */
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const base = process.env.LOAD_BASE_URL ?? 'http://127.0.0.1:8791';
const N = Number(process.env.LOAD_N ?? 40);
const CONC = Number(process.env.LOAD_CONC ?? 4);

const jst = (d: number) => new Date(Date.now() + d * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });

async function main() {
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'load@example.test', password: 'load-password-123' }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const csrf = (await login.json()).csrfToken;
  const H = { cookie };
  const pub = await (await fetch(`${base}/api/public/load-shop`)).json();
  const svc = pub.services.find((s: any) => s.name === 'Service 12') ?? pub.services[11];
  const staff = await (await fetch(`${base}/api/admin/staff`, { headers: H })).json();

  const cases: Array<[string, string, Record<string, string>]> = [
    ['予約一覧（1か月・50件/頁）', `/api/admin/bookings?from=${jst(0)}&to=${jst(30)}`, H],
    ['予約検索（氏名部分一致）', `/api/admin/bookings?q=${encodeURIComponent('顧客 123')}&from=${jst(-400)}&to=${jst(100)}`, H],
    ['今日の予約（受付）', `/api/admin/today`, H],
    ['ダッシュボード', `/api/admin/dashboard`, H],
    ['カレンダー（週・全スタッフ）', `/api/admin/calendar?from=${jst(0)}&to=${jst(6)}`, H],
    ['空き検索（1サービス・おまかせ・7日）', `/api/admin/availability?serviceId=${svc.id}&from=${jst(1)}&to=${jst(7)}`, H],
    ['顧客検索（前方一致）', `/api/admin/customers?q=${encodeURIComponent('顧客 4999')}`, H],
    ['顧客一覧（頁1）', `/api/admin/customers`, H],
    ['公開ページ（プロフィール）', `/api/public/load-shop`, {}],
    ['公開ページ 空き枠（1か月・おまかせ）', `/api/public/load-shop/slots?serviceId=${svc.id}&from=${jst(0)}&to=${jst(30)}`, {}],
    ['通知履歴（頁1）', `/api/admin/notifications`, H],
  ];
  const results: any[] = [];
  for (const [name, path, headers] of cases) {
    const times: number[] = [];
    let errors = 0;
    let i = 0;
    await Promise.all(
      Array.from({ length: CONC }, async () => {
        while (i < N) {
          i++;
          const t = performance.now();
          const r = await fetch(base + path, { headers });
          await r.arrayBuffer();
          times.push(performance.now() - t);
          if (!r.ok) errors++;
        }
      }),
    );
    times.sort((a, b) => a - b);
    const p = (q: number) => Math.round(times[Math.min(times.length - 1, Math.floor(q * times.length))]);
    results.push({ name, n: times.length, concurrency: CONC, p50: p(0.5), p95: p(0.95), max: Math.round(times[times.length - 1]), errors });
    console.log(`${name.padEnd(28)} p50=${p(0.5)}ms p95=${p(0.95)}ms max=${Math.round(times[times.length - 1])}ms errors=${errors}`);
  }

  // contention: 50 simultaneous confirmations of the SAME slot
  // seeded bookings occupy 10:00-17:55 every day for every staff → 19:30 is free
  const date = jst(5);
  const sameStart = new Date(`${date}T19:30:00+09:00`).toISOString();
  const staffId = svc.staffIds[0];
  const t1 = performance.now();
  const same = await Promise.all(
    Array.from({ length: 50 }, (_, k) =>
      fetch(`${base}/api/admin/bookings`, { method: 'POST', headers: { ...H, 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ serviceId: svc.id, staffId, start: sameStart, customer: { name: `競合${k}` }, source: 'phone', idempotencyKey: randomUUID() }) }).then((r) => r.status),
    ),
  );
  const sameMs = Math.round(performance.now() - t1);
  const sameResult = { ok: same.filter((s) => s === 200).length, conflict: same.filter((s) => s === 409).length, other: same.filter((s) => s !== 200 && s !== 409).length, totalMs: sameMs };
  console.log('同一枠へ50同時確定:', sameResult);

  // throughput: 100 simultaneous confirmations of DIFFERENT slots (different staff/times) on the public page
  const t2 = performance.now();
  const lat: number[] = [];
  const diff = await Promise.all(
    Array.from({ length: 100 }, async (_, k) => {
      const st = staff.staff[k % 50];
      const svcFor = pub.services.find((s: any) => s.staffIds.includes(st.id) && s.bookingMode === 'slots' && s.capacity === 1 && s.durationMin <= 60 && Number(s.name.split(' ')[1]) > 10); // Service 1-10 share rooms
      if (!svcFor) return 0;
      // 50 staff × 2 dates, each at 19:00 on its own staff → no two requests compete
      const start = new Date(`${jst(6 + Math.floor(k / 50))}T19:00:00+09:00`).toISOString();
      const t = performance.now();
      const r = await fetch(`${base}/api/public/load-shop/bookings`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.${k}.1` }, body: JSON.stringify({ serviceId: svcFor.id, staffId: st.id, start, customer: { name: `並列${k}`, email: `p${k}@example.test` }, idempotencyKey: randomUUID(), elapsedMs: 5000 }) });
      lat.push(performance.now() - t);
      if (r.status !== 200) console.log('non-200 in parallel test:', k, st.displayName, svcFor.name, start, (await r.text()).slice(0, 300));
      return r.status;
    }),
  );
  lat.sort((a, b) => a - b);
  const diffResult = { requests: diff.length, ok: diff.filter((s) => s === 200).length, conflict: diff.filter((s) => s === 409).length, other: diff.filter((s) => s !== 200 && s !== 409).length, totalMs: Math.round(performance.now() - t2), p50: Math.round(lat[Math.floor(lat.length / 2)]), p95: Math.round(lat[Math.floor(lat.length * 0.95)]) };
  console.log('別枠へ100同時確定:', diffResult);

  const out = { measuredAt: new Date().toISOString(), base, node: process.version, dataset: 'services 100 / staff 50 / resources 100 / customers 50,000 / bookings 200,000 / notifications 500,000', results, sameSlot50: sameResult, differentSlots100: diffResult };
  writeFileSync(`tests/load/results/load-${out.measuredAt.slice(0, 10)}.json`, JSON.stringify(out, null, 2));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

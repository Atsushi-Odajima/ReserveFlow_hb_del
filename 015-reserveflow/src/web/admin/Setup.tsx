import { useState } from 'react';
import { del, get, post, put, qs } from '../api';
import { Confirm, ErrorAlert, Field, HoursEditor, Loading, Modal, useLoad, useToast, type HourRow } from '../components/ui';
import { addDays, dateLabel, fmtShortDateTime, localToIso, minToTime, timeToMin, todayIn } from '../format';
import { QUESTION_TYPE_LABEL, WEEKDAYS } from '../../shared/labels';
import { useSession } from './session';

const num = (v: string, d = 0) => (v === '' || Number.isNaN(Number(v)) ? d : Number(v));

function ArchiveButton({ path, archived, onDone }: { path: string; archived: boolean; onDone: () => void }) {
  return (
    <button className="btn-sm" onClick={async () => { await post(`${path}/${archived ? 'restore' : 'archive'}`); onDone(); }}>
      {archived ? '復元' : 'アーカイブ'}
    </button>
  );
}

// ------------------------------------------------------------------ services
export function ServicesPage() {
  const { data, error, loading, reload } = useLoad<any>(async () => ({ ...(await get('/api/admin/services')), ...(await get('/api/admin/staff')), ...(await get('/api/admin/resources')) }), []);
  const [edit, setEdit] = useState<any | null>(null);
  if (loading && !data) return <Loading />;
  return (
    <div>
      <div className="row"><h1 style={{ margin: 0 }}>サービス（メニュー）</h1><span className="spacer" /><button className="btn-primary" onClick={() => setEdit({})}>＋ サービスを追加</button></div>
      <ErrorAlert error={error} />
      <p className="small muted">所要時間の前後に「準備時間」「片付け時間」を設定すると、その時間もスタッフと部屋が占有されます（例：60分＋前15分＋後15分 → 10:00開始なら 9:45〜11:15 を占有）。</p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>名称</th><th>時間</th><th className="hide-mobile">準備/片付け</th><th className="hide-mobile">定員</th><th>公開</th><th /></tr></thead>
          <tbody>
            {data?.services.map((s: any) => (
              <tr key={s.id} style={{ opacity: s.archived ? 0.5 : 1 }}>
                <td><button className="btn-ghost" style={{ padding: 0, minHeight: 0 }} onClick={() => setEdit(s)}>{s.name}</button>{s.bookingMode === 'sessions' && <span className="tag">開催日程</span>}{!s.acceptsBookings && <span className="tag">受付停止</span>}{s.archived && <span className="tag">アーカイブ</span>}</td>
                <td>{s.durationMin}分</td>
                <td className="hide-mobile">{s.bufferBeforeMin}分 / {s.bufferAfterMin}分</td>
                <td className="hide-mobile">{s.capacity}名</td>
                <td>{s.isPublic ? '公開' : '非公開'}</td>
                <td><ArchiveButton path={`/api/admin/services/${s.id}`} archived={s.archived} onDone={reload} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <ServiceForm svc={edit} staff={data.staff} resources={data.resources} onClose={() => setEdit(null)} onSaved={reload} />}
    </div>
  );
}

function ServiceForm({ svc, staff, resources, onClose, onSaved }: { svc: any; staff: any[]; resources: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: svc.name ?? '', description: svc.description ?? '', category: svc.category ?? '', durationMin: String(svc.durationMin ?? 60), bufferBeforeMin: String(svc.bufferBeforeMin ?? 0), bufferAfterMin: String(svc.bufferAfterMin ?? 0),
    priceText: svc.priceText ?? '', capacity: String(svc.capacity ?? 1), maxPartySize: String(svc.maxPartySize ?? 1), requiresStaff: svc.requiresStaff ?? true, bookingMode: svc.bookingMode ?? 'slots',
    slotIntervalMin: svc.slotIntervalMin ? String(svc.slotIntervalMin) : '', acceptsBookings: svc.acceptsBookings ?? true, isPublic: svc.isPublic ?? true, sortOrder: String(svc.sortOrder ?? 0), notes: svc.notes ?? '',
    staffIds: (svc.staffIds ?? []) as string[], resourceIds: (svc.resourceIds ?? []) as string[],
  });
  const [err, setErr] = useState<any>(null);
  const toggle = (k: 'staffIds' | 'resourceIds', id: string) => setF({ ...f, [k]: f[k].includes(id) ? f[k].filter((x) => x !== id) : [...f[k], id] });
  const fe = (k: string) => err?.fieldErrors?.[k];
  const occ = num(f.durationMin) + num(f.bufferBeforeMin) + num(f.bufferAfterMin);
  return (
    <Modal title={svc.id ? 'サービスを編集' : 'サービスを追加'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          const body = { ...f, durationMin: num(f.durationMin), bufferBeforeMin: num(f.bufferBeforeMin), bufferAfterMin: num(f.bufferAfterMin), capacity: num(f.capacity, 1), maxPartySize: num(f.maxPartySize, 1), sortOrder: num(f.sortOrder), slotIntervalMin: f.slotIntervalMin ? num(f.slotIntervalMin) : null };
          try {
            if (svc.id) await put(`/api/admin/services/${svc.id}`, body);
            else await post('/api/admin/services', body);
            onClose();
            onSaved();
          } catch (x) {
            setErr(x);
          }
        }}
      >
        <Field label="名称" required error={fe('name')}>{(p) => <input {...p} type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="説明（予約ページに表示）">{(p) => <textarea {...p} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
        <div className="grid-3">
          <Field label="所要時間（分）" required error={fe('durationMin')}>{(p) => <input {...p} type="number" min={5} max={1440} value={f.durationMin} onChange={(e) => setF({ ...f, durationMin: e.target.value })} />}</Field>
          <Field label="準備時間（前・分）">{(p) => <input {...p} type="number" min={0} max={240} value={f.bufferBeforeMin} onChange={(e) => setF({ ...f, bufferBeforeMin: e.target.value })} />}</Field>
          <Field label="片付け時間（後・分）">{(p) => <input {...p} type="number" min={0} max={240} value={f.bufferAfterMin} onChange={(e) => setF({ ...f, bufferAfterMin: e.target.value })} />}</Field>
        </div>
        <p className="small muted">占有時間の合計: {occ}分（スタッフ・部屋はこの時間ふさがります）</p>
        <div className="grid-2">
          <Field label="価格表示（任意・表示のみ）" hint="例: 6,600円（税込）。決済は行いません">{(p) => <input {...p} type="text" value={f.priceText} onChange={(e) => setF({ ...f, priceText: e.target.value })} />}</Field>
          <Field label="カテゴリ（任意）">{(p) => <input {...p} type="text" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />}</Field>
        </div>
        <Field label="予約の取り方">
          {(p) => (
            <select {...p} value={f.bookingMode} onChange={(e) => setF({ ...f, bookingMode: e.target.value })}>
              <option value="slots">空き時間から選ぶ（通常）</option>
              <option value="sessions">開催日程から選ぶ（教室・ワークショップ／繰り返し開催枠）</option>
            </select>
          )}
        </Field>
        <div className="grid-3">
          <Field label="同時受付数（定員）" hint="1=マンツーマン" error={fe('capacity')}>{(p) => <input {...p} type="number" min={1} max={500} value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} />}</Field>
          <Field label="1予約の最大人数" error={fe('maxPartySize')}>{(p) => <input {...p} type="number" min={1} max={500} value={f.maxPartySize} onChange={(e) => setF({ ...f, maxPartySize: e.target.value })} />}</Field>
          <Field label="開始時刻の刻み" hint="空欄=事業者設定">
            {(p) => (
              <select {...p} value={f.slotIntervalMin} onChange={(e) => setF({ ...f, slotIntervalMin: e.target.value })}>
                <option value="">事業者設定に従う</option>
                {[5, 10, 15, 20, 30, 60, 90, 120].map((m) => <option key={m} value={m}>{m}分</option>)}
              </select>
            )}
          </Field>
        </div>
        <label className="check"><input type="checkbox" checked={f.requiresStaff} onChange={(e) => setF({ ...f, requiresStaff: e.target.checked })} /><span>スタッフが必要（レンタルスペース等はオフ）</span></label>
        {f.requiresStaff && (
          <fieldset style={{ border: 0, padding: 0 }}>
            <legend className="label">対応スタッフ</legend>
            {staff.filter((s) => !s.archived).map((s) => <label key={s.id} className="check"><input type="checkbox" checked={f.staffIds.includes(s.id)} onChange={() => toggle('staffIds', s.id)} /><span>{s.displayName}</span></label>)}
            {staff.length === 0 && <p className="small muted">スタッフが未登録です。</p>}
          </fieldset>
        )}
        <fieldset style={{ border: 0, padding: 0 }}>
          <legend className="label">必要なリソース（すべて空いているときだけ予約可）</legend>
          {resources.filter((r) => !r.archived).map((r) => <label key={r.id} className="check"><input type="checkbox" checked={f.resourceIds.includes(r.id)} onChange={() => toggle('resourceIds', r.id)} /><span>{r.name}</span></label>)}
          {resources.length === 0 && <p className="small muted">リソースは未登録です（任意）。</p>}
        </fieldset>
        <Field label="注意事項（受付画面・予約ページに表示）">{(p) => <textarea {...p} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />}</Field>
        <div className="grid-2">
          <label className="check"><input type="checkbox" checked={f.isPublic} onChange={(e) => setF({ ...f, isPublic: e.target.checked })} /><span>予約ページに公開</span></label>
          <label className="check"><input type="checkbox" checked={f.acceptsBookings} onChange={(e) => setF({ ...f, acceptsBookings: e.target.checked })} /><span>予約を受け付ける</span></label>
        </div>
        <Field label="表示順（小さい順）">{(p) => <input {...p} type="number" value={f.sortOrder} onChange={(e) => setF({ ...f, sortOrder: e.target.value })} style={{ width: 120 }} />}</Field>
        <ErrorAlert error={err} />
        <div className="btn-row"><button type="button" onClick={onClose}>やめる</button><button className="btn-primary">保存</button></div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ staff
export function StaffPage() {
  const { data, error, loading, reload } = useLoad<any>(async () => ({ ...(await get('/api/admin/staff')), ...(await get('/api/admin/services')) }), []);
  const [edit, setEdit] = useState<any | null>(null);
  const [invite, setInvite] = useState<any | null>(null);
  if (loading && !data) return <Loading />;
  return (
    <div>
      <div className="row"><h1 style={{ margin: 0 }}>スタッフ</h1><span className="spacer" /><button className="btn-primary" onClick={() => setEdit({})}>＋ スタッフを追加</button></div>
      <ErrorAlert error={error} />
      <p className="small muted">休み・半休は「休み・ブロック」から登録します。アーカイブしたスタッフには新しい予約が入りません（既存予約は残ります）。</p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>表示名</th><th>対応サービス</th><th className="hide-mobile">勤務</th><th className="hide-mobile">ログイン</th><th /></tr></thead>
          <tbody>
            {data?.staff.map((s: any) => (
              <tr key={s.id} style={{ opacity: s.archived ? 0.5 : 1 }}>
                <td><span aria-hidden="true" style={{ color: s.color }}>●</span> <button className="btn-ghost" style={{ padding: 0, minHeight: 0 }} onClick={() => setEdit(s)}>{s.displayName}</button>{!s.acceptsBookings && <span className="tag">受付停止</span>}{s.archived && <span className="tag">アーカイブ</span>}</td>
                <td className="small">{data.services.filter((v: any) => s.serviceIds.includes(v.id)).map((v: any) => v.name).join('、') || '—'}</td>
                <td className="hide-mobile small">{s.usesBusinessHours ? '営業時間に従う' : '個別設定'}{s.breaks.length ? ' ・ 休憩あり' : ''}</td>
                <td className="hide-mobile small">{(s.logins ?? []).map((l: any) => l.email).join(', ') || <button className="btn-sm" onClick={() => setInvite(s)}>ログイン招待</button>}</td>
                <td><ArchiveButton path={`/api/admin/staff/${s.id}`} archived={s.archived} onDone={reload} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <StaffForm st={edit} services={data.services} onClose={() => setEdit(null)} onSaved={reload} />}
      {invite && <InviteDialog staff={invite} onClose={() => setInvite(null)} />}
    </div>
  );
}

function StaffForm({ st, services, onClose, onSaved }: { st: any; services: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    displayName: st.displayName ?? '', internalName: st.internalName ?? '', email: st.email ?? '', profile: st.profile ?? '', acceptsBookings: st.acceptsBookings ?? true, usesBusinessHours: st.usesBusinessHours ?? true,
    maxParticipants: st.maxParticipants ? String(st.maxParticipants) : '', color: st.color ?? '#4a7bd0', sortOrder: String(st.sortOrder ?? 0), serviceIds: (st.serviceIds ?? []) as string[],
    hours: (st.hours ?? []) as HourRow[], breaks: (st.breaks ?? []) as HourRow[],
  });
  const [err, setErr] = useState<any>(null);
  return (
    <Modal title={st.id ? 'スタッフを編集' : 'スタッフを追加'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          const body = { ...f, maxParticipants: f.maxParticipants ? num(f.maxParticipants) : null, sortOrder: num(f.sortOrder) };
          try {
            if (st.id) await put(`/api/admin/staff/${st.id}`, body);
            else await post('/api/admin/staff', body);
            onClose();
            onSaved();
          } catch (x) {
            setErr(x);
          }
        }}
      >
        <div className="grid-2">
          <Field label="表示名（予約ページに表示）" required error={err?.fieldErrors?.displayName}>{(p) => <input {...p} type="text" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} />}</Field>
          <Field label="内部名（管理用・非公開）">{(p) => <input {...p} type="text" value={f.internalName} onChange={(e) => setF({ ...f, internalName: e.target.value })} />}</Field>
        </div>
        <Field label="公開プロフィール（任意）">{(p) => <textarea {...p} value={f.profile} onChange={(e) => setF({ ...f, profile: e.target.value })} />}</Field>
        <div className="grid-3">
          <Field label="メール（任意・非公開）">{(p) => <input {...p} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
          <Field label="色">{(p) => <input {...p} type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} style={{ minHeight: 44, width: 80 }} />}</Field>
          <Field label="表示順">{(p) => <input {...p} type="number" value={f.sortOrder} onChange={(e) => setF({ ...f, sortOrder: e.target.value })} />}</Field>
        </div>
        <fieldset style={{ border: 0, padding: 0 }}>
          <legend className="label">対応サービス</legend>
          {services.filter((s) => !s.archived).map((s) => <label key={s.id} className="check"><input type="checkbox" checked={f.serviceIds.includes(s.id)} onChange={() => setF({ ...f, serviceIds: f.serviceIds.includes(s.id) ? f.serviceIds.filter((x) => x !== s.id) : [...f.serviceIds, s.id] })} /><span>{s.name}</span></label>)}
        </fieldset>
        <label className="check"><input type="checkbox" checked={f.acceptsBookings} onChange={(e) => setF({ ...f, acceptsBookings: e.target.checked })} /><span>予約を受け付ける</span></label>
        <label className="check"><input type="checkbox" checked={f.usesBusinessHours} onChange={(e) => setF({ ...f, usesBusinessHours: e.target.checked })} /><span>勤務時間は事業者の営業時間と同じ</span></label>
        {!f.usesBusinessHours && <HoursEditor label="勤務時間（曜日ごと）" value={f.hours} onChange={(hours) => setF({ ...f, hours })} />}
        <HoursEditor label="毎週の休憩時間（任意）" value={f.breaks} onChange={(breaks) => setF({ ...f, breaks })} />
        <Field label="同時に担当できる最大人数（定員制サービス用・任意）">{(p) => <input {...p} type="number" min={1} value={f.maxParticipants} onChange={(e) => setF({ ...f, maxParticipants: e.target.value })} style={{ width: 120 }} />}</Field>
        <ErrorAlert error={err} />
        <div className="btn-row"><button type="button" onClick={onClose}>やめる</button><button className="btn-primary">保存</button></div>
      </form>
    </Modal>
  );
}

function InviteDialog({ staff, onClose }: { staff: any; onClose: () => void }) {
  const [email, setEmail] = useState(staff.email ?? '');
  const [perms, setPerms] = useState({ viewAllBookings: false, manageBookings: true, viewCustomers: true, manageOwnBlocks: true });
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  return (
    <Modal title={`${staff.displayName} をログイン招待`} onClose={onClose}>
      {res ? (
        <>
          <div className="alert alert-ok">招待を作成しました（7日間有効・1回限り）。メール送信設定がない場合は、下のリンクを本人に直接伝えてください。</div>
          <p style={{ wordBreak: 'break-all' }}><code>{res.inviteUrl}</code></p>
          <button onClick={onClose}>閉じる</button>
        </>
      ) : (
        <form onSubmit={async (e) => { e.preventDefault(); try { setRes(await post('/api/admin/invites', { email, role: 'staff', staffId: staff.id, permissions: perms, sendEmail: true })); } catch (x) { setErr(x); } }}>
          <Field label="ログインに使うメールアドレス" required>{(p) => <input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <fieldset style={{ border: 0, padding: 0 }}>
            <legend className="label">権限</legend>
            <label className="check"><input type="checkbox" checked={perms.viewAllBookings} onChange={(e) => setPerms({ ...perms, viewAllBookings: e.target.checked })} /><span>他のスタッフの予約も見る・操作する</span></label>
            <label className="check"><input type="checkbox" checked={perms.manageBookings} onChange={(e) => setPerms({ ...perms, manageBookings: e.target.checked })} /><span>予約の作成・変更・キャンセル</span></label>
            <label className="check"><input type="checkbox" checked={perms.viewCustomers} onChange={(e) => setPerms({ ...perms, viewCustomers: e.target.checked })} /><span>顧客情報・待機リストの閲覧</span></label>
            <label className="check"><input type="checkbox" checked={perms.manageOwnBlocks} onChange={(e) => setPerms({ ...perms, manageOwnBlocks: e.target.checked })} /><span>自分の休み・ブロックの登録</span></label>
            <p className="small muted">受付（来店・完了・無断欠席の記録）は常に可能です。設定・CSV・バックアップはオーナーのみ。</p>
          </fieldset>
          <ErrorAlert error={err} />
          <button className="btn-primary">招待を作成</button>
        </form>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ resources
export function ResourcesPage() {
  const { data, error, loading, reload } = useLoad<any>(async () => ({ ...(await get('/api/admin/resources')), ...(await get('/api/admin/services')) }), []);
  const [edit, setEdit] = useState<any | null>(null);
  if (loading && !data) return <Loading />;
  return (
    <div>
      <div className="row"><h1 style={{ margin: 0 }}>リソース（部屋・設備）</h1><span className="spacer" /><button className="btn-primary" onClick={() => setEdit({})}>＋ リソースを追加</button></div>
      <ErrorAlert error={error} />
      <p className="small muted">施術室・スタジオ・会議室・機材・ベッド等。サービスに「必要なリソース」として設定すると、埋まっている時間は予約できなくなります。休止期間は「休み・ブロック」から登録します。</p>
      <table className="table">
        <thead><tr><th>名称</th><th>同時利用数</th><th className="hide-mobile">使うサービス</th><th /></tr></thead>
        <tbody>
          {data?.resources.map((r: any) => (
            <tr key={r.id} style={{ opacity: r.archived ? 0.5 : 1 }}>
              <td><button className="btn-ghost" style={{ padding: 0, minHeight: 0 }} onClick={() => setEdit(r)}>{r.name}</button> <span className="small muted">{r.kind}</span>{r.archived && <span className="tag">アーカイブ</span>}</td>
              <td>{r.quantity}</td>
              <td className="hide-mobile small">{data.services.filter((s: any) => r.serviceIds.includes(s.id)).map((s: any) => s.name).join('、') || '—'}</td>
              <td><ArchiveButton path={`/api/admin/resources/${r.id}`} archived={r.archived} onDone={reload} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && <ResourceForm r={edit} services={data.services} onClose={() => setEdit(null)} onSaved={reload} />}
    </div>
  );
}

function ResourceForm({ r, services, onClose, onSaved }: { r: any; services: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: r.name ?? '', kind: r.kind ?? 'room', quantity: String(r.quantity ?? 1), personCapacity: r.personCapacity ? String(r.personCapacity) : '', hasHours: r.hasHours ?? false, hours: (r.hours ?? []) as HourRow[], sortOrder: String(r.sortOrder ?? 0), serviceIds: (r.serviceIds ?? []) as string[] });
  const [err, setErr] = useState<unknown>(null);
  return (
    <Modal title={r.id ? 'リソースを編集' : 'リソースを追加'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const body = { ...f, quantity: num(f.quantity, 1), personCapacity: f.personCapacity ? num(f.personCapacity) : null, sortOrder: num(f.sortOrder) };
          try {
            if (r.id) await put(`/api/admin/resources/${r.id}`, body);
            else await post('/api/admin/resources', body);
            onClose();
            onSaved();
          } catch (x) {
            setErr(x);
          }
        }}
      >
        <Field label="名称" required>{(p) => <input {...p} type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <div className="grid-3">
          <Field label="種類">
            {(p) => (
              <select {...p} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
                {[['room', '部屋'], ['studio', 'スタジオ'], ['equipment', '機材'], ['bed', 'ベッド・席'], ['vehicle', '車両'], ['other', 'その他']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            )}
          </Field>
          <Field label="同時利用可能数" hint="同じものが複数ある場合">{(p) => <input {...p} type="number" min={1} max={100} value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} />}</Field>
          <Field label="部屋の定員（任意）">{(p) => <input {...p} type="number" min={1} value={f.personCapacity} onChange={(e) => setF({ ...f, personCapacity: e.target.value })} />}</Field>
        </div>
        <fieldset style={{ border: 0, padding: 0 }}>
          <legend className="label">このリソースを使うサービス</legend>
          {services.filter((s) => !s.archived).map((s) => <label key={s.id} className="check"><input type="checkbox" checked={f.serviceIds.includes(s.id)} onChange={() => setF({ ...f, serviceIds: f.serviceIds.includes(s.id) ? f.serviceIds.filter((x) => x !== s.id) : [...f.serviceIds, s.id] })} /><span>{s.name}</span></label>)}
        </fieldset>
        <label className="check"><input type="checkbox" checked={f.hasHours} onChange={(e) => setF({ ...f, hasHours: e.target.checked })} /><span>利用可能時間を設定する（未設定なら時間制限なし）</span></label>
        {f.hasHours && <HoursEditor label="利用可能時間" value={f.hours} onChange={(hours) => setF({ ...f, hours })} />}
        <ErrorAlert error={err} />
        <div className="btn-row"><button type="button" onClick={onClose}>やめる</button><button className="btn-primary">保存</button></div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ hours & exceptions
export function HoursPage() {
  const { tz } = useSession();
  const toast = useToast();
  const hours = useLoad<{ hours: HourRow[] }>(() => get('/api/admin/hours'), []);
  const today = todayIn(tz);
  const exc = useLoad<{ exceptions: any[] }>(() => get(`/api/admin/exceptions${qs({ from: addDays(today, -30) })}`), []);
  const [draft, setDraft] = useState<HourRow[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [ex, setEx] = useState({ date: today, kind: 'closed', label: '', start: '10:00', end: '15:00' });
  const value = draft ?? hours.data?.hours ?? [];
  return (
    <div>
      <h1>営業時間・休業日</h1>
      <p className="small muted">時刻は {tz} です。優先順位: ①臨時休業/祝日休業 ＞ ②特別営業/短縮営業 ＞ ③通常の曜日営業時間。</p>
      {hours.loading && !hours.data ? <Loading /> : (
        <>
          <HoursEditor label="通常の営業時間（受付可能時間）" value={value} onChange={setDraft} />
          <ErrorAlert error={err} />
          <button className="btn-primary" disabled={!draft} onClick={async () => { try { await put('/api/admin/hours', { hours: value }); setDraft(null); hours.reload(); toast('営業時間を保存しました'); } catch (e) { setErr(e); } }}>営業時間を保存</button>
        </>
      )}
      <div className="card" style={{ marginTop: 16 }}>
        <h2>休業日・特別営業（日付指定）</h2>
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            try {
              const r = await post('/api/admin/exceptions', { date: ex.date, kind: ex.kind, label: ex.label, intervals: ex.kind === 'special_hours' ? [{ startMin: timeToMin(ex.start), endMin: ex.end === '23:59' ? 1440 : timeToMin(ex.end) }] : [] });
              toast(r.existingBookings ? `登録しました。この日には既存の予約が ${r.existingBookings} 件あります（自動ではキャンセルされません）` : '登録しました');
              exc.reload();
            } catch (x) {
              setErr(x);
            }
          }}
        >
          <input type="date" aria-label="日付" value={ex.date} onChange={(e) => setEx({ ...ex, date: e.target.value })} style={{ width: 170 }} />
          <select aria-label="種類" value={ex.kind} onChange={(e) => setEx({ ...ex, kind: e.target.value })} style={{ width: 'auto' }}>
            <option value="closed">臨時休業・祝日休業</option>
            <option value="special_hours">特別営業・短縮営業</option>
          </select>
          {ex.kind === 'special_hours' && (<><input type="time" aria-label="開始" value={ex.start} onChange={(e) => setEx({ ...ex, start: e.target.value })} style={{ width: 120 }} />〜<input type="time" aria-label="終了" value={ex.end} onChange={(e) => setEx({ ...ex, end: e.target.value })} style={{ width: 120 }} /></>)}
          <input type="text" aria-label="メモ" placeholder="メモ（例: 設備点検）" value={ex.label} onChange={(e) => setEx({ ...ex, label: e.target.value })} style={{ width: 200 }} />
          <button className="btn-primary">追加</button>
        </form>
        <table className="table" style={{ marginTop: 12 }}>
          <tbody>
            {exc.data?.exceptions.map((e) => (
              <tr key={e.id}>
                <td>{dateLabel(e.date)}</td>
                <td>{e.kind === 'closed' ? '休業' : `営業 ${e.intervals.map((i: any) => `${minToTime(i.startMin)}〜${minToTime(i.endMin)}`).join(', ')}`}</td>
                <td>{e.label}</td>
                <td><button className="btn-sm" onClick={async () => { await del(`/api/admin/exceptions/${e.id}`); exc.reload(); }}>削除</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ blocks
export function BlocksPage() {
  const { tz, isOwner, me } = useSession();
  const toast = useToast();
  const today = todayIn(tz);
  const staff = useLoad<any>(() => get('/api/admin/staff'), []);
  const resources = useLoad<any>(() => get('/api/admin/resources'), []);
  const list = useLoad<{ blocks: any[] }>(() => get(`/api/admin/blocks${qs({ from: today, to: addDays(today, 120) })}`), []);
  const [f, setF] = useState({ scope: isOwner ? 'business' : 'staff', targetId: isOwner ? '' : me.staffId ?? '', date: today, endDate: today, allDay: false, start: '13:00', end: '18:00', reason: '' });
  const [err, setErr] = useState<unknown>(null);
  const [warn, setWarn] = useState<any[] | null>(null);
  return (
    <div>
      <h1>休み・ブロック</h1>
      <p className="small muted">スタッフの休み・半休、リソースの休止、全体の受付停止を登録します。<strong>既存の予約は自動でキャンセルされません</strong>（重なる予約は警告表示します）。</p>
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          setWarn(null);
          const s = localToIso(f.date, f.allDay ? '00:00' : f.start, tz);
          const en = f.allDay ? localToIso(addDays(f.endDate, 1), '00:00', tz) : localToIso(f.endDate, f.end, tz);
          try {
            const r = await post('/api/admin/blocks', { scope: f.scope, targetId: f.scope === 'business' ? null : f.targetId, start: s, end: en, reason: f.reason });
            setWarn(r.overlappingBookings);
            toast('登録しました');
            list.reload();
          } catch (x) {
            setErr(x);
          }
        }}
      >
        <div className="grid-2">
          <Field label="対象">
            {(p) => (
              <select {...p} value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value, targetId: '' })} disabled={!isOwner}>
                {isOwner && <option value="business">事業全体（受付停止）</option>}
                <option value="staff">スタッフ</option>
                {isOwner && <option value="resource">リソース（部屋・設備の休止）</option>}
              </select>
            )}
          </Field>
          {f.scope !== 'business' && (
            <Field label={f.scope === 'staff' ? 'スタッフ' : 'リソース'} required>
              {(p) => (
                <select {...p} value={f.targetId} onChange={(e) => setF({ ...f, targetId: e.target.value })} disabled={!isOwner}>
                  <option value="">選択</option>
                  {(f.scope === 'staff' ? staff.data?.staff ?? [] : resources.data?.resources ?? []).filter((x: any) => !x.archived).map((x: any) => <option key={x.id} value={x.id}>{x.displayName ?? x.name}</option>)}
                </select>
              )}
            </Field>
          )}
        </div>
        <label className="check"><input type="checkbox" checked={f.allDay} onChange={(e) => setF({ ...f, allDay: e.target.checked })} /><span>終日（期間指定）</span></label>
        <div className="grid-2">
          <div className="row">
            <input type="date" aria-label="開始日" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value, endDate: e.target.value > f.endDate ? e.target.value : f.endDate })} style={{ width: 170 }} />
            {!f.allDay && <input type="time" aria-label="開始時刻" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} style={{ width: 120 }} />}
          </div>
          <div className="row">
            〜 <input type="date" aria-label="終了日" value={f.endDate} min={f.date} onChange={(e) => setF({ ...f, endDate: e.target.value })} style={{ width: 170 }} />
            {!f.allDay && <input type="time" aria-label="終了時刻" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} style={{ width: 120 }} />}
          </div>
        </div>
        <Field label="理由（任意）">{(p) => <input {...p} type="text" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="例: 半休、機材メンテナンス" />}</Field>
        <ErrorAlert error={err} />
        <button className="btn-primary">登録</button>
        {warn && warn.length > 0 && (
          <div className="alert alert-warn" style={{ marginTop: 12 }}>
            この時間に既存の予約が {warn.length} 件あります（キャンセルされていません。必要なら個別に変更・キャンセルしてください）:
            <ul>{warn.map((b) => <li key={b.id}><a href={`/app/bookings/${b.id}`}>{fmtShortDateTime(b.start, tz)} {b.customerName} 様</a></li>)}</ul>
          </div>
        )}
      </form>
      <h2>今後のブロック</h2>
      {list.data?.blocks.length === 0 && <p className="muted">ありません。</p>}
      <table className="table">
        <tbody>
          {list.data?.blocks.map((b) => (
            <tr key={b.id}>
              <td className="nowrap">{fmtShortDateTime(b.start, tz)}〜{fmtShortDateTime(b.end, tz)}</td>
              <td>{b.scope === 'business' ? '全体' : b.targetName}</td>
              <td>{b.reason}</td>
              <td>{(isOwner || b.targetId === me.staffId) && <button className="btn-sm" onClick={async () => { await del(`/api/admin/blocks/${b.id}`); list.reload(); }}>削除</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ questions
export function QuestionsPage() {
  const { data, error, loading, reload } = useLoad<any>(async () => ({ ...(await get('/api/admin/questions')), ...(await get('/api/admin/services')) }), []);
  const [edit, setEdit] = useState<any | null>(null);
  if (loading && !data) return <Loading />;
  return (
    <div>
      <div className="row"><h1 style={{ margin: 0 }}>事前質問</h1><span className="spacer" /><button className="btn-primary" onClick={() => setEdit({ type: 'short_text', options: [] })}>＋ 質問を追加</button></div>
      <ErrorAlert error={error} />
      <div className="alert alert-info small">予約時点の質問文・選択肢は予約ごとに保存されるため、後で質問を編集しても過去の回答の意味は変わりません。<strong>医療問診や必要以上の個人情報（病歴・マイナンバー等）の収集には使わないでください。</strong></div>
      <table className="table">
        <thead><tr><th>質問</th><th>形式</th><th>対象</th><th>必須</th><th /></tr></thead>
        <tbody>
          {data?.questions.map((q: any) => (
            <tr key={q.id} style={{ opacity: q.archived ? 0.5 : 1 }}>
              <td><button className="btn-ghost" style={{ padding: 0, minHeight: 0, textAlign: 'left' }} onClick={() => setEdit(q)}>{q.label}</button></td>
              <td>{QUESTION_TYPE_LABEL[q.type]}</td>
              <td className="small">{q.serviceId ? data.services.find((s: any) => s.id === q.serviceId)?.name : '全サービス'}</td>
              <td>{q.required ? '必須' : '任意'}</td>
              <td><ArchiveButton path={`/api/admin/questions/${q.id}`} archived={q.archived} onDone={reload} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && <QuestionForm q={edit} services={data.services} onClose={() => setEdit(null)} onSaved={reload} />}
    </div>
  );
}

function QuestionForm({ q, services, onClose, onSaved }: { q: any; services: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ serviceId: q.serviceId ?? '', type: q.type, label: q.label ?? '', helpText: q.helpText ?? '', required: q.required ?? false, options: (q.options ?? []) as Array<{ id?: string; label: string }>, sortOrder: String(q.sortOrder ?? 0) });
  const [err, setErr] = useState<unknown>(null);
  const hasOptions = f.type === 'single_choice' || f.type === 'multi_choice';
  return (
    <Modal title={q.id ? '質問を編集' : '質問を追加'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const body = { ...f, serviceId: f.serviceId || null, sortOrder: num(f.sortOrder), options: hasOptions ? f.options.filter((o) => o.label.trim()) : [] };
          try {
            if (q.id) await put(`/api/admin/questions/${q.id}`, body);
            else await post('/api/admin/questions', body);
            onClose();
            onSaved();
          } catch (x) {
            setErr(x);
          }
        }}
      >
        <Field label="質問文" required>{(p) => <input {...p} type="text" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />}</Field>
        <div className="grid-2">
          <Field label="形式">
            {(p) => (
              <select {...p} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, options: f.options.length ? f.options : [{ label: '' }, { label: '' }] })}>
                {Object.entries(QUESTION_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            )}
          </Field>
          <Field label="対象サービス">
            {(p) => (
              <select {...p} value={f.serviceId} onChange={(e) => setF({ ...f, serviceId: e.target.value })}>
                <option value="">全サービス</option>
                {services.filter((s) => !s.archived).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
          </Field>
        </div>
        <Field label="補足説明（任意）">{(p) => <input {...p} type="text" value={f.helpText} onChange={(e) => setF({ ...f, helpText: e.target.value })} />}</Field>
        {hasOptions && (
          <fieldset style={{ border: 0, padding: 0 }}>
            <legend className="label">選択肢</legend>
            {f.options.map((o, i) => (
              <div key={i} className="row" style={{ marginBottom: 6 }}>
                <input type="text" aria-label={`選択肢${i + 1}`} value={o.label} onChange={(e) => setF({ ...f, options: f.options.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} style={{ flex: 1 }} />
                <button type="button" className="btn-sm" onClick={() => setF({ ...f, options: f.options.filter((_, j) => j !== i) })}>削除</button>
              </div>
            ))}
            <button type="button" className="btn-sm" onClick={() => setF({ ...f, options: [...f.options, { label: '' }] })}>＋選択肢</button>
          </fieldset>
        )}
        <label className="check"><input type="checkbox" checked={f.required} onChange={(e) => setF({ ...f, required: e.target.checked })} /><span>必須にする</span></label>
        <Field label="表示順">{(p) => <input {...p} type="number" value={f.sortOrder} onChange={(e) => setF({ ...f, sortOrder: e.target.value })} style={{ width: 120 }} />}</Field>
        <ErrorAlert error={err} />
        <div className="btn-row"><button type="button" onClick={onClose}>やめる</button><button className="btn-primary">保存</button></div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ recurring sessions
export function SessionsPage() {
  const { tz } = useSession();
  const today = todayIn(tz);
  const toast = useToast();
  const rules = useLoad<any>(async () => ({ ...(await get('/api/admin/recurrences')), ...(await get('/api/admin/services')), ...(await get('/api/admin/staff')) }), []);
  const occs = useLoad<any>(() => get(`/api/admin/calendar${qs({ from: today, to: addDays(today, 42) })}`), []);
  const [edit, setEdit] = useState<any | null>(null);
  const [occEdit, setOccEdit] = useState<any | null>(null);
  const [cancelOcc, setCancelOcc] = useState<any | null>(null);
  const sessionServices = (rules.data?.services ?? []).filter((s: any) => s.bookingMode === 'sessions' && !s.archived);
  return (
    <div>
      <div className="row"><h1 style={{ margin: 0 }}>繰り返し開催枠</h1><span className="spacer" /><button className="btn-primary" disabled={!sessionServices.length} onClick={() => setEdit({ freq: 'weekly', weekdays: [], startTimeMin: 18 * 60, startDate: today, intervalN: 1 })}>＋ ルールを追加</button></div>
      {!sessionServices.length && <div className="alert alert-info">まず「サービス」で予約の取り方を「開催日程から選ぶ」にしたサービスを作成してください。</div>}
      <p className="small muted">毎週・隔週・毎月第n曜日・毎月n日に対応。ルールを変更しても、過去の回・予約が入っている回・個別に変更した回は変わりません。開催回は予約可能期間（事業者設定）の先まで自動生成されます。</p>
      <ErrorAlert error={rules.error} />
      <table className="table">
        <thead><tr><th>サービス</th><th>ルール</th><th>担当</th><th>今後の回</th><th /></tr></thead>
        <tbody>
          {rules.data?.rules.map((r: any) => (
            <tr key={r.id} style={{ opacity: r.active ? 1 : 0.5 }}>
              <td>{r.serviceName}</td>
              <td>{ruleLabel(r)} {minToTime(r.startTimeMin)}〜{r.endDate ? `（${dateLabel(r.endDate)}まで）` : ''}</td>
              <td>{r.staffName ?? '—'}</td>
              <td>{r.upcoming}回</td>
              <td><button className="btn-sm" onClick={() => setEdit(r)}>編集</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2 style={{ marginTop: 16 }}>今後6週間の開催回</h2>
      <table className="table">
        <thead><tr><th>日時</th><th>サービス</th><th>予約/定員</th><th>状態</th><th /></tr></thead>
        <tbody>
          {occs.data?.occurrences.map((o: any) => (
            <tr key={o.id}>
              <td className="nowrap">{fmtShortDateTime(o.start, tz)}</td>
              <td>{o.serviceName}{o.note && <div className="small muted">{o.note}</div>}</td>
              <td>{o.booked}/{o.capacity}名</td>
              <td>{o.status === 'cancelled' ? '休止' : '開催予定'}</td>
              <td className="btn-row">{o.status === 'scheduled' && (<><button className="btn-sm" onClick={() => setOccEdit(o)}>個別変更</button><button className="btn-sm" onClick={() => setCancelOcc(o)}>休止</button></>)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && <RuleForm rule={edit} services={sessionServices} staff={rules.data.staff} onClose={() => setEdit(null)} onSaved={(msg) => { toast(msg); rules.reload(); occs.reload(); }} />}
      {occEdit && <OccurrenceForm occ={occEdit} onClose={() => setOccEdit(null)} onSaved={() => { occs.reload(); toast('開催回を変更しました'); }} />}
      {cancelOcc && (
        <Confirm
          title="この回を休止"
          message={<p>{fmtShortDateTime(cancelOcc.start, tz)}「{cancelOcc.serviceName}」を休止します。{cancelOcc.booked > 0 && <strong>予約が {cancelOcc.booked} 名分あります。休止すると予約は事業者キャンセルになり、お客様に通知されます。</strong>}</p>}
          confirmLabel="休止する"
          danger
          onClose={() => setCancelOcc(null)}
          onConfirm={async () => { await post(`/api/admin/occurrences/${cancelOcc.id}/cancel`, { cancelBookings: cancelOcc.booked > 0, reason: '開催中止' }); occs.reload(); }}
        />
      )}
    </div>
  );
}

function ruleLabel(r: any): string {
  if (r.freq === 'weekly') return `${r.intervalN > 1 ? `${r.intervalN}週ごと` : '毎週'} ${r.weekdays.map((w: number) => WEEKDAYS[w]).join('・')}曜`;
  if (r.freq === 'monthly_day') return `毎月${r.monthDay}日`;
  return `毎月第${r.nth === -1 ? '最終' : r.nth}${WEEKDAYS[r.weekdays[0]]}曜`;
}

function RuleForm({ rule, services, staff, onClose, onSaved }: { rule: any; services: any[]; staff: any[]; onClose: () => void; onSaved: (msg: string) => void }) {
  const [f, setF] = useState({ serviceId: rule.serviceId ?? services[0]?.id ?? '', staffId: rule.staffId ?? '', freq: rule.freq, intervalN: String(rule.intervalN ?? 1), weekdays: (rule.weekdays ?? []) as number[], nth: String(rule.nth ?? 1), monthDay: String(rule.monthDay ?? 1), time: minToTime(rule.startTimeMin ?? 1080), startDate: rule.startDate, endDate: rule.endDate ?? '', capacity: rule.capacity ? String(rule.capacity) : '', active: rule.active ?? true });
  const [err, setErr] = useState<unknown>(null);
  return (
    <Modal title={rule.id ? 'ルールを編集' : '繰り返しルールを追加'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const body = { serviceId: f.serviceId, staffId: f.staffId || null, freq: f.freq, intervalN: num(f.intervalN, 1), weekdays: f.freq === 'monthly_day' ? [] : f.weekdays, nth: f.freq === 'monthly_nth_weekday' ? num(f.nth, 1) : null, monthDay: f.freq === 'monthly_day' ? num(f.monthDay, 1) : null, startTimeMin: timeToMin(f.time), startDate: f.startDate, endDate: f.endDate || null, capacity: f.capacity ? num(f.capacity) : null, active: f.active };
          try {
            const r = rule.id ? await put(`/api/admin/recurrences/${rule.id}`, body) : await post('/api/admin/recurrences', body);
            const skipped = r.result.skipped.length ? `（${r.result.skipped.length}回は休業日・重複のため作成せず）` : '';
            onSaved(rule.id ? `更新しました。${r.removed}回を作り直し、${r.kept}回（予約あり・個別変更）はそのまま${skipped}` : `${r.result.created}回を作成しました${skipped}`);
            onClose();
          } catch (x) {
            setErr(x);
          }
        }}
      >
        <Field label="サービス">{(p) => <select {...p} value={f.serviceId} disabled={!!rule.id} onChange={(e) => setF({ ...f, serviceId: e.target.value })}>{services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}</Field>
        <Field label="担当スタッフ">{(p) => <select {...p} value={f.staffId} onChange={(e) => setF({ ...f, staffId: e.target.value })}><option value="">なし</option>{staff.filter((s) => !s.archived).map((s) => <option key={s.id} value={s.id}>{s.displayName}</option>)}</select>}</Field>
        <Field label="繰り返し">
          {(p) => (
            <select {...p} value={f.freq} onChange={(e) => setF({ ...f, freq: e.target.value, weekdays: e.target.value === 'monthly_nth_weekday' ? f.weekdays.slice(0, 1) : f.weekdays })}>
              <option value="weekly">毎週（◯週ごと）</option>
              <option value="monthly_nth_weekday">毎月 第n◯曜日</option>
              <option value="monthly_day">毎月 ◯日</option>
            </select>
          )}
        </Field>
        {f.freq !== 'monthly_day' && (
          <fieldset style={{ border: 0, padding: 0 }}>
            <legend className="label">曜日{f.freq === 'monthly_nth_weekday' ? '（1つ）' : ''}</legend>
            <div className="row">
              {WEEKDAYS.map((w, i) => (
                <label key={i} className="check" style={{ minHeight: 0 }}>
                  <input type={f.freq === 'weekly' ? 'checkbox' : 'radio'} name="wd" checked={f.weekdays.includes(i)} onChange={() => setF({ ...f, weekdays: f.freq === 'weekly' ? (f.weekdays.includes(i) ? f.weekdays.filter((x) => x !== i) : [...f.weekdays, i]) : [i] })} />
                  <span>{w}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <div className="grid-3">
          {f.freq === 'weekly' && <Field label="◯週ごと">{(p) => <input {...p} type="number" min={1} max={12} value={f.intervalN} onChange={(e) => setF({ ...f, intervalN: e.target.value })} />}</Field>}
          {f.freq === 'monthly_nth_weekday' && <Field label="第n">{(p) => <select {...p} value={f.nth} onChange={(e) => setF({ ...f, nth: e.target.value })}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>第{n}</option>)}<option value={-1}>最終</option></select>}</Field>}
          {f.freq === 'monthly_day' && <Field label="日">{(p) => <input {...p} type="number" min={1} max={31} value={f.monthDay} onChange={(e) => setF({ ...f, monthDay: e.target.value })} />}</Field>}
          <Field label="開始時刻">{(p) => <input {...p} type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} />}</Field>
          <Field label="定員（空欄=サービス設定）">{(p) => <input {...p} type="number" min={1} value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} />}</Field>
        </div>
        <div className="grid-2">
          <Field label="開始日">{(p) => <input {...p} type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />}</Field>
          <Field label="終了日（任意）">{(p) => <input {...p} type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />}</Field>
        </div>
        {rule.id && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /><span>このルールを有効にする</span></label>}
        <ErrorAlert error={err} />
        <div className="btn-row"><button type="button" onClick={onClose}>やめる</button><button className="btn-primary">保存</button></div>
      </form>
    </Modal>
  );
}

function OccurrenceForm({ occ, onClose, onSaved }: { occ: any; onClose: () => void; onSaved: () => void }) {
  const [capacity, setCapacity] = useState(String(occ.capacity));
  const [note, setNote] = useState(occ.note ?? '');
  const [err, setErr] = useState<unknown>(null);
  return (
    <Modal title="開催回を個別に変更" onClose={onClose}>
      <form onSubmit={async (e) => { e.preventDefault(); try { await put(`/api/admin/occurrences/${occ.id}`, { capacity: num(capacity, 1), note }); onClose(); onSaved(); } catch (x) { setErr(x); } }}>
        <Field label="定員" hint={`予約済み ${occ.booked}名`}>{(p) => <input {...p} type="number" min={Math.max(1, occ.booked)} value={capacity} onChange={(e) => setCapacity(e.target.value)} />}</Field>
        <Field label="メモ（予約ページには表示されません）">{(p) => <input {...p} type="text" value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        <ErrorAlert error={err} />
        <div className="btn-row"><button type="button" onClick={onClose}>やめる</button><button className="btn-primary">保存</button></div>
      </form>
    </Modal>
  );
}

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { get, post, setCsrf } from '../api';
import { ErrorAlert, Field, Loading, useOnline } from '../components/ui';

export interface Me {
  user: { id: string; name: string; email: string };
  csrfToken: string;
  role: 'owner' | 'staff' | null;
  staffId: string | null;
  permissions: { viewAllBookings: boolean; manageBookings: boolean; viewCustomers: boolean; manageOwnBlocks: boolean };
  business: { id: string; name: string; brand_name: string | null; slug: string; timezone: string; theme_color: string; published: boolean; is_sample: boolean; week_start: number } | null;
  businesses: Array<{ id: string; name: string; slug: string; role: string }>;
}

interface Ctx {
  me: Me;
  reload: () => Promise<void>;
  tz: string;
  isOwner: boolean;
}
const SessionCtx = createContext<Ctx | null>(null);
export function useSession(): Ctx {
  const c = useContext(SessionCtx);
  if (!c) throw new Error('no session');
  return c;
}

export function RequireAuth() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const loc = useLocation();
  const load = async () => {
    try {
      const m = await get<Me>('/api/auth/me');
      if (m.user) setCsrf(m.csrfToken);
      setMe(m.user ? m : null);
    } catch {
      setMe(null);
    }
  };
  useEffect(() => {
    load();
  }, []);
  if (me === undefined) return <div className="content"><Loading /></div>;
  if (me === null) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  if (!me.business)
    return (
      <div className="content">
        <p>所属している事業者がありません。オーナーに招待を依頼してください。</p>
        <LogoutButton />
      </div>
    );
  return (
    <SessionCtx.Provider value={{ me, reload: load, tz: me.business.timezone, isOwner: me.role === 'owner' }}>
      <Shell />
    </SessionCtx.Provider>
  );
}

function LogoutButton() {
  return (
    <button
      onClick={async () => {
        await post('/api/auth/logout').catch(() => {});
        // clear the limited offline cache of admin data
        if ('caches' in window) await caches.delete('rf-admin-data').catch(() => {});
        localStorage.removeItem('rf-drafts');
        window.location.href = '/login';
      }}
    >
      ログアウト
    </button>
  );
}

const NAV: Array<{ to: string; label: string; ic: string; owner?: boolean; perm?: keyof Me['permissions'] }> = [
  { to: '/app', label: 'ダッシュボード', ic: '⌂' },
  { to: '/app/today', label: '今日の受付', ic: '☑' },
  { to: '/app/calendar', label: 'カレンダー', ic: '▦' },
  { to: '/app/bookings', label: '予約一覧', ic: '≡' },
  { to: '/app/new', label: '新規予約・空き検索', ic: '＋' },
  { to: '/app/customers', label: '顧客', ic: '☺', perm: 'viewCustomers' },
  { to: '/app/waitlist', label: '待機リスト', ic: '⧗', perm: 'viewCustomers' },
  { to: '/app/blocks', label: '休み・ブロック', ic: '⊘' },
];
const NAV_SETUP: Array<{ to: string; label: string; ic: string }> = [
  { to: '/app/services', label: 'サービス', ic: '◇' },
  { to: '/app/staff', label: 'スタッフ', ic: '♙' },
  { to: '/app/resources', label: 'リソース（部屋・設備）', ic: '▣' },
  { to: '/app/hours', label: '営業時間・休業日', ic: '◷' },
  { to: '/app/questions', label: '事前質問', ic: '?' },
  { to: '/app/sessions', label: '繰り返し開催枠', ic: '↻' },
  { to: '/app/analytics', label: '分析', ic: '▤' },
  { to: '/app/data', label: 'CSV・バックアップ', ic: '⇩' },
  { to: '/app/notifications', label: '通知履歴', ic: '✉' },
  { to: '/app/audit', label: '操作ログ', ic: '⎙' },
  { to: '/app/members', label: 'ログインユーザー', ic: '⚿' },
  { to: '/app/settings', label: '事業者設定・公開', ic: '⚙' },
];

function Shell() {
  const { me, isOwner } = useSession();
  const online = useOnline();
  const biz = me.business!;
  const navItems = NAV.filter((n) => isOwner || !n.perm || me.permissions[n.perm]);
  return (
    <div className="shell">
      <a href="#content" className="skip-link">本文へ移動</a>
      <aside className="sidebar" aria-label="メインメニュー">
        <Link to="/app" className="brand">ReserveFlow</Link>
        <nav>
          {navItems.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/app'}>
              <span aria-hidden="true">{n.ic}</span>
              {n.label}
            </NavLink>
          ))}
          {isOwner && <div className="sep" />}
          {isOwner &&
            NAV_SETUP.map((n) => (
              <NavLink key={n.to} to={n.to}>
                <span aria-hidden="true">{n.ic}</span>
                {n.label}
              </NavLink>
            ))}
          <div className="sep" />
          <NavLink to="/app/account"><span aria-hidden="true">☼</span>アカウント</NavLink>
        </nav>
      </aside>
      <div className="main">
        {!online && <div className="offline-banner" role="status">オフラインです。表示は最後に取得した内容です。予約の確定・変更・キャンセルは接続後に行ってください。</div>}
        {biz.is_sample && <div className="sample-banner">これはサンプル事業者（Sample Studio）です。メールは送信されません。本番用には新しい事業者を作成してください。</div>}
        <header className="topbar">
          <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{biz.brand_name || biz.name}</strong>
          <span className="spacer" />
          {biz.published ? (
            <a className="btn btn-sm hide-mobile" href={`/book/${biz.slug}`} target="_blank" rel="noopener">予約ページを開く</a>
          ) : (
            isOwner && <Link className="btn btn-sm" to="/app/settings">未公開 → 公開設定</Link>
          )}
          <span className="small muted hide-mobile">{me.user.name}（{me.role === 'owner' ? 'オーナー' : 'スタッフ'}）</span>
          <span className="hide-mobile"><LogoutButton /></span>
        </header>
        <main id="content" className="content">
          <Outlet />
        </main>
      </div>
      <nav className="bottom-nav" aria-label="メインメニュー（スマホ）">
        <NavLink to="/app" end><span className="ic" aria-hidden="true">⌂</span>ホーム</NavLink>
        <NavLink to="/app/today"><span className="ic" aria-hidden="true">☑</span>受付</NavLink>
        <NavLink to="/app/new"><span className="ic" aria-hidden="true">＋</span>新規</NavLink>
        <NavLink to="/app/calendar"><span className="ic" aria-hidden="true">▦</span>予定</NavLink>
        <NavLink to="/app/menu"><span className="ic" aria-hidden="true">☰</span>メニュー</NavLink>
      </nav>
    </div>
  );
}

export function MobileMenu() {
  const { me, isOwner } = useSession();
  const items = [...NAV.filter((n) => isOwner || !n.perm || me.permissions[n.perm]), ...(isOwner ? NAV_SETUP : []), { to: '/app/account', label: 'アカウント', ic: '☼' }];
  return (
    <div>
      <h1>メニュー</h1>
      <div className="menu-grid">
        {items.map((n) => (
          <Link key={n.to} to={n.to}>
            <span aria-hidden="true">{n.ic}</span>
            {n.label}
          </Link>
        ))}
      </div>
      {me.business?.published && (
        <p style={{ marginTop: 16 }}>
          <a className="btn btn-block" href={`/book/${me.business.slug}`} target="_blank" rel="noopener">予約ページを開く</a>
        </p>
      )}
      <p style={{ marginTop: 16 }}><LogoutButton /></p>
    </div>
  );
}

function AuthFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="pub" style={{ maxWidth: 440 }}>
      <header className="pub-header"><strong>ReserveFlow</strong><span className="small muted">予約・受付管理</span></header>
      <main className="pub-body">
        <h1>{title}</h1>
        {children}
      </main>
    </div>
  );
}

export function LoginPage() {
  const nav = useNavigate();
  const [f, setF] = useState({ email: '', password: '' });
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [allowSignup, setAllowSignup] = useState(false);
  useEffect(() => {
    get('/api/auth/config').then((c) => setAllowSignup(c.allowSignup)).catch(() => {});
  }, []);
  return (
    <AuthFrame title="ログイン">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            await post('/api/auth/login', f);
            const next = new URLSearchParams(window.location.search).get('next');
            nav(next && next.startsWith('/app') ? next : '/app');
          } catch (x) {
            setErr(x);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="メールアドレス">{(p) => <input {...p} type="email" autoComplete="username" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />}</Field>
        <Field label="パスワード">{(p) => <input {...p} type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />}</Field>
        <ErrorAlert error={err} />
        <button className="btn-primary btn-block" disabled={busy}>{busy ? 'ログイン中…' : 'ログイン'}</button>
      </form>
      {allowSignup && <p style={{ marginTop: 16 }}>はじめての方は <Link to="/signup">事業者を登録</Link></p>}
    </AuthFrame>
  );
}

export function SignupPage() {
  const nav = useNavigate();
  const [f, setF] = useState({ name: '', email: '', password: '', businessName: '', slug: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tokyo' });
  const [err, setErr] = useState<any>(null);
  const fe = (k: string) => err?.fieldErrors?.[k];
  return (
    <AuthFrame title="事業者を登録">
      <form
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          try {
            await post('/api/auth/signup', f);
            nav('/app/settings?welcome=1');
          } catch (x) {
            setErr(x);
          }
        }}
      >
        <Field label="お名前" required error={fe('name')}>{(p) => <input {...p} type="text" autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="メールアドレス（ログインID）" required error={fe('email')}>{(p) => <input {...p} type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
        <Field label="パスワード" required hint="10文字以上" error={fe('password')}>{(p) => <input {...p} type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />}</Field>
        <Field label="事業者名（店名）" required error={fe('businessName')}>{(p) => <input {...p} type="text" value={f.businessName} onChange={(e) => setF({ ...f, businessName: e.target.value })} />}</Field>
        <Field label="予約ページのURL名" required hint={`半角英小文字・数字・ハイフン。予約ページは /book/${f.slug || 'your-shop'} になります`} error={fe('slug')}>
          {(p) => <input {...p} type="text" autoCapitalize="none" value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase() })} />}
        </Field>
        <Field label="タイムゾーン" hint="予約時刻はこのタイムゾーンで表示・計算されます" error={fe('timezone')}>{(p) => <input {...p} type="text" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} />}</Field>
        <ErrorAlert error={err} />
        <button className="btn-primary btn-block">登録する</button>
      </form>
      <p style={{ marginTop: 16 }}><Link to="/login">ログインへ戻る</Link></p>
    </AuthFrame>
  );
}

export function InvitePage() {
  const nav = useNavigate();
  const [token] = useState(() => {
    const m = window.location.hash.match(/t=([A-Za-z0-9_-]{20,100})/);
    if (m) history.replaceState(null, '', '/invite');
    return m?.[1] ?? '';
  });
  const [info, setInfo] = useState<{ email: string; businessName: string; existingUser: boolean } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [f, setF] = useState({ name: '', password: '' });
  useEffect(() => {
    if (token) post('/api/auth/invite/info', { token }).then(setInfo).catch(setErr);
  }, [token]);
  if (!token) return <AuthFrame title="招待リンクが無効です"><p>オーナーに招待の再発行を依頼してください。</p></AuthFrame>;
  return (
    <AuthFrame title="招待を受ける">
      <ErrorAlert error={err} />
      {info && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            try {
              await post('/api/auth/invite/accept', { token, ...f });
              nav('/app');
            } catch (x) {
              setErr(x);
            }
          }}
        >
          <p><strong>{info.businessName}</strong> の管理画面に招待されています（{info.email}）。</p>
          <Field label="お名前" required>{(p) => <input {...p} type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
          <Field label={info.existingUser ? '既存アカウントのパスワード' : 'パスワードを設定（10文字以上）'} required>
            {(p) => <input {...p} type="password" autoComplete={info.existingUser ? 'current-password' : 'new-password'} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />}
          </Field>
          <button className="btn-primary btn-block">参加する</button>
        </form>
      )}
    </AuthFrame>
  );
}

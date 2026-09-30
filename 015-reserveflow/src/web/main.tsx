import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';
import { Loading, ToastProvider } from './components/ui';
import { InvitePage, LoginPage, MobileMenu, RequireAuth, SignupPage } from './admin/session';

const BookingPage = lazy(() => import('./public/BookingPage'));
const ManagePage = lazy(() => import('./public/ManagePage'));
const Admin = {
  Dashboard: lazy(() => import('./admin/Dashboard').then((m) => ({ default: m.Dashboard }))),
  Today: lazy(() => import('./admin/Dashboard').then((m) => ({ default: m.TodayPage }))),
  Calendar: lazy(() => import('./admin/Calendar').then((m) => ({ default: m.CalendarPage }))),
  Bookings: lazy(() => import('./admin/Bookings').then((m) => ({ default: m.BookingsList }))),
  BookingDetail: lazy(() => import('./admin/Bookings').then((m) => ({ default: m.BookingDetail }))),
  NewBooking: lazy(() => import('./admin/Bookings').then((m) => ({ default: m.NewBooking }))),
  Customers: lazy(() => import('./admin/Customers').then((m) => ({ default: m.CustomersList }))),
  CustomerDetail: lazy(() => import('./admin/Customers').then((m) => ({ default: m.CustomerDetail }))),
  Waitlist: lazy(() => import('./admin/Customers').then((m) => ({ default: m.WaitlistPage }))),
  Services: lazy(() => import('./admin/Setup').then((m) => ({ default: m.ServicesPage }))),
  Staff: lazy(() => import('./admin/Setup').then((m) => ({ default: m.StaffPage }))),
  Resources: lazy(() => import('./admin/Setup').then((m) => ({ default: m.ResourcesPage }))),
  Hours: lazy(() => import('./admin/Setup').then((m) => ({ default: m.HoursPage }))),
  Blocks: lazy(() => import('./admin/Setup').then((m) => ({ default: m.BlocksPage }))),
  Questions: lazy(() => import('./admin/Setup').then((m) => ({ default: m.QuestionsPage }))),
  Sessions: lazy(() => import('./admin/Setup').then((m) => ({ default: m.SessionsPage }))),
  Analytics: lazy(() => import('./admin/Data').then((m) => ({ default: m.AnalyticsPage }))),
  Data: lazy(() => import('./admin/Data').then((m) => ({ default: m.DataPage }))),
  Notifications: lazy(() => import('./admin/Data').then((m) => ({ default: m.NotificationsPage }))),
  Audit: lazy(() => import('./admin/Data').then((m) => ({ default: m.AuditPage }))),
  Members: lazy(() => import('./admin/Data').then((m) => ({ default: m.MembersPage }))),
  Settings: lazy(() => import('./admin/Data').then((m) => ({ default: m.SettingsPage }))),
  Account: lazy(() => import('./admin/Data').then((m) => ({ default: m.AccountPage }))),
};

function Home() {
  return (
    <div className="pub" style={{ maxWidth: 520 }}>
      <main className="pub-body">
        <h1>ReserveFlow</h1>
        <p>予約・顧客・受付・リマインド管理。お客様の予約ページは、お店から案内されたURL（/book/…）から開いてください。</p>
        <Link className="btn btn-primary" to="/login">事業者ログイン</Link>
      </main>
    </div>
  );
}

function NotFound() {
  return (
    <div className="pub"><main className="pub-body"><h1>ページが見つかりません</h1><Link to="/">トップへ</Link></main></div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <BrowserRouter>
        <Suspense fallback={<div className="content"><Loading /></div>}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/book/:slug" element={<BookingPage />} />
            <Route path="/manage" element={<ManagePage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/invite" element={<InvitePage />} />
            <Route path="/app" element={<RequireAuth />}>
              <Route index element={<Admin.Dashboard />} />
              <Route path="today" element={<Admin.Today />} />
              <Route path="calendar" element={<Admin.Calendar />} />
              <Route path="bookings" element={<Admin.Bookings />} />
              <Route path="bookings/:id" element={<Admin.BookingDetail />} />
              <Route path="new" element={<Admin.NewBooking />} />
              <Route path="customers" element={<Admin.Customers />} />
              <Route path="customers/:id" element={<Admin.CustomerDetail />} />
              <Route path="waitlist" element={<Admin.Waitlist />} />
              <Route path="blocks" element={<Admin.Blocks />} />
              <Route path="services" element={<Admin.Services />} />
              <Route path="staff" element={<Admin.Staff />} />
              <Route path="resources" element={<Admin.Resources />} />
              <Route path="hours" element={<Admin.Hours />} />
              <Route path="questions" element={<Admin.Questions />} />
              <Route path="sessions" element={<Admin.Sessions />} />
              <Route path="analytics" element={<Admin.Analytics />} />
              <Route path="data" element={<Admin.Data />} />
              <Route path="notifications" element={<Admin.Notifications />} />
              <Route path="audit" element={<Admin.Audit />} />
              <Route path="members" element={<Admin.Members />} />
              <Route path="settings" element={<Admin.Settings />} />
              <Route path="account" element={<Admin.Account />} />
              <Route path="menu" element={<MobileMenu />} />
              <Route path="*" element={<Navigate to="/app" replace />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ToastProvider>
  </StrictMode>,
);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  });
}

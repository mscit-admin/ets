import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth.jsx';
import { useI18n } from './i18n/index.jsx';
import Layout from './components/Layout.jsx';
import { Loading, ToastHost } from './components/ui.jsx';
// Login (and ForcePasswordChange) stay eager: tiny and needed on the very first paint before auth resolves.
import Login, { ForcePasswordChange } from './pages/Login.jsx';
// Authenticated pages are code-split: each loads on first navigation, shrinking the initial bundle.
// Suspense fallback lives in Layout (around <Outlet/>), so the navbar/sidebar stay while a page loads.
import { lazy, useEffect, useState } from 'react';
import { RestoreMonitor, readWatch } from './components/RestoreWizard.jsx';

const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Department = lazy(() => import('./pages/Department.jsx'));
const Application = lazy(() => import('./pages/Application.jsx'));
const Weights = lazy(() => import('./pages/Weights.jsx'));
const Reports = lazy(() => import('./pages/Reports.jsx'));
const Schedule = lazy(() => import('./pages/Schedule.jsx'));
const ProjectStatus = lazy(() => import('./pages/ProjectStatus.jsx'));
const Search = lazy(() => import('./pages/Search.jsx'));
const UserList = lazy(() => import('./pages/Users.jsx').then(m => ({ default: m.UserList })));
const UserForm = lazy(() => import('./pages/Users.jsx').then(m => ({ default: m.UserForm })));
const Logs = lazy(() => import('./pages/Logs.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const Profile = lazy(() => import('./pages/Profile.jsx'));
const ImportList = lazy(() => import('./pages/Imports.jsx').then(m => ({ default: m.ImportList })));
const ImportDetail = lazy(() => import('./pages/Imports.jsx').then(m => ({ default: m.ImportDetail })));
const Approvals = lazy(() => import('./pages/Approvals.jsx'));
const Notifications = lazy(() => import('./pages/Notifications.jsx'));
const Messages = lazy(() => import('./pages/Messages.jsx'));

function Guard({ perm, children }) {
  const { can } = useAuth();
  return can(perm) ? children : <Navigate to="/" replace />;
}

export default function App() {
  const { me, ready } = useAuth();
  // Browser tab title follows the configured system name, same source and language rule the header uses
  // (me.org_name_*, surfaced by /auth/me): current-language name → the other language's → t('app_title').
  // Updates on initial load, on a Settings save (refresh() reloads me) and on a UI-language switch. Before
  // sign-in me carries no org name, so it stays the default — never a stale name. index.html keeps the same
  // default as its pre-hydration <title>.
  const { lang, t } = useI18n();
  useEffect(() => {
    const org = me?.authenticated ? me : null;
    const pick = lang === 'en'
      ? (org?.org_name_en || org?.org_name_ar)
      : (org?.org_name_ar || org?.org_name_en);
    document.title = (pick && pick.trim()) || t('app_title');
  }, [me, lang, t]);
  // a restore started from Settings → «النسخ الاحتياطي» (1.12.0): its progress replaces every page until it is dismissed
  const [watch, setWatch] = useState(readWatch);
  useEffect(() => { const f = () => setWatch(readWatch()); window.addEventListener('ets-restore-watch', f); return () => window.removeEventListener('ets-restore-watch', f); }, []);
  if (watch) return <RestoreMonitor watch={watch} />;
  if (!ready) return <div className="boot"><Loading /></div>;
  const signedIn = me.authenticated && me.stage === 'done';
  return (
    <BrowserRouter>
      <ToastHost />
      {!signedIn ? (
        <Routes><Route path="*" element={<Login />} /></Routes>
      ) : me.user.must_change_password ? (
        <Routes><Route path="*" element={<ForcePasswordChange />} /></Routes>
      ) : (
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="department/:id" element={<Department />} />
            <Route path="app/:id" element={<Application />} />
            <Route path="weights" element={<Weights />} />
            <Route path="reports" element={<Reports />} />
            <Route path="reports/:dept" element={<Reports />} />
            <Route path="schedule" element={<Schedule />} />
            <Route path="status" element={<ProjectStatus />} />
            <Route path="search" element={<Search />} />
            <Route path="imports" element={<ImportList />} />
            <Route path="approvals" element={<Approvals />} />
            <Route path="imports/:id" element={<ImportDetail />} />
            <Route path="users" element={<Guard perm="usr"><UserList /></Guard>} />
            <Route path="users/:id" element={<Guard perm="usr"><UserForm /></Guard>} />
            <Route path="online" element={<Navigate to="/users?tab=online" replace />} />
            <Route path="logs" element={<Guard perm="log"><Logs /></Guard>} />
            <Route path="settings" element={<Guard perm="cfg"><Settings /></Guard>} />
            <Route path="profile" element={<Profile />} />
            <Route path="notifications" element={<Notifications />} />
            <Route path="messages" element={<Messages />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      )}
    </BrowserRouter>
  );
}

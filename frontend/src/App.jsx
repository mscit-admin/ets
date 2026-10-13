import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth.jsx';
import Layout from './components/Layout.jsx';
import { Loading, ToastHost } from './components/ui.jsx';
import Login, { ForcePasswordChange } from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Department from './pages/Department.jsx';
import Application from './pages/Application.jsx';
import Weights from './pages/Weights.jsx';
import Reports from './pages/Reports.jsx';
import Schedule from './pages/Schedule.jsx';
import ProjectStatus from './pages/ProjectStatus.jsx';
import Search from './pages/Search.jsx';
import { UserForm, UserList } from './pages/Users.jsx';
import Logs from './pages/Logs.jsx';
import Settings from './pages/Settings.jsx';
import Profile from './pages/Profile.jsx';
import { ImportDetail, ImportList } from './pages/Imports.jsx';
import Approvals from './pages/Approvals.jsx';

function Guard({ perm, children }) {
  const { can } = useAuth();
  return can(perm) ? children : <Navigate to="/" replace />;
}

export default function App() {
  const { me, ready } = useAuth();
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
            <Route path="logs" element={<Guard perm="log"><Logs /></Guard>} />
            <Route path="settings" element={<Guard perm="cfg"><Settings /></Guard>} />
            <Route path="profile" element={<Profile />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      )}
    </BrowserRouter>
  );
}

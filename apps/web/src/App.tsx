import type { ReactNode } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { HOME, useAuth, type Role } from './lib/auth';
import { Login } from './pages/Login';
import { DispatchPlan } from './pages/dispatch/Plan';
import { DispatchReview } from './pages/dispatch/Review';
import { DispatchProgress } from './pages/dispatch/Progress';
import { DispatchOutlook } from './pages/dispatch/Outlook';
import { LoaderRuns, LoaderRun } from './pages/Loader';
import { DriverRun, DriverStop, DriverSaved } from './pages/Driver';
import { StoreOrders, StoreNewOrder, StoreOrder } from './pages/Store';

const NAV: Record<Role, { to: string; label: string }[]> = {
  dispatcher: [
    { to: '/dispatch', label: 'Daily plan' },
    { to: '/dispatch/review', label: 'Review & publish' },
    { to: '/dispatch/progress', label: 'Progress & exceptions' },
    { to: '/dispatch/outlook', label: 'Capacity outlook' },
  ],
  loader: [{ to: '/loader', label: 'Runs to load' }],
  driver: [
    { to: '/driver', label: "Today's run" },
    { to: '/driver/saved', label: 'Saved work' },
  ],
  store: [
    { to: '/store', label: 'My orders' },
    { to: '/store/new', label: 'Place an order' },
  ],
};
const ROLE_LABEL: Record<Role, string> = { dispatcher: 'Dispatcher', loader: 'Loader', driver: 'Driver', store: 'Store manager' };

function Shell({ role, children }: { role: Role; children: ReactNode }) {
  const { user, logout } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== role) return <Navigate to={HOME[user.role]} replace />;
  return (
    <>
      <header className="topbar">
        <NavLink to={HOME[role]} className="brand"><img src="/icon.svg" alt="" />Waypoint Relay</NavLink>
        <nav className="nav" aria-label="Main">
          {NAV[role].map((n) => <NavLink key={n.to} to={n.to} end>{n.label}</NavLink>)}
        </nav>
        <div className="who">
          <div><strong>{user.name}</strong> · {ROLE_LABEL[role]}</div>
          <div>{user.outlet_id ?? user.vehicle_id ?? user.depot}</div>
        </div>
        <button className="ghost" onClick={logout}>Sign out</button>
      </header>
      {children}
    </>
  );
}

export function App() {
  const { user } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/dispatch" element={<Shell role="dispatcher"><DispatchPlan /></Shell>} />
      <Route path="/dispatch/review" element={<Shell role="dispatcher"><DispatchReview /></Shell>} />
      <Route path="/dispatch/progress" element={<Shell role="dispatcher"><DispatchProgress /></Shell>} />
      <Route path="/dispatch/outlook" element={<Shell role="dispatcher"><DispatchOutlook /></Shell>} />
      <Route path="/loader" element={<Shell role="loader"><LoaderRuns /></Shell>} />
      <Route path="/loader/:vid/:trip" element={<Shell role="loader"><LoaderRun /></Shell>} />
      <Route path="/driver" element={<Shell role="driver"><DriverRun /></Shell>} />
      <Route path="/driver/stop/:orderId" element={<Shell role="driver"><DriverStop /></Shell>} />
      <Route path="/driver/saved" element={<Shell role="driver"><DriverSaved /></Shell>} />
      <Route path="/store" element={<Shell role="store"><StoreOrders /></Shell>} />
      <Route path="/store/new" element={<Shell role="store"><StoreNewOrder /></Shell>} />
      <Route path="/store/orders/:id" element={<Shell role="store"><StoreOrder /></Shell>} />
      <Route path="*" element={<Navigate to={user ? HOME[user.role] : '/login'} replace />} />
    </Routes>
  );
}

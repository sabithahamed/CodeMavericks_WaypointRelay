import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ErrorNote } from '../components/ui';
import { HOME, useAuth } from '../lib/auth';

const DEMO = [
  { email: 'dispatcher@waypoint.test', label: 'Dispatcher', note: 'Peliyagoda planning office' },
  { email: 'loader@waypoint.test', label: 'Loader', note: 'Peliyagoda dock' },
  { email: 'driver@waypoint.test', label: 'Driver', note: 'VEH036 · refrigerated van' },
  { email: 'store@waypoint.test', label: 'Store manager', note: 'OUT002 · Fresh, Colombo' },
];

export function Login() {
  const { user, login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (user) return <Navigate to={HOME[user.role]} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const u = await login(email, password);
      nav(HOME[u.role]);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page narrow field-ui" style={{ paddingTop: '8vh' }}>
      <div className="row" style={{ marginBottom: '1rem' }}>
        <img src="/icon.svg" alt="" width={40} height={40} />
        <div>
          <h1 style={{ margin: 0 }}>Waypoint Relay</h1>
          <p className="muted" style={{ margin: 0 }}>One delivery record from order to receipt.</p>
        </div>
      </div>
      <form className="card stack" onSubmit={submit}>
        <label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        <ErrorNote error={error} />
        <button className="primary block-btn" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <section className="card stack" style={{ marginTop: '1rem' }} aria-label="Seeded demo accounts">
        <div>
          <h2>Demo accounts</h2>
          <p className="muted small">Seeded for judges. Password for every account: <code>relay2026</code>. Choosing one fills the form.</p>
        </div>
        {DEMO.map((d) => (
          <button key={d.email} type="button" onClick={() => { setEmail(d.email); setPassword('relay2026'); }} style={{ justifyContent: 'space-between' }}>
            <span>{d.label}</span><span className="muted small">{d.note}</span>
          </button>
        ))}
      </section>
    </main>
  );
}

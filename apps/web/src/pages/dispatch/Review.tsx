import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Banner, Chip, ErrorNote, Loading } from '../../components/ui';
import { api } from '../../lib/api';

/** D2: consequences of the plan in terms of affected orders, before it reaches the other roles. */
export function DispatchReview() {
  const [r, setR] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  useEffect(() => { api('/dispatch/plan/review').then(setR).catch((e) => setError(e.message)); }, []);

  if (!r) return <main className="page">{error ? <><ErrorNote error={error} /><p><Link to="/dispatch">Back to the daily plan</Link></p></> : <Loading />}</main>;
  const published = r.status === 'published';
  const unavoidable = r.deferred.filter((d: any) => d.code !== 'dispatcher_choice');
  const chosen = r.deferred.filter((d: any) => d.code === 'dispatcher_choice');

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/dispatch/plan/publish', { body: { note: note || undefined } });
      nav('/dispatch/progress');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page stack" style={{ maxWidth: 1000 }}>
      <div className="row spread">
        <div>
          <h1>Review before publish · plan v{r.version}</h1>
          <p className="muted small">{r.previous_version ? `Compared with published v${r.previous_version}.` : 'First version for this day: every order is new.'}</p>
        </div>
        <Link to="/dispatch">← Back to daily plan</Link>
      </div>

      <div className="kpis">
        <div className="kpi"><div className="v">{r.summary.served}</div><div className="l">Orders served</div></div>
        <div className="kpi"><div className="v">{r.summary.deferred}</div><div className="l">Orders deferred</div></div>
        <div className="kpi"><div className="v">{r.repeatDeferrals.length}</div><div className="l">Deferred again after being skipped yesterday</div></div>
        <div className="kpi"><div className="v">{r.changes.length}</div><div className="l">Orders changed vs last version</div></div>
        <div className="kpi"><div className="v">{r.trips.length}</div><div className="l">Trips to load</div></div>
      </div>

      {r.violations.length > 0 && (
        <Banner tone="block" icon="✕"><strong>{r.violations.length} rule(s) broken.</strong> Return to the plan to fix: {r.violations.map((v: any) => v.message).join(' ')}</Banner>
      )}
      {r.repeatDeferrals.length > 0 && (
        <Banner tone="attention" icon="↺"><strong>Needs attention:</strong> {r.repeatDeferrals.map((d: any) => d.order_id).join(', ')} {r.repeatDeferrals.length === 1 ? 'was' : 'were'} skipped on the previous run and would be skipped again.</Banner>
      )}

      <section className="card">
        <h2>Deferred orders and why</h2>
        <p className="muted small">Stores see these reasons. A deferral is reviewed again at the next run; it is not a promised delivery date.</p>
        <table>
          <thead><tr><th>Order</th><th>Type</th><th>Reason</th></tr></thead>
          <tbody>
            {[...unavoidable, ...chosen].map((d: any) => (
              <tr key={d.order_id}>
                <td><strong>{d.order_id}</strong></td>
                <td>{d.code === 'exceeds_vehicle_capacity' ? <Chip tone="block" icon="✕">Needs order revision</Chip> : d.code === 'dispatcher_choice' ? <Chip tone="info" icon="✎">Dispatcher choice</Chip> : <Chip tone="attention" icon="⏸">Capacity shortage</Chip>}</td>
                <td className="small">{d.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {r.changes.length > 0 && r.previous_version && (
        <section className="card">
          <h2>What changes for the dock, drivers and stores</h2>
          <table>
            <thead><tr><th>Order</th><th>Outlet</th><th>Was</th><th>Becomes</th></tr></thead>
            <tbody>{r.changes.map((c: any) => <tr key={c.order_id}><td>{c.order_id}</td><td>{c.outlet_id}</td><td>{c.from}</td><td><strong>{c.to}</strong></td></tr>)}</tbody>
          </table>
          <p className="muted small">Changed trips return to “To load”; loaders must acknowledge the revised list and drivers see the new version when they next connect.</p>
        </section>
      )}

      <section className="card">
        <h2>What changes downstream</h2>
        <table className="small"><tbody>
          <tr><td><span className="avatar">L</span></td><td><strong>Loader</strong><div>v{r.version} loading lists replace any earlier list; {r.trips.length} trips to load, each acknowledged before release.</div></td></tr>
          <tr><td><span className="avatar">D</span></td><td><strong>Driver</strong><div>Sees the trip sequence and planned arrival times before starting; the run is saved to the phone for offline use.</div></td></tr>
          <tr><td><span className="avatar">S</span></td><td><strong>Store</strong><div>{r.summary.served} orders get an expected arrival; {r.summary.deferred} get the deferral reason shown above.</div></td></tr>
          <tr><td><span className="avatar">D</span></td><td><strong>Dispatch</strong><div>{r.deferred.filter((d: any) => d.code === 'exceeds_vehicle_capacity').map((d: any) => d.order_id).join(', ') || 'No order'} stays open for an order change.</div></td></tr>
        </tbody></table>
      </section>

      {!published ? (
        <section className="card stack">
          <label>Note for the record (optional)<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Festival week: chilled priority to outlets skipped yesterday" /></label>
          <label className="row" style={{ fontWeight: 500 }}>
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} style={{ minHeight: 0 }} />
            I have reviewed the {r.summary.deferred} deferrals and their reasons.
          </label>
          <ErrorNote error={error} />
          <button className="primary" disabled={busy || !confirmed || r.violations.length > 0} onClick={publish}>Publish plan v{r.version} to loaders, drivers and stores</button>
        </section>
      ) : (
        <Banner tone="ok" icon="✓">Plan v{r.version} is published. Change an order on the daily plan to create v{r.version + 1}.</Banner>
      )}
    </main>
  );
}

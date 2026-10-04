import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Banner, Chip, ErrorNote, Loading, StatusChip, TripChip } from '../../components/ui';
import { api, fmtDateTime, fmtTime } from '../../lib/api';

const KIND: Record<string, string> = { loading_shortfall: 'Loading shortfall', delivery_issue: 'Delivery issue', receipt_issue: 'Store reported issue', sync_conflict: 'Offline record conflicts with plan' };

/** D3: what needs a decision now, and the last thing the office actually heard from each run. */
export function DispatchProgress() {
  const [p, setP] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = () => api('/dispatch/progress').then(setP).catch((e) => setError(e.message));
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, []);
  if (!p) return <main className="page">{error ? <ErrorNote error={error} /> : <Loading />}</main>;
  const open = p.exceptions.filter((e: any) => e.status === 'open');
  const resolved = p.exceptions.filter((e: any) => e.status !== 'open');

  const resolve = async (ex: any, action: 'accept' | 'defer_order', resolution: string) => {
    setError(null);
    try {
      const r = await api(`/dispatch/exceptions/${ex.id}/resolve`, { body: { action, resolution } });
      setNotice(r.needs_publish ? `${ex.order_id} is deferred in a new draft. Review and publish it so the loader gets the revised list.` : 'Decision recorded.');
      await refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <main className="page stack">
      <div className="row spread">
        <h1>Progress & exceptions</h1>
        <span className="muted small">Published plan v{p.published_version ?? '—'} · refreshes every 15 s</span>
      </div>
      {!p.published_version && <Banner tone="info" icon="ℹ">No plan published yet. <Link to="/dispatch">Build and publish the daily plan</Link>.</Banner>}
      {notice && <Banner tone="ok" icon="✓">{notice} {notice.includes('draft') && <Link to="/dispatch/review">Review & publish</Link>}</Banner>}
      <ErrorNote error={error} />

      <section className="card stack">
        <h2>Needs your decision ({open.length})</h2>
        {open.length === 0 && <p className="muted">Nothing waiting. New shortfalls, delivery issues and store reports appear here.</p>}
        {open.map((ex: any) => <ExceptionCard key={ex.id} ex={ex} onResolve={resolve} />)}
      </section>

      <section className="card">
        <h2>Runs</h2>
        <table>
          <thead><tr><th>Run</th><th>Status</th><th className="hide-sm">Acknowledged</th><th>Stops</th><th>Last update received</th></tr></thead>
          <tbody>
            {p.trips.map((t: any) => (
              <tr key={`${t.vehicle_id}-${t.trip_no}`}>
                <td><strong>{t.vehicle_id}</strong> · T{t.trip_no}<div className="muted small">{t.brand} · {t.district} · departs {t.depart}</div></td>
                <td><TripChip status={t.status} /></td>
                <td className="small hide-sm">Loader {t.loader_ack_version === t.plan_version ? <Chip tone="ok" icon="✓">v{t.plan_version}</Chip> : <Chip tone="attention" icon="…">pending</Chip>}<br />Driver {t.driver_ack_version === t.plan_version ? <Chip tone="ok" icon="✓">v{t.plan_version}</Chip> : <Chip tone="attention" icon="…">not yet seen</Chip>}</td>
                <td className="small">{t.stops.map((s: any) => <div key={s.order_id} className="row" style={{ gap: '.3rem' }}>{s.order_id} ({s.outlet_id}) ETA {s.eta} <StatusChip status={s.status} />{s.record?.proof_status === 'pending' && <Chip tone="attention" icon="📷">Photo pending</Chip>}</div>)}</td>
                <td className="small">{t.last_update ? fmtDateTime(t.last_update) : t.status === 'en_route' ? <Chip tone="attention" icon="…">No update yet. Driver may be offline</Chip> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">Times are planning estimates from district travel and handling allowances. “Last update received” is when the server got the record, not live tracking.</p>
      </section>

      {resolved.length > 0 && (
        <section className="card">
          <h2>Resolved today</h2>
          {resolved.map((ex: any) => <p key={ex.id} className="small"><strong>{KIND[ex.kind]}</strong> · {ex.order_id} · {ex.resolution} <span className="muted">({fmtTime(ex.resolved_at)})</span></p>)}
        </section>
      )}
    </main>
  );
}

function ExceptionCard({ ex, onResolve }: { ex: any; onResolve(ex: any, a: 'accept' | 'defer_order', r: string): void }) {
  const [text, setText] = useState('');
  const tone = ex.kind === 'sync_conflict' || ex.kind === 'loading_shortfall' ? 'block' : 'attention';
  return (
    <div className={`banner ${tone}`} role="group" aria-label={KIND[ex.kind]}>
      <span className="icon" aria-hidden>{ex.kind === 'loading_shortfall' ? '⏸' : ex.kind === 'sync_conflict' ? '⇄' : '!'}</span>
      <div className="grow stack" style={{ gap: '.4rem' }}>
        <div><strong>{KIND[ex.kind]}</strong> · {ex.order_id} {ex.vehicle_id && `· ${ex.vehicle_id} trip ${ex.trip_no}`} <span className="muted small">raised {fmtTime(ex.created_at)}</span></div>
        <div>{ex.message}</div>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Decision and reason (recorded on the order)" />
        <div className="row">
          {ex.kind === 'loading_shortfall' && <button className="primary" disabled={text.length < 3} onClick={() => onResolve(ex, 'accept', text)}>Send short and release hold</button>}
          {ex.kind !== 'loading_shortfall' && <button className="primary" disabled={text.length < 3} onClick={() => onResolve(ex, 'accept', text)}>Record decision</button>}
          {ex.kind === 'loading_shortfall' && <button disabled={text.length < 3} onClick={() => onResolve(ex, 'defer_order', text)}>Defer this order (new plan version)</button>}
        </div>
      </div>
    </div>
  );
}

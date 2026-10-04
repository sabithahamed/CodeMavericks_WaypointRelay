import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Banner, Chip, ErrorNote, Loading, TempChip, TripChip } from '../components/ui';
import { api } from '../lib/api';

export function LoaderRuns() {
  const [r, setR] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api('/loader/runs').then(setR).catch((e) => setError(e.message)); }, []);
  if (!r) return <main className="page narrow">{error ? <ErrorNote error={error} /> : <Loading />}</main>;
  return (
    <main className="page narrow field-ui stack">
      <div>
        <h1>Runs to load · Peliyagoda dock</h1>
        <p className="muted small">{r.published_version ? `Published plan v${r.published_version}. Lists update when the dispatcher publishes a change.` : 'Waiting for the dispatcher to publish the plan.'}</p>
      </div>
      <ErrorNote error={error} />
      {r.runs.map((t: any) => (
        <Link key={`${t.vehicle_id}-${t.trip_no}`} to={`/loader/${t.vehicle_id}/${t.trip_no}`} className="stop" style={{ gridTemplateColumns: '1fr auto' }}>
          <div>
            <div className="row" style={{ gap: '.3rem' }}><strong>{t.vehicle_id} · Trip {t.trip_no}</strong>{t.chilled && <Chip tone="info" icon="❄">Chilled</Chip>}</div>
            <div className="muted small">{t.brand} · {t.district} · {t.stops} stops · departs {t.depart}</div>
            <div className="muted small num">{t.weight_kg} kg · {t.volume_m3} m³ · checked {t.checked}/{t.stops}</div>
            {t.loader_ack_version !== t.plan_version && t.loader_ack_version != null && <Chip tone="attention" icon="↻">List changed (v{t.plan_version})</Chip>}
          </div>
          <TripChip status={t.status} />
        </Link>
      ))}
    </main>
  );
}

export function LoaderRun() {
  const { vid, trip } = useParams();
  const [r, setR] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const refresh = () => api(`/loader/runs/${vid}/${trip}`).then(setR).catch((e) => setError(e.message));
  useEffect(() => { void refresh(); }, [vid, trip]);
  const call = async (path: string, body?: any) => {
    setError(null);
    try { await api(`/loader/runs/${vid}/${trip}${path}`, { method: 'POST', body }); await refresh(); } catch (e: any) { setError(e.message); }
  };
  if (!r) return <main className="page narrow">{error ? <ErrorNote error={error} /> : <Loading />}</main>;
  const status = r.run?.status ?? 'to_load';
  const locked = ['released', 'en_route', 'completed'].includes(status);
  const needsAck = r.run?.loader_ack_version !== r.run?.plan_version;
  const openEx = r.exceptions.filter((e: any) => e.status === 'open');
  const checkOf = (id: string) => r.checks.find((c: any) => c.order_id === id);
  const allChecked = r.stops.every((s: any) => checkOf(s.order_id));

  return (
    <main className="page narrow field-ui stack">
      <Link to="/loader">← All runs</Link>
      <div className="row spread">
        <div>
          <h1>{vid} · Trip {trip}</h1>
          <p className="muted small">{r.trip.brand} · {r.trip.district} · {r.trip.vehicle.type}, {r.trip.vehicle.temp === 'reefer' ? 'refrigerated' : 'ambient'} · {r.trip.weight_kg}/{r.trip.vehicle.weight_cap_kg} kg · {r.trip.volume_m3}/{r.trip.vehicle.volume_cap_m3} m³</p>
        </div>
        <TripChip status={status} />
      </div>

      {needsAck && !locked && (
        <Banner tone="attention" icon="↻">
          <strong>Plan v{r.plan_version} loading list.</strong> {r.run?.loader_ack_version ? `This list changed since you acknowledged v${r.run.loader_ack_version}. Check the items again.` : 'Confirm you are working from this version before loading.'}
          <div style={{ marginTop: '.4rem' }}><button className="primary" onClick={() => call('/ack')}>I have the v{r.plan_version} list</button></div>
        </Banner>
      )}
      {openEx.length > 0 && <Banner tone="block" icon="⏸"><strong>Run held.</strong> {openEx[0].message} Waiting for the dispatcher's decision.</Banner>}
      {openEx.length === 0 && r.exceptions.some((e: any) => e.status === 'resolved') && <Banner tone="ok" icon="✓">Dispatcher decided: {r.exceptions.find((e: any) => e.status === 'resolved').resolution}</Banner>}
      <ErrorNote error={error} />

      <h2>Load in this order <span className="muted small">(last stop first, so stop 1 is nearest the door)</span></h2>
      {r.load_order.map((s: any, i: number) => {
        const c = checkOf(s.order_id);
        return (
          <div key={s.order_id} className="card tight stack" style={{ gap: '.4rem' }}>
            <div className="row spread">
              <div><strong>{i + 1}. {s.order_id}</strong> → stop {s.seq}, {s.outlet.outlet_id}</div>
              <TempChip temp={s.temp_requirement} />
            </div>
            <div className="muted small num">{s.units} units · {s.weight_kg} kg · {s.volume_m3} m³ · {s.outlet.dock_type.replace('_', ' ')}</div>
            {c ? (
              <div className="row spread">
                {c.status === 'ok' ? <Chip tone="ok" icon="✓">Loaded {c.loaded_units}/{s.units}</Chip> : <Chip tone="block" icon="!">{c.status === 'damaged' ? 'Damaged' : 'Short'}: {c.loaded_units}/{s.units}</Chip>}
                {!locked && <button className="ghost" onClick={() => setProblem(s.order_id)}>Change</button>}
              </div>
            ) : !locked && !needsAck ? (
              <div className="seg">
                <button className="primary" onClick={() => call('/check', { order_id: s.order_id, loaded_units: s.units, status: 'ok' })}>All {s.units} loaded</button>
                <button onClick={() => setProblem(s.order_id)}>Missing / damaged</button>
              </div>
            ) : null}
            {problem === s.order_id && <ShortfallForm stop={s} onCancel={() => setProblem(null)} onSubmit={async (b) => { await call('/check', b); setProblem(null); }} />}
          </div>
        );
      })}

      {!locked && (
        <button className="primary block-btn" disabled={!allChecked || openEx.length > 0 || needsAck} onClick={() => call('/release')}>
          {openEx.length ? 'Held: waiting for dispatcher' : allChecked ? 'Release for departure' : `Check all ${r.stops.length} orders to release`}
        </button>
      )}
      {locked && <Banner tone="ok" icon="✓">Released for departure. The driver can start this run.</Banner>}
    </main>
  );
}

function ShortfallForm({ stop, onSubmit, onCancel }: { stop: any; onSubmit(b: any): Promise<void>; onCancel(): void }) {
  const [units, setUnits] = useState(stop.units);
  const [kind, setKind] = useState<'short' | 'damaged'>('short');
  const [note, setNote] = useState('');
  return (
    <div className="stack" style={{ gap: '.5rem' }}>
      <div className="seg" role="group" aria-label="Problem">
        <button aria-pressed={kind === 'short'} onClick={() => setKind('short')}>Missing items</button>
        <button aria-pressed={kind === 'damaged'} onClick={() => setKind('damaged')}>Damaged</button>
      </div>
      <label>Units actually loaded (ordered {stop.units})<input type="number" inputMode="numeric" min={0} max={stop.units} value={units} onChange={(e) => setUnits(Number(e.target.value))} /></label>
      <label>What is wrong?<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. 6 dairy crates not picked" /></label>
      <div className="seg">
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={note.trim().length < 3} onClick={() => onSubmit({ order_id: stop.order_id, loaded_units: units, status: kind, note })}>Report & hold run</button>
      </div>
    </div>
  );
}

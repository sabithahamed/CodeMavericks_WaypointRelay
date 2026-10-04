import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Banner, Chip, ErrorNote, Loading, StatusChip, TempChip, TripChip } from '../components/ui';
import { api, fmtDateTime, fmtTime, network } from '../lib/api';
import { compressPhoto, enqueue, getOutbox, getRun, onOutboxChange, saveRun, sync, type OutboxItem } from '../lib/outbox';

/** Shared driver state: the run sheet (server when reachable, phone copy otherwise) and the outbox. */
function useDriver() {
  const [run, setRun] = useState<any>(null);
  const [source, setSource] = useState<'server' | 'phone' | null>(null);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [online, setOnline] = useState(network.isOnline());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const fresh = await api('/driver/run');
      await saveRun(fresh);
      setRun(fresh);
      setSource('server');
    } catch (e: any) {
      const cached = await getRun();
      if (cached) { setRun(cached); setSource('phone'); } else setError('This run is not saved on this phone yet. Connect once at the depot to download it.');
    }
    setOutbox(await getOutbox());
  }, []);

  useEffect(() => {
    void load();
    const off = onOutboxChange(async () => setOutbox(await getOutbox()));
    const net = () => { setOnline(network.isOnline()); if (network.isOnline()) void sync().then(load); };
    window.addEventListener('online', net);
    window.addEventListener('offline', net);
    return () => { off(); window.removeEventListener('online', net); window.removeEventListener('offline', net); };
  }, [load]);

  const toggleSim = () => {
    network.simulatedOffline = !network.simulatedOffline;
    try { localStorage.setItem('relay.simOffline', network.simulatedOffline ? '1' : '0'); } catch { /* ignore */ }
    setOnline(network.isOnline());
    if (network.isOnline()) void sync().then(load);
  };
  return { run, source, outbox, online, error, load, toggleSim };
}

function NetBar({ online, outbox, toggleSim, source, run }: any) {
  const pending = outbox.filter((i: OutboxItem) => i.state === 'saved' || i.state === 'failed' || i.state === 'uploading').length;
  return (
    <div className={`netbar ${online ? 'online' : 'offline'}`} role="status" aria-live="polite">
      <span aria-hidden>{online ? '●' : '○'}</span>
      <span className="grow">
        {online ? 'Connected' : 'Offline. You can keep recording deliveries'}
        {pending > 0 && ` · ${pending} saved on this phone, not uploaded`}
        {run && <span className="muted small"> · run saved {fmtTime(run.downloaded_at)}{source === 'phone' ? ' (phone copy)' : ''}</span>}
      </span>
      <button className="ghost small" style={{ minHeight: 32 }} onClick={toggleSim} aria-pressed={network.simulatedOffline}>
        {network.simulatedOffline ? 'Restore signal' : 'Simulate no signal'}
      </button>
    </div>
  );
}

/** Latest local state for an order, so the driver sees their own unsent work immediately. */
const localFor = (outbox: OutboxItem[], orderId: string) =>
  [...outbox].reverse().find((i) => i.kind === 'delivery' && i.order_id === orderId) as Extract<OutboxItem, { kind: 'delivery' }> | undefined;

function LocalState({ item, outbox }: { item?: Extract<OutboxItem, { kind: 'delivery' }>; outbox: OutboxItem[] }) {
  if (!item) return null;
  const proof = outbox.find((p) => p.kind === 'proof' && p.delivery_client_id === item.client_id);
  if (item.state === 'conflict') return <Chip tone="block" icon="⇄">Saved · dispatcher review</Chip>;
  if (item.state === 'uploaded') return proof && proof.state !== 'uploaded' ? <Chip tone="attention" icon="📷">Uploaded · photo pending</Chip> : <Chip tone="ok" icon="✓">Uploaded</Chip>;
  return <Chip tone="attention" icon="📱">Saved on this phone</Chip>;
}

export function DriverRun() {
  const d = useDriver();
  const [msg, setMsg] = useState<string | null>(null);
  if (!d.run) return <><NetBar {...d} /><main className="page narrow">{d.error ? <Banner tone="block" icon="!">{d.error}</Banner> : <Loading />}</main></>;
  const queued = (kind: string, trip: number) => d.outbox.find((i) => i.kind === kind && 'trip_no' in i && i.trip_no === trip);

  return (
    <>
      <NetBar {...d} />
      <main className="page narrow field-ui stack">
        <div>
          <h1>Today's run · {d.run.vehicle_id}</h1>
          <p className="muted small">Plan v{d.run.plan_version ?? '—'} · Use this screen only when safely stopped.</p>
        </div>
        {msg && <Banner tone="ok" icon="✓">{msg}</Banner>}
        {d.run.trips.length === 0 && <Banner tone="info" icon="ℹ">No published run for {d.run.vehicle_id} yet. Pull down to refresh when the dispatcher publishes.</Banner>}
        {d.run.trips.map((t: any) => {
          const acked = t.run?.driver_ack_version === t.plan_version || queued('ack', t.trip.trip_no);
          const departed = ['en_route', 'completed'].includes(t.run?.status) || queued('depart', t.trip.trip_no);
          const nextStop = t.stops.find((s: any) => !localFor(d.outbox, s.order_id) && !['delivered', 'partial', 'failed', 'received', 'issue'].includes(s.status));
          return (
            <section key={t.trip.trip_no} className="card stack">
              <div className="row spread">
                <h2>Trip {t.trip.trip_no} · {t.trip.district}</h2>
                <TripChip status={t.run?.status ?? 'to_load'} />
              </div>
              <p className="muted small">{t.trip.brand} · {t.stops.length} stops · planned departure {t.trip.depart} · {t.trip.weight_kg} kg</p>
              {!acked && (
                <button className="primary block-btn" onClick={async () => { await enqueue({ kind: 'ack', trip_no: t.trip.trip_no, plan_version: t.plan_version } as any); setMsg(`Trip ${t.trip.trip_no} instructions acknowledged.`); }}>
                  Acknowledge trip {t.trip.trip_no} instructions (v{t.plan_version})
                </button>
              )}
              {acked && !departed && (
                t.run?.status === 'released'
                  ? <button className="primary block-btn" onClick={async () => { await enqueue({ kind: 'depart', trip_no: t.trip.trip_no, plan_version: t.plan_version } as any); setMsg(`Departure recorded for trip ${t.trip.trip_no}.`); }}>Start trip {t.trip.trip_no}: leaving depot</button>
                  : <Banner tone="info" icon="⏳">Waiting for the loader to release this vehicle.</Banner>
              )}
              {t.stops.map((s: any) => (
                <Link key={s.order_id} to={`/driver/stop/${s.order_id}`} className={`stop ${nextStop?.order_id === s.order_id && departed ? 'next' : ''}`}>
                  <span className="seq">{s.seq}</span>
                  <span>
                    <strong>{s.outlet.outlet_id}</strong> · ETA {s.eta}
                    <div className="muted small">Window {s.outlet.window_open_time}–{s.outlet.window_close_time} · {s.outlet.dock_type.replace('_', ' ')}{s.outlet.parking_constraint === 'van_only' ? ' · van access only' : ''}</div>
                    <div className="row" style={{ gap: '.25rem', marginTop: '.2rem' }}><TempChip temp={s.temp_requirement} /><span className="small">{s.units} units</span></div>
                  </span>
                  <span>{localFor(d.outbox, s.order_id) ? <LocalState item={localFor(d.outbox, s.order_id)} outbox={d.outbox} /> : <StatusChip status={s.status} />}</span>
                </Link>
              ))}
            </section>
          );
        })}
        <Link to="/driver/saved" className="btn block-btn">Saved work & uploads</Link>
      </main>
    </>
  );
}

export function DriverStop() {
  const { orderId } = useParams();
  const d = useDriver();
  const nav = useNavigate();
  const [outcome, setOutcome] = useState<'delivered' | 'partial' | 'failed'>('delivered');
  const [units, setUnits] = useState<number | null>(null);
  const [condition, setCondition] = useState('good');
  const [recipient, setRecipient] = useState('');
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!d.run) return <><NetBar {...d} /><main className="page narrow">{d.error ? <ErrorNote error={d.error} /> : <Loading />}</main></>;
  const trip = d.run.trips.find((t: any) => t.stops.some((s: any) => s.order_id === orderId));
  const stop = trip?.stops.find((s: any) => s.order_id === orderId);
  if (!stop) return <main className="page narrow"><ErrorNote error="This stop is not on your saved run." /></main>;
  const existing = localFor(d.outbox, stop.order_id);
  const u = units ?? stop.units;

  const save = async () => {
    setError(null);
    if (outcome !== 'delivered' && note.trim().length < 3) return setError('Add a short note explaining what happened.');
    if (outcome === 'partial' && u >= stop.units) return setError('For a partial delivery, enter fewer units than ordered.');
    setBusy(true);
    try {
      const rec = await enqueue({
        kind: 'delivery', trip_no: trip.trip.trip_no, plan_version: trip.plan_version, order_id: stop.order_id, outcome,
        delivered_units: outcome === 'failed' ? 0 : outcome === 'delivered' ? stop.units : u,
        condition, recipient: recipient || undefined, note: note || undefined, arrived_at: new Date().toISOString(), has_photo: !!photo,
      } as any);
      if (photo) await enqueue({ kind: 'proof', delivery_client_id: rec.client_id, order_id: stop.order_id, photo } as any);
      setSaved(network.isOnline() ? 'Delivery saved on this phone. Uploading…' : 'Delivery saved on this phone. Not uploaded yet. It will upload when you have signal.');
    } catch {
      setError('This phone could not save the record. Your entries are still here. Free up storage and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <NetBar {...d} />
      <main className="page narrow field-ui stack">
        <Link to="/driver">← Run</Link>
        <div>
          <h1>Stop {stop.seq} · {stop.outlet.outlet_id}</h1>
          <p className="muted small">{stop.order_id} · {stop.units} units · window {stop.outlet.window_open_time}–{stop.outlet.window_close_time} · {stop.outlet.dock_type.replace('_', ' ')}</p>
          <TempChip temp={stop.temp_requirement} />
        </div>
        {existing && !saved && <Banner tone="info" icon="ℹ">Already recorded: {existing.outcome}. <LocalState item={existing} outbox={d.outbox} /> Saving again adds a correction for the dispatcher.</Banner>}
        {saved ? (
          <>
            <Banner tone={network.isOnline() ? 'ok' : 'attention'} icon={network.isOnline() ? '✓' : '📱'}>{saved}</Banner>
            {existing && <p><LocalState item={existing} outbox={d.outbox} /></p>}
            <button className="primary block-btn" onClick={() => nav('/driver')}>Back to run</button>
            <Link className="btn block-btn" to="/driver/saved">See saved work</Link>
          </>
        ) : (
          <>
            <fieldset className="seg" style={{ border: 0, padding: 0 }} aria-label="Outcome">
              <button aria-pressed={outcome === 'delivered'} onClick={() => setOutcome('delivered')}>Delivered</button>
              <button aria-pressed={outcome === 'partial'} onClick={() => setOutcome('partial')}>Partly</button>
              <button aria-pressed={outcome === 'failed'} onClick={() => setOutcome('failed')}>Not delivered</button>
            </fieldset>
            {outcome === 'partial' && <label>Units handed over (of {stop.units})<input type="number" inputMode="numeric" min={0} max={stop.units} value={u} onChange={(e) => setUnits(Number(e.target.value))} /></label>}
            {outcome !== 'failed' && (
              <>
                <label>Condition<select value={condition} onChange={(e) => setCondition(e.target.value)}><option value="good">Good</option><option value="damaged">Some damage</option><option value="temperature">Temperature concern</option></select></label>
                <label>Received by<input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="Name of store staff" /></label>
              </>
            )}
            <label>{outcome === 'delivered' ? 'Note (optional)' : 'What happened?'}<textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={outcome === 'failed' ? 'e.g. Store closed, mall bay blocked' : ''} /></label>
            <label>Proof photo (optional)
              <input type="file" accept="image/*" capture="environment" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setPhoto(await compressPhoto(f).catch(() => null)); }} />
            </label>
            {photo && <img src={photo} alt="Proof of delivery preview" className="photo-preview" />}
            <ErrorNote error={error} />
            <button className="primary block-btn" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save delivery record'}</button>
            <p className="muted small">Saved on this phone first, then uploaded. Nothing is lost if signal drops.</p>
          </>
        )}
      </main>
    </>
  );
}

const STATE_LABEL: Record<string, { label: string; tone: any; icon: string }> = {
  saved: { label: 'Saved on this phone · not uploaded', tone: 'attention', icon: '📱' },
  uploading: { label: 'Uploading…', tone: 'info', icon: '↑' },
  uploaded: { label: 'Uploaded', tone: 'ok', icon: '✓' },
  conflict: { label: 'Uploaded · dispatcher review needed', tone: 'block', icon: '⇄' },
  failed: { label: 'Upload failed · will retry', tone: 'block', icon: '!' },
};

/** R3: the degradation screen. What is safe, what is still only on the phone, what needs someone else. */
export function DriverSaved() {
  const d = useDriver();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const items = [...d.outbox].reverse();
  const pending = items.filter((i) => i.state === 'saved' || i.state === 'failed');
  const conflicts = items.filter((i) => i.state === 'conflict');
  const label = (i: OutboxItem) =>
    i.kind === 'delivery' ? `Delivery record · ${i.order_id} · ${i.outcome} (${i.delivered_units} units)` : i.kind === 'proof' ? `Proof photo · ${i.order_id}` : i.kind === 'ack' ? `Acknowledged trip ${i.trip_no} (v${i.plan_version})` : `Departure · trip ${i.trip_no}`;

  return (
    <>
      <NetBar {...d} />
      <main className="page narrow field-ui stack">
        <h1>Saved work & uploads</h1>
        {pending.length === 0 && conflicts.length === 0 && <Banner tone="ok" icon="✓">Everything recorded on this phone has reached the office.</Banner>}
        {pending.length > 0 && (
          <Banner tone="attention" icon="📱">
            <strong>{pending.length} item(s) are saved on this phone only.</strong> They are safe here and will upload automatically when signal returns. Do not clear this browser's data before they upload.
          </Banner>
        )}
        {conflicts.length > 0 && (
          <Banner tone="block" icon="⇄">
            <strong>The plan changed after your run was downloaded.</strong> Your delivery record is preserved and has reached the office. The dispatcher will decide which instruction stands. You do not need to re-enter anything.
          </Banner>
        )}
        {result && <Banner tone="info" icon="ℹ">{result}</Banner>}
        <button className="primary block-btn" disabled={busy || !d.online || pending.length === 0} onClick={async () => {
          setBusy(true);
          const r = await sync();
          setResult(r.pending ? `${r.sent} uploaded, ${r.pending} still waiting.` : `${r.sent} uploaded.`);
          await d.load();
          setBusy(false);
        }}>{d.online ? (busy ? 'Uploading…' : `Upload now (${pending.length})`) : 'No signal: uploads will start automatically'}</button>
        <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {items.map((i) => {
            const s = STATE_LABEL[i.state];
            return (
              <li key={i.client_id} className="card tight">
                <div className="row spread"><strong className="small">{label(i)}</strong><Chip tone={s.tone} icon={s.icon}>{s.label}</Chip></div>
                <div className="muted small">Recorded {fmtDateTime(i.recorded_at)} on this phone · ref {i.client_id.slice(0, 8)}</div>
                {i.message && <div className="small">{i.message}</div>}
              </li>
            );
          })}
        </ul>
        {d.outbox.length === 0 && <p className="muted">Nothing recorded on this phone yet.</p>}
      </main>
    </>
  );
}

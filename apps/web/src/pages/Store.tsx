import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Banner, Chip, ErrorNote, Loading, StatusChip, TempChip, Timeline } from '../components/ui';
import { api, fmtDate, fmtDateTime } from '../lib/api';

const useStoreOrders = () => {
  const [r, setR] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api('/store/orders').then(setR).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);
  return { r, error, load };
};

/** What the store should prepare for, in one line per order. */
function arrivalLine(o: any) {
  if (o.status === 'received') return 'Receipt confirmed.';
  if (o.record) return `Driver reported ${o.record.outcome} (${o.record.delivered_units} units) at ${fmtDateTime(o.record.recorded_at)}. Please confirm what arrived.`;
  if (o.deferral) return o.deferral.code === 'exceeds_vehicle_capacity' ? 'Too large for any vehicle as ordered. The dispatcher will contact you to revise it.' : 'Deferred. Reviewed again at the next run; no new arrival time yet.';
  if (o.assignment?.eta) return `Expected around ${o.assignment.eta} (planning estimate, plan v${o.published_version}).`;
  if (o.day_status === 'open') return 'Order received. It will be planned after the 16:00 cutoff.';
  return 'Order received. The dispatcher is planning this run.';
}

export function StoreOrders() {
  const { r, error } = useStoreOrders();
  if (!r) return <main className="page narrow">{error ? <ErrorNote error={error} /> : <Loading />}</main>;
  const toConfirm = r.orders.filter((o: any) => o.record && !o.receipt);
  return (
    <main className="page narrow stack" style={{ maxWidth: 760 }}>
      <div className="row spread">
        <div>
          <h1>My orders · {r.outlet.outlet_id}</h1>
          <p className="muted small">Waypoint {r.outlet.brand} · {r.outlet.district} · receiving window {r.outlet.window_open_time}–{r.outlet.window_close_time}</p>
        </div>
        <Link to="/store/new" className="btn primary">Place an order</Link>
      </div>
      {toConfirm.length > 0 && <Banner tone="attention" icon="✋"><strong>{toConfirm.length} delivery(ies) to confirm.</strong> Check what arrived and confirm receipt or report an issue.</Banner>}
      {r.orders.map((o: any) => (
        <Link key={o.id} to={`/store/orders/${o.id}`} className="card tight stack" style={{ textDecoration: 'none', color: 'inherit', gap: '.35rem' }}>
          <div className="row spread">
            <div className="row" style={{ gap: '.35rem' }}><strong>{o.id}</strong><TempChip temp={o.temp_requirement} /></div>
            <StatusChip status={o.status} />
          </div>
          <div className="small muted">For {fmtDate(o.delivery_date)} · {o.units} units · {o.weight_kg} kg</div>
          <div className="small">{arrivalLine(o)}</div>
          {o.deferral && <div className="small"><strong>Reason:</strong> {o.deferral.reason}</div>}
        </Link>
      ))}
    </main>
  );
}

export function StoreNewOrder() {
  const [cat, setCat] = useState<any>(null);
  const [temp, setTemp] = useState<'ambient' | 'chilled'>('ambient');
  const [qty, setQty] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  useEffect(() => { api('/store/catalogue').then(setCat).catch((e) => setError(e.message)); }, []);
  if (!cat) return <main className="page narrow">{error ? <ErrorNote error={error} /> : <Loading />}</main>;
  const items = cat.items.filter((i: any) => i.temp === temp);
  const lines = items.filter((i: any) => (qty[i.sku] ?? 0) > 0).map((i: any) => ({ ...i, qty: qty[i.sku] }));
  const kg = lines.reduce((s: number, l: any) => s + l.qty * l.kg, 0);
  const m3 = lines.reduce((s: number, l: any) => s + l.qty * l.m3, 0);

  if (done) {
    return (
      <main className="page narrow field-ui stack">
        <Banner tone="ok" icon="✓"><strong>Order {done.id} received and confirmed</strong> for {fmtDate(done.delivery_date)}. {done.note}</Banner>
        <p className="muted small">You will see the expected arrival time here once the dispatcher publishes the plan, or a reason if it has to wait.</p>
        <button className="primary block-btn" onClick={() => nav(`/store/orders/${done.id}`)}>View order</button>
        <Link to="/store" className="btn block-btn">My orders</Link>
      </main>
    );
  }

  return (
    <main className="page narrow field-ui stack">
      <Link to="/store">← My orders</Link>
      <h1>Place an order</h1>
      <Banner tone="info" icon="🕓">Orders for the next run close at 16:00. After the dispatcher closes orders, new orders wait for the following run, and you will be told which.</Banner>
      {cat.outlet.brand === 'Fresh' && (
        <div className="seg" role="group" aria-label="Order type">
          <button aria-pressed={temp === 'ambient'} onClick={() => { setTemp('ambient'); setQty({}); }}>Dry / ambient</button>
          <button aria-pressed={temp === 'chilled'} onClick={() => { setTemp('chilled'); setQty({}); }}>❄ Chilled</button>
        </div>
      )}
      {cat.outlet.brand === 'Fresh' && <p className="muted small">Chilled and dry goods are separate orders because chilled goods need a refrigerated vehicle.</p>}
      <div className="card stack">
        {items.map((i: any) => (
          <label key={i.sku} className="row spread" style={{ fontWeight: 500 }}>
            <span>{i.name}<div className="muted small">{i.kg} kg · {i.m3} m³ per unit</div></span>
            <input type="number" inputMode="numeric" min={0} max={500} style={{ width: 96 }} value={qty[i.sku] ?? ''} onChange={(e) => setQty({ ...qty, [i.sku]: Number(e.target.value) })} aria-label={`${i.name} quantity`} />
          </label>
        ))}
      </div>
      <p className="small num">Total: {lines.reduce((s: number, l: any) => s + l.qty, 0)} units · {kg.toFixed(1)} kg · {m3.toFixed(3)} m³</p>
      <p className="muted small">Catalogue items are illustrative handling units (the shared data has order totals, not products).</p>
      <ErrorNote error={error} />
      <button className="primary block-btn" disabled={busy || lines.length === 0} onClick={async () => {
        setBusy(true);
        setError(null);
        try { setDone(await api('/store/orders', { body: { temp_requirement: temp, lines: lines.map((l: any) => ({ sku: l.sku, qty: l.qty })) } })); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
      }}>Submit order</button>
    </main>
  );
}

export function StoreOrder() {
  const { id } = useParams();
  const { r, error, load } = useStoreOrders();
  const [mode, setMode] = useState<'confirm' | 'issue' | null>(null);
  const [units, setUnits] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (!r) return <main className="page narrow">{error ? <ErrorNote error={error} /> : <Loading />}</main>;
  const o = r.orders.find((x: any) => x.id === id);
  if (!o) return <main className="page narrow"><ErrorNote error="Order not found." /></main>;
  const u = units ?? o.record?.delivered_units ?? o.units;
  const canConfirm = !o.receipt && (o.record || ['en_route', 'loaded'].includes(o.status));

  const submit = async (status: 'confirmed' | 'issue') => {
    setErr(null);
    try {
      await api(`/store/orders/${o.id}/receipt`, { body: { status, received_units: u, note: note || undefined } });
      setMode(null);
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <main className="page narrow field-ui stack">
      <Link to="/store">← My orders</Link>
      <div className="row spread"><h1>{o.id}</h1><StatusChip status={o.status} /></div>
      <div className="row"><TempChip temp={o.temp_requirement} /><Chip>{o.units} units</Chip><Chip>{fmtDate(o.delivery_date)}</Chip></div>
      <Banner tone={o.deferral ? 'attention' : o.record ? 'ok' : 'info'} icon={o.deferral ? '⏸' : o.record ? '🚚' : '🕓'}>{arrivalLine(o)}{o.deferral && <div><strong>Reason:</strong> {o.deferral.reason}</div>}</Banner>

      <section className="card stack">
        <h2>Delivery and receipt</h2>
        <div className="small"><strong>Driver's record:</strong> {o.record ? `${o.record.outcome}, ${o.record.delivered_units} units, condition ${o.record.condition ?? 'not stated'}${o.record.recipient ? `, received by ${o.record.recipient}` : ''}. Proof photo: ${o.record.proof_status === 'uploaded' ? 'uploaded' : o.record.proof_status === 'pending' ? 'still uploading from the driver\'s phone' : 'none'}.` : 'Not yet received from the driver.'}</div>
        <div className="small"><strong>Your confirmation:</strong> {o.receipt ? `${o.receipt.status === 'confirmed' ? 'Confirmed' : 'Issue reported'}: ${o.receipt.received_units} units${o.receipt.note ? `, “${o.receipt.note}”` : ''} at ${fmtDateTime(o.receipt.confirmed_at)}.` : 'Not confirmed yet.'}</div>
        {canConfirm && !mode && (
          <div className="seg">
            <button className="primary" onClick={() => setMode('confirm')}>Confirm receipt</button>
            <button onClick={() => setMode('issue')}>Report an issue</button>
          </div>
        )}
        {mode && (
          <div className="stack" style={{ gap: '.5rem' }}>
            <label>Units received (ordered {o.units})<input type="number" inputMode="numeric" min={0} max={o.units} value={u} onChange={(e) => setUnits(Number(e.target.value))} /></label>
            <label>{mode === 'issue' ? 'What is wrong?' : 'Note (optional)'}<textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={mode === 'issue' ? 'e.g. 4 dairy crates missing, 1 damaged' : ''} /></label>
            {mode === 'confirm' && u < o.units && <Banner tone="attention" icon="!">Fewer units than ordered will be recorded as an issue for the dispatcher.</Banner>}
            <ErrorNote error={err} />
            <div className="seg">
              <button onClick={() => setMode(null)}>Cancel</button>
              <button className="primary" disabled={mode === 'issue' && note.trim().length < 3} onClick={() => submit(mode === 'issue' ? 'issue' : 'confirmed')}>{mode === 'issue' ? 'Send issue to dispatcher' : 'Confirm receipt'}</button>
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Order history</h2>
        <Timeline events={o.events} />
      </section>
    </main>
  );
}

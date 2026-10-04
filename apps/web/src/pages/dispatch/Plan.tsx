import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Banner, Chip, ErrorNote, Loading, Meter, StatusChip, TempChip } from '../../components/ui';
import { api, fmtDate } from '../../lib/api';

export type DayState = Awaited<ReturnType<typeof loadDay>>;
export const loadDay = () => api<any>('/dispatch/day');
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m) % 60).padStart(2, '0')}`;

export function DispatchPlan() {
  const [s, setS] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<'all' | 'deferred' | 'chilled' | 'repeat'>('all');
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = () => loadDay().then(setS).catch((e) => setError(e.message));
  useEffect(() => { void refresh(); }, []);

  const act = async (fn: () => Promise<any>) => {
    setBusy(true);
    setError(null);
    try { setS(await fn()); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const placement = useMemo(() => {
    const m = new Map<string, { label: string; tone: string; trip?: any; deferral?: any }>();
    if (!s?.plan) return m;
    for (const t of s.plan.trips) for (const id of t.order_ids) m.set(id, { label: `${t.vehicle_id} · T${t.trip_no}`, tone: 'action', trip: t });
    for (const d of s.plan.deferred) m.set(d.order_id, { label: d.code === 'exceeds_vehicle_capacity' ? 'Needs revision' : 'Deferred', tone: d.code === 'exceeds_vehicle_capacity' ? 'block' : 'attention', deferral: d });
    return m;
  }, [s]);

  if (!s) return <main className="page">{error ? <ErrorNote error={error} /> : <Loading />}</main>;
  const { day, plan, orders } = s;
  const shown = orders.filter((o: any) =>
    filter === 'all' ? true : filter === 'deferred' ? placement.get(o.id)?.deferral : filter === 'chilled' ? o.temp_requirement === 'chilled' : o.deferred_yesterday,
  );
  const byVehicle = new Map<string, any[]>();
  for (const t of plan?.trips ?? []) byVehicle.set(t.vehicle_id, [...(byVehicle.get(t.vehicle_id) ?? []), t]);
  const draft = plan && plan.status === 'draft';

  return (
    <main className="page stack">
      <div className="row spread">
        <div>
          <h1>Daily plan · {fmtDate(day.delivery_date)} · {day.depot}</h1>
          <p className="muted small">{day.label}</p>
        </div>
        <div className="row">
          {day.status === 'open' ? (
            <button className="primary" disabled={busy} onClick={() => act(() => api('/dispatch/day/close', { method: 'POST' }))}>Close orders (cutoff 16:00)</button>
          ) : (
            <>
              <Chip tone="info" icon="🔒">Orders closed</Chip>
              <button disabled={busy} onClick={() => act(() => api('/dispatch/plan/auto', { method: 'POST' }))}>{plan ? 'Re-run allocation' : 'Build plan'}</button>
              {plan && <Link className={`btn ${draft ? 'primary' : ''}`} to="/dispatch/review">{draft ? `Review & publish v${plan.version}` : `v${plan.version} published`}</Link>}
            </>
          )}
        </div>
      </div>

      {day.status === 'open' && <Banner tone="info" icon="ℹ">Orders are still open. Store orders placed now join this run. Close orders to plan against the confirmed queue; later orders wait for the following run.</Banner>}
      <ErrorNote error={error} />

      {plan && (
        <div className="kpis">
          <div className="kpi"><div className="v">{plan.summary.orders}</div><div className="l">Confirmed orders</div></div>
          <div className="kpi"><div className="v">{plan.summary.served}</div><div className="l">Served in plan</div></div>
          <div className="kpi"><div className="v">{plan.summary.deferred}</div><div className="l">Deferred, with reasons</div></div>
          <div className="kpi"><div className="v">{plan.summary.vehicles_used}/{plan.summary.vehicles_available}</div><div className="l">Vehicles used / available</div></div>
          <div className="kpi"><div className="v">{plan.summary.chilled_demand_m3} m³</div><div className="l">Chilled demand vs {plan.summary.chilled_capacity_m3} m³ max reefer capacity (2 trips)</div></div>
          <div className="kpi"><div className="v">{plan.violations.length}</div><div className="l">Rule violations</div></div>
        </div>
      )}
      {plan && plan.summary.chilled_demand_m3 > plan.summary.chilled_capacity_m3 && (
        <Banner tone="attention" icon="⚠">
          Chilled demand ({plan.summary.chilled_demand_m3} m³) is more than every available refrigerated vehicle can carry in two trips ({plan.summary.chilled_capacity_m3} m³). Some chilled deferrals are unavoidable today; {s.workshop.length} vehicles are in the workshop.
        </Banner>
      )}
      {plan?.violations.length > 0 && (
        <Banner tone="block" icon="✕"><strong>This plan cannot be published yet.</strong> {plan.violations.slice(0, 3).map((v: any) => v.message).join(' ')}</Banner>
      )}

      <div className="plan-grid">
        <section className="card" aria-label="Order queue">
          <div className="row spread"><h2>Order queue</h2><span className="muted small">{shown.length} shown</span></div>
          <div className="tabs" role="tablist">
            {(['all', 'deferred', 'chilled', 'repeat'] as const).map((f) => (
              <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>
                {{ all: 'All', deferred: 'Deferred', chilled: 'Chilled', repeat: 'Skipped last run' }[f]}
              </button>
            ))}
          </div>
          <div className="scroll">
            <table>
              <thead><tr><th>Order</th><th>Outlet</th><th className="hide-sm">Load</th><th>Window</th><th>Decision</th></tr></thead>
              <tbody>
                {shown.map((o: any) => {
                  const p = placement.get(o.id);
                  return (
                    <tr key={o.id} className={`clickable ${selected === o.id ? 'selected' : ''}`} onClick={() => setSelected(o.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSelected(o.id)}>
                      <td><strong>{o.id}</strong><div className="row" style={{ gap: '.25rem' }}><TempChip temp={o.temp_requirement} />{o.deferred_yesterday && <Chip tone="attention" icon="↺">Skipped yesterday</Chip>}{o.source === 'store' && <Chip tone="info" icon="＋">New</Chip>}</div></td>
                      <td>{o.outlet_id}<div className="muted small">{o.brand} · {o.district}{o.parking_constraint === 'van_only' ? ' · van only' : o.parking_constraint === 'mall_dock' ? ' · mall' : ''}</div></td>
                      <td className="num hide-sm">{o.weight_kg} kg<div className="muted small">{o.volume_m3} m³</div></td>
                      <td className="num">{o.window_open}–{o.window_close}</td>
                      <td>{p ? <Chip tone={p.tone as any} icon={p.deferral ? '⏸' : '▣'}>{p.label}</Chip> : <StatusChip status={o.status} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card" aria-label="Vehicles and trips">
          <div className="row spread"><h2>Vehicles & trips</h2>{plan && <span className="muted small">Plan v{plan.version} · {plan.status}</span>}</div>
          {!plan && <p className="muted">{day.status === 'open' ? 'Close orders, then build the plan.' : 'Build the plan to allocate orders to vehicles.'}</p>}
          <div className="scroll">
            {[...byVehicle.entries()].map(([vid, trips]) => {
              const v = trips[0].vehicle;
              return (
                <div key={vid} className="trip">
                  <div className="row spread">
                    <strong>{vid}</strong>
                    <span className="row" style={{ gap: '.25rem' }}>
                      <Chip icon={v.type === 'van' ? '🚐' : '🚚'}>{v.type}</Chip>
                      {v.temp === 'reefer' ? <Chip tone="info" icon="❄">Refrigerated</Chip> : <Chip icon="▢">Ambient</Chip>}
                    </span>
                  </div>
                  {trips.map((t: any) => (
                    <div key={t.trip_no} style={{ marginTop: '.45rem' }}>
                      <div className="row spread small">
                        <span><strong>Trip {t.trip_no}</strong> · {t.brand} · {t.district}</span>
                        <span className="muted num">{t.schedule ? `${hhmm(t.schedule.depart_min)}–${hhmm(t.schedule.return_min)}` : ''} · {t.minutes} min · {t.fuel_l} L</span>
                      </div>
                      <Meter label="Weight" used={t.weight_kg} cap={v.weight_cap_kg} unit="kg" />
                      <Meter label="Volume" used={t.volume_m3} cap={v.volume_cap_m3} unit="m³" />
                      <div className="row small" style={{ gap: '.3rem', marginTop: '.25rem' }}>
                        {t.order_ids.map((id: string, i: number) => {
                          const st = t.schedule?.stops.find((x: any) => x.order_id === id);
                          return (
                            <button key={id} className="ghost small" style={{ minHeight: 0, padding: '.1rem .35rem' }} onClick={() => setSelected(id)}>
                              {i + 1}. {id}{st ? ` @${hhmm(st.arrival_min)}` : ''}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {selected && <OrderDrawer orderId={selected} state={s} placement={placement.get(selected)} onClose={() => setSelected(null)} onChange={(n) => { setS(n); }} editable={day.status === 'closed' && !!plan} />}
    </main>
  );
}

function OrderDrawer({ orderId, state, placement, onClose, onChange, editable }: { orderId: string; state: any; placement: any; onClose(): void; onChange(s: any): void; editable: boolean }) {
  const order = state.orders.find((o: any) => o.id === orderId);
  const [options, setOptions] = useState<any[] | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  useEffect(() => {
    setOptions(null);
    setError(null);
    if (editable) api(`/dispatch/plan/options/${orderId}`).then((r) => setOptions(r.options)).catch((e) => setError(e.message));
    api(`/orders/${orderId}/events`).then((r) => setEvents(r.events)).catch(() => undefined);
  }, [orderId, editable, state.plan?.version, state.plan?.trips.length]);
  const move = async (body: any) => {
    setError(null);
    try { onChange(await api('/dispatch/plan/move', { body: { order_id: orderId, ...body } })); } catch (e: any) { setError(e.message); }
  };
  if (!order) return null;
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer stack" aria-label={`Order ${orderId}`}>
        <div className="row spread"><h2>{order.id}</h2><button className="ghost" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="row"><TempChip temp={order.temp_requirement} /><Chip>{order.brand}</Chip><Chip>{order.district}</Chip>{order.parking_constraint !== 'normal' && <Chip tone="attention" icon="⚑">{order.parking_constraint === 'van_only' ? 'Van only' : 'Mall dock'}</Chip>}</div>
        <table className="small">
          <tbody>
            <tr><td className="muted">Outlet</td><td>{order.outlet_id} · {order.dock_type.replace('_', ' ')}</td></tr>
            <tr><td className="muted">Delivery window</td><td className="num">{order.window_open}–{order.window_close}</td></tr>
            <tr><td className="muted">Size</td><td className="num">{order.units} units · {order.weight_kg} kg · {order.volume_m3} m³</td></tr>
            <tr><td className="muted">Service history</td><td>{order.deferred_yesterday ? 'Skipped on the previous run · ' : ''}{order.days_since_last_served} day(s) since last served</td></tr>
          </tbody>
        </table>
        {placement?.trip && <Banner tone="ok" icon="▣">Planned on <strong>{placement.trip.vehicle_id} trip {placement.trip.trip_no}</strong> ({placement.trip.brand}, {placement.trip.district}).</Banner>}
        {placement?.deferral && <Banner tone={placement.deferral.code === 'exceeds_vehicle_capacity' ? 'block' : 'attention'} icon="⏸"><strong>{placement.deferral.code === 'exceeds_vehicle_capacity' ? 'Cannot be served as ordered.' : 'Deferred.'}</strong> {placement.deferral.reason}</Banner>}
        <ErrorNote error={error} />
        {editable && (
          <>
            <h3>Compatible vehicles</h3>
            {!options ? <Loading /> : options.length === 0 ? <p className="muted small">No available vehicle has the capability this order needs.</p> : (
              <div className="stack" style={{ gap: '.35rem' }}>
                {options.slice(0, 12).map((o) => (
                  <div key={`${o.vehicle_id}-${o.trip_no}`} className="row spread small">
                    <span><strong>{o.vehicle_id}</strong> trip {o.trip_no}{!o.feasible && <div className="muted">{o.reason}</div>}</span>
                    <button disabled={!o.feasible} onClick={() => move({ vehicle_id: o.vehicle_id, trip_no: o.trip_no })}>{o.feasible ? 'Move here' : 'Not feasible'}</button>
                  </div>
                ))}
              </div>
            )}
            {!placement?.deferral && (
              <div className="stack" style={{ gap: '.4rem' }}>
                <h3>Defer this order</h3>
                <label>Reason (shown to the store)<textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Refrigerated capacity given to outlets skipped yesterday" /></label>
                <button className="danger" disabled={reason.trim().length < 5} onClick={() => move({ defer: true, reason })}>Defer with this reason</button>
              </div>
            )}
          </>
        )}
        <h3>Activity</h3>
        <ol className="timeline">{events.map((e) => <li key={e.id}><div className="t">{new Date(e.at).toLocaleString('en-GB', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })} · {e.actor_name}</div>{e.message}</li>)}</ol>
      </aside>
    </>
  );
}

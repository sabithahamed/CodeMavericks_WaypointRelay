import { useEffect, useState } from 'react';
import { Banner, ErrorNote, Loading } from '../../components/ui';
import { api } from '../../lib/api';

/** D4: weekly requested demand (including deferred and never-run orders) and a baseline outlook. */
export function DispatchOutlook() {
  const [o, setO] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [depot, setDepot] = useState('Peliyagoda');
  useEffect(() => { api('/dispatch/outlook').then(setO).catch((e) => setError(e.message)); }, []);
  if (!o) return <main className="page">{error ? <ErrorNote error={error} /> : <Loading />}</main>;
  const series = o.series.filter((s: any) => s.depot === depot);
  if (o.series.length === 0) return <main className="page"><h1>Capacity outlook</h1><Banner tone="info" icon="ℹ">No order history was loaded, so there is no outlook yet. Add calendar.csv, deliveries_train.csv and task1_test_inputs.csv to seed/data (see seed/data/README.md) and reseed an empty database.</Banner></main>;
  const reefer = o.fleet.find((f: any) => f.depot === depot && f.temp === 'reefer');
  const all = o.fleet.filter((f: any) => f.depot === depot).reduce((t: number, f: any) => t + f.volume_per_trip, 0);
  const weeks = series[0]?.forecast.map((f: any) => f.iso_week) ?? [];
  const sum = (w: number, key: string) => series.reduce((t: number, s: any) => t + (s.forecast.find((f: any) => f.iso_week === w)?.[key] ?? 0), 0);

  return (
    <main className="page stack">
      <div className="row spread">
        <h1>Capacity outlook · next 10 weeks</h1>
        <div className="seg" role="group" aria-label="Depot">
          {['Peliyagoda', 'Kandy'].map((d) => <button key={d} aria-pressed={depot === d} onClick={() => setDepot(d)}>{d}</button>)}
        </div>
      </div>
      <Banner tone="info" icon="ℹ">
        Baseline estimate, not a trained model: {series[0]?.method} The Datathon forecast will replace it. Demand counts every requested order once in the week it was requested, including deferred and never-run orders, so past capacity limits do not hide real demand.
      </Banner>
      <section className="card">
        <h2>Weekly demand vs fleet volume ({depot})</h2>
        <p className="muted small">Fleet volume per round of trips: {Math.round(all)} m³ all vehicles, {Math.round(reefer?.volume_per_trip ?? 0)} m³ refrigerated ({reefer?.vehicles ?? 0} vehicles). Weekly capacity depends on trips per day and operating days (Mon–Sat).</p>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead><tr><th>ISO week 2026</th>{weeks.map((w: number) => <th key={w} className="num">W{w}</th>)}</tr></thead>
            <tbody>
              {series.map((s: any) => (
                <tr key={s.brand}>
                  <td><strong>{s.brand}</strong> total m³</td>
                  {s.forecast.map((f: any) => <td key={f.iso_week} className="num">{f.total_volume_m3}</td>)}
                </tr>
              ))}
              <tr><td><strong>Fresh chilled</strong> m³</td>{weeks.map((w: number) => <td key={w} className="num">{sum(w, 'chilled_volume_m3').toFixed(1)}</td>)}</tr>
              <tr><td><strong>All brands</strong> m³</td>{weeks.map((w: number) => <td key={w} className="num"><strong>{sum(w, 'total_volume_m3').toFixed(0)}</strong></td>)}</tr>
              <tr>
                <td>Refrigerated trips needed / week<div className="muted small">chilled ÷ reefer volume per trip, at full loads</div></td>
                {weeks.map((w: number) => <td key={w} className="num">{reefer ? Math.ceil(sum(w, 'chilled_volume_m3') / (reefer.volume_per_trip / reefer.vehicles)) : '—'}</td>)}
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <h2>Recent history (last 16 weeks)</h2>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead><tr><th>Brand</th>{series[0]?.history.map((h: any) => <th key={`${h.iso_year}-${h.iso_week}`} className="num">{h.iso_year % 100}-W{h.iso_week}</th>)}</tr></thead>
            <tbody>{series.map((s: any) => <tr key={s.brand}><td>{s.brand}</td>{s.history.map((h: any) => <td key={`${h.iso_year}-${h.iso_week}`} className="num">{Math.round(h.total_volume_m3)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

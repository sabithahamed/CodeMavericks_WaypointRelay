import { toHHMM } from '../planner/time.js';
import { describePlan, latestPlan, loadPlanningInputs } from './planning.js';

/** The published plan for a day with schedules, keyed for quick lookup by order. */
export async function publishedView(dayId: number) {
  const p = await latestPlan(dayId, 'published');
  if (!p) return null;
  const { orders, ctx, day } = await loadPlanningInputs(dayId);
  const view = describePlan(p.data, orders, ctx);
  const byOrder = new Map<string, { vehicle_id: string; trip_no: number; seq: number; eta: string | null; depart: string | null }>();
  for (const t of view.trips) {
    t.order_ids.forEach((id, seq) => {
      const st = t.schedule?.stops.find((s) => s.order_id === id);
      byOrder.set(id, { vehicle_id: t.vehicle_id, trip_no: t.trip_no, seq, eta: st ? toHHMM(st.arrival_min) : null, depart: t.schedule ? toHHMM(t.schedule.depart_min) : null });
    });
  }
  const deferred = new Map(p.data.deferred.map((d: any) => [d.order_id, d]));
  return { version: p.version as number, published_at: p.published_at, view, byOrder, deferred, orders, ctx, day };
}

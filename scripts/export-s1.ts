// Exports the planner's S1 allocation in the Task 2B submission format, for cross-checking
// with the organisers' Dataset/check_allocation.py.  Usage: npx tsx scripts/export-s1.ts out.csv
import { writeFileSync } from 'node:fs';
import { allocate } from '../apps/server/src/planner/allocate.js';
import { loadS1 } from '../apps/server/src/seed/fixtures.js';

const { orders, ctx } = loadS1();
const plan = allocate(orders, ctx);
const where = new Map(plan.trips.flatMap((t) => t.order_ids.map((id) => [id, t] as const)));
const rows = orders.map((o) => {
  const t = where.get(o.id);
  return ['S1', o.id, o.outlet_id, t ? 'served' : 'deferred', t?.vehicle_id ?? '', t?.trip_no ?? ''].join(',');
});
writeFileSync(process.argv[2] ?? 's1.csv', ['scenario,order_ref,outlet_id,decision,vehicle_id,trip_id', ...rows].join('\n') + '\n');
const served = plan.trips.reduce((n, t) => n + t.order_ids.length, 0);
console.log(`served ${served}/${orders.length}, deferred ${plan.deferred.length}`);
for (const d of plan.deferred) console.log(`  ${d.order_id} [${d.code}] ${d.reason}`);

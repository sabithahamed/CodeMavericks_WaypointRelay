# Data model

The source of truth is `apps/server/src/schema.sql`. The design rule: **what was ordered, what was planned, what physically happened, whether proof reached the office, and what the store confirmed are separate records**, so no single "Delivered" flag hides a gap.

```mermaid
erDiagram
  outlets ||--o{ orders : "places"
  outlets ||--o| users : "store manager of"
  vehicles ||--o| users : "driven by"
  vehicles ||--o{ fuel_ledger : "week-to-date use"
  delivery_days ||--o{ orders : "requested for"
  delivery_days ||--o{ plans : "versions"
  delivery_days ||--o{ trip_runs : "published trips"
  trip_runs ||--o{ load_checks : "loader checks"
  orders ||--o{ load_checks : ""
  orders ||--o{ delivery_records : "driver records"
  orders ||--o| receipts : "store confirmation"
  orders ||--o{ exceptions : "needs decision"
  orders ||--o{ events : "activity record"
  districts ||--o{ outlets : ""

  outlets { text outlet_id PK  text brand  text district  text depot  text dock_type  text parking_constraint  text mall_window  text window_open_time  text window_close_time }
  vehicles { text vehicle_id PK  text type  text temp  numeric weight_cap_kg  numeric volume_cap_m3  numeric km_per_l  numeric weekly_fuel_quota_l  text depot }
  districts { text district PK  text depot  numeric depot_to_district_km  numeric depot_to_district_freeflow_min  numeric inter_stop_km  numeric inter_stop_freeflow_min }
  service_allowance { text brand PK  text dock_type PK  numeric service_allowance_min }
  users { int id PK  text email  text role  text depot  text outlet_id FK  text vehicle_id FK }
  delivery_days { int id PK  date delivery_date  text depot  text status  text_array workshop }
  orders { text id PK  int day_id FK  date requested_date  text outlet_id FK  text temp_requirement  int units  numeric weight_kg  numeric volume_m3  bool deferred_yesterday  int days_since_last_served  text status }
  plans { int id PK  int day_id FK  int version  text status  jsonb data "trips + deferrals"  timestamptz published_at }
  trip_runs { int day_id PK  text vehicle_id PK  int trip_no PK  int plan_version  text status  int loader_ack_version  int driver_ack_version }
  load_checks { text order_id PK  int expected_units  int loaded_units  text status }
  delivery_records { uuid client_id PK  text order_id FK  text outcome  int delivered_units  timestamptz recorded_at  timestamptz received_at  text proof_status  int plan_version }
  receipts { text order_id PK  text status  int received_units  timestamptz confirmed_at }
  exceptions { int id PK  text kind  text order_id FK  text message  text owner  text status  text resolution }
  events { bigint id PK  text order_id FK  text kind  text actor_role  text message  timestamptz at }
  fuel_ledger { text vehicle_id PK  int iso_year PK  int iso_week PK  numeric used_l }
  weekly_demand { text depot PK  text brand PK  int iso_year PK  int iso_week PK  numeric total_volume_m3  numeric chilled_volume_m3 }
  sync_log { uuid client_id PK  text kind }
```

## Notes

- **Plans are versioned documents** (`plans.data` = `{ trips: [{vehicle_id, trip_no, order_ids}], deferred: [{order_id, code, reason}] }`). A published version is never edited; changes create a new draft that must be reviewed and published.
- **Order status** (`confirmed → planned | deferred → loaded → en_route → delivered | partial | failed → received | issue`) is a convenience for lists. The underlying facts live in their own tables and the `events` log.
- **Fuel:** the source data gives weekly quotas, not balances, so `fuel_ledger` records week-to-date use. The planner checks round-trip litres against `quota − used`.
- **weekly_demand** is aggregated from the shared order history: every requested order counted once in its requested ISO week, including deferred and never-run orders. It feeds the D4 capacity outlook.
- **Outlet history contradictions** in S1 (two orders for one outlet with different `deferred_yesterday`) are preserved per order, not merged.

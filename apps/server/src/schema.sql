-- Waypoint Relay schema. Reference tables mirror the shared competition datasets;
-- operational tables keep the order, the plan, the physical outcome, the proof upload
-- and the store confirmation as separate records (see docs/data-model.md).

CREATE TABLE IF NOT EXISTS outlets (
  outlet_id text PRIMARY KEY, brand text NOT NULL, district text NOT NULL, depot text NOT NULL,
  dock_type text NOT NULL, parking_constraint text NOT NULL, mall_window text,
  window_open_time text NOT NULL, window_close_time text NOT NULL
);

CREATE TABLE IF NOT EXISTS vehicles (
  vehicle_id text PRIMARY KEY, type text NOT NULL, temp text NOT NULL,
  weight_cap_kg numeric NOT NULL, volume_cap_m3 numeric NOT NULL, fuel_type text,
  km_per_l numeric NOT NULL, weekly_fuel_quota_l numeric NOT NULL, depot text NOT NULL
);

CREATE TABLE IF NOT EXISTS districts (
  district text PRIMARY KEY, depot text NOT NULL, road_class text,
  depot_to_district_km numeric NOT NULL, depot_to_district_freeflow_min numeric NOT NULL,
  inter_stop_km numeric NOT NULL, inter_stop_freeflow_min numeric NOT NULL
);

CREATE TABLE IF NOT EXISTS service_allowance (
  brand text NOT NULL, dock_type text NOT NULL, service_allowance_min numeric NOT NULL,
  PRIMARY KEY (brand, dock_type)
);

CREATE TABLE IF NOT EXISTS weekly_demand (
  depot text NOT NULL, brand text NOT NULL, iso_year int NOT NULL, iso_week int NOT NULL,
  total_volume_m3 numeric NOT NULL, chilled_volume_m3 numeric NOT NULL, orders int NOT NULL,
  PRIMARY KEY (depot, brand, iso_year, iso_week)
);

CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY, email text UNIQUE NOT NULL, password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('dispatcher','loader','driver','store')),
  name text NOT NULL, depot text, outlet_id text REFERENCES outlets, vehicle_id text REFERENCES vehicles
);

-- One planning day per depot. 'open' accepts orders; 'closed' is the dispatcher's cutoff.
CREATE TABLE IF NOT EXISTS delivery_days (
  id serial PRIMARY KEY, delivery_date date NOT NULL, depot text NOT NULL, label text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_at timestamptz,
  workshop text[] NOT NULL DEFAULT '{}', -- vehicles unavailable that day
  UNIQUE (delivery_date, depot)
);

CREATE TABLE IF NOT EXISTS orders (
  id text PRIMARY KEY, day_id int NOT NULL REFERENCES delivery_days,
  requested_date date NOT NULL, outlet_id text NOT NULL REFERENCES outlets,
  temp_requirement text NOT NULL CHECK (temp_requirement IN ('chilled','ambient')),
  units int NOT NULL, weight_kg numeric NOT NULL, volume_m3 numeric NOT NULL,
  lines jsonb, deferred_yesterday boolean NOT NULL DEFAULT false, days_since_last_served int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'confirmed', source text NOT NULL DEFAULT 'seed',
  created_at timestamptz NOT NULL DEFAULT now(), created_by int REFERENCES users
);
CREATE INDEX IF NOT EXISTS orders_day ON orders(day_id);
CREATE INDEX IF NOT EXISTS orders_outlet ON orders(outlet_id);

-- Plans are versioned documents ({trips, deferred}); a published version is never edited.
CREATE TABLE IF NOT EXISTS plans (
  id serial PRIMARY KEY, day_id int NOT NULL REFERENCES delivery_days, version int NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','published')),
  data jsonb NOT NULL, note text, created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz, published_by int REFERENCES users,
  UNIQUE (day_id, version)
);

-- Dock and road state of each published trip.
CREATE TABLE IF NOT EXISTS trip_runs (
  day_id int NOT NULL REFERENCES delivery_days, vehicle_id text NOT NULL REFERENCES vehicles, trip_no int NOT NULL,
  plan_version int NOT NULL,
  status text NOT NULL DEFAULT 'to_load' CHECK (status IN ('to_load','loading','held','released','en_route','completed')),
  loader_ack_version int, driver_ack_version int, released_at timestamptz,
  PRIMARY KEY (day_id, vehicle_id, trip_no)
);

CREATE TABLE IF NOT EXISTS load_checks (
  day_id int NOT NULL, vehicle_id text NOT NULL, trip_no int NOT NULL, order_id text NOT NULL REFERENCES orders,
  expected_units int NOT NULL, loaded_units int NOT NULL,
  status text NOT NULL CHECK (status IN ('ok','short','damaged')), note text,
  checked_by int REFERENCES users, checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day_id, vehicle_id, trip_no, order_id)
);

-- Driver records. client_id is generated on the phone so retries are idempotent.
CREATE TABLE IF NOT EXISTS delivery_records (
  client_id uuid PRIMARY KEY, order_id text NOT NULL REFERENCES orders,
  vehicle_id text NOT NULL, trip_no int NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('delivered','partial','failed')),
  delivered_units int NOT NULL, condition text, recipient text, note text,
  arrived_at text, recorded_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  plan_version int, proof_status text NOT NULL DEFAULT 'none' CHECK (proof_status IN ('none','pending','uploaded')),
  photo text, driver_id int REFERENCES users
);
CREATE INDEX IF NOT EXISTS delivery_records_order ON delivery_records(order_id);

CREATE TABLE IF NOT EXISTS receipts (
  order_id text PRIMARY KEY REFERENCES orders,
  status text NOT NULL CHECK (status IN ('confirmed','issue')),
  received_units int NOT NULL, note text, confirmed_by int REFERENCES users, confirmed_at timestamptz NOT NULL DEFAULT now()
);

-- Anything that needs a human decision, with an owner and a resolution.
CREATE TABLE IF NOT EXISTS exceptions (
  id serial PRIMARY KEY, day_id int REFERENCES delivery_days, order_id text REFERENCES orders,
  vehicle_id text, trip_no int,
  kind text NOT NULL CHECK (kind IN ('loading_shortfall','delivery_issue','receipt_issue','sync_conflict')),
  message text NOT NULL, owner text NOT NULL DEFAULT 'dispatcher',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution text, raised_by int REFERENCES users, created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);

-- Append-only activity record shared by every role.
CREATE TABLE IF NOT EXISTS events (
  id bigserial PRIMARY KEY, order_id text REFERENCES orders, day_id int REFERENCES delivery_days,
  kind text NOT NULL, actor_role text NOT NULL, actor_name text NOT NULL, message text NOT NULL,
  data jsonb, at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_order ON events(order_id);

-- Week-to-date fuel already used (the source data gives quotas, not balances).
CREATE TABLE IF NOT EXISTS fuel_ledger (
  vehicle_id text NOT NULL REFERENCES vehicles, iso_year int NOT NULL, iso_week int NOT NULL, used_l numeric NOT NULL,
  PRIMARY KEY (vehicle_id, iso_year, iso_week)
);

-- Processed outbox items from phones (idempotency for ack/depart/delivery uploads).
CREATE TABLE IF NOT EXISTS sync_log (
  client_id uuid PRIMARY KEY, kind text NOT NULL, user_id int REFERENCES users, at timestamptz NOT NULL DEFAULT now()
);

-- Snapshot of the seeded scenario so "Reset demo day" works without the source files.
CREATE TABLE IF NOT EXISTS scenario_orders (
  order_ref text PRIMARY KEY, outlet_id text NOT NULL REFERENCES outlets, temp_requirement text NOT NULL,
  units int NOT NULL, weight_kg numeric NOT NULL, volume_m3 numeric NOT NULL,
  deferred_yesterday boolean NOT NULL, days_since_last_served int NOT NULL
);
CREATE TABLE IF NOT EXISTS scenario_fleet (
  vehicle_id text PRIMARY KEY REFERENCES vehicles, status text NOT NULL
);

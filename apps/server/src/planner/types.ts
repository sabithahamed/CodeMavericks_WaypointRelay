export type Brand = 'Fresh' | 'Style' | 'Tech';
export type Temp = 'chilled' | 'ambient';

export interface Outlet {
  outlet_id: string;
  brand: Brand;
  district: string;
  depot: string;
  dock_type: 'rear_dock' | 'street' | 'mall_bay';
  parking_constraint: 'normal' | 'van_only' | 'mall_dock';
  mall_window: string | null;
  window_open_time: string;
  window_close_time: string;
}

export interface Vehicle {
  vehicle_id: string;
  type: 'truck' | 'van';
  temp: 'reefer' | 'ambient';
  weight_cap_kg: number;
  volume_cap_m3: number;
  km_per_l: number;
  weekly_fuel_quota_l: number;
  depot: string;
}

export interface District {
  district: string;
  depot: string;
  depot_to_district_km: number;
  depot_to_district_freeflow_min: number;
  inter_stop_km: number;
  inter_stop_freeflow_min: number;
}

/** An order as the planner sees it: the order row joined with its outlet. */
export interface PlanOrder {
  id: string;
  outlet_id: string;
  brand: Brand;
  district: string;
  depot: string;
  temp_requirement: Temp;
  units: number;
  weight_kg: number;
  volume_m3: number;
  dock_type: Outlet['dock_type'];
  parking_constraint: Outlet['parking_constraint'];
  window_open: string;
  window_close: string;
  deferred_yesterday: boolean;
  days_since_last_served: number;
}

export interface PlanningContext {
  vehicles: Record<string, Vehicle>;
  districts: Record<string, District>;
  /** key: `${brand}|${dock_type}` */
  allowance: Record<string, number>;
  /** vehicles that may be used on the day */
  available: Set<string>;
  /** litres still unused in the vehicle's weekly quota */
  fuelRemaining: Record<string, number>;
}

export interface Trip {
  vehicle_id: string;
  trip_no: 1 | 2;
  /** order ids in stop sequence */
  order_ids: string[];
}

export type DeferralCode =
  | 'exceeds_vehicle_capacity'
  | 'no_compatible_vehicle'
  | 'capacity_shortage'
  | 'dispatcher_choice';

export interface Deferral {
  order_id: string;
  code: DeferralCode;
  reason: string;
}

export interface Plan {
  trips: Trip[];
  deferred: Deferral[];
}

export interface Violation {
  rule: string;
  message: string;
  vehicle_id?: string;
  trip_no?: number;
  order_id?: string;
}

export interface StopEta {
  order_id: string;
  outlet_id: string;
  arrival_min: number;
  service_start_min: number;
  depart_min: number;
  window_close_min: number;
  late: boolean;
}

export interface TripSchedule {
  vehicle_id: string;
  trip_no: number;
  depart_min: number;
  return_min: number;
  stops: StopEta[];
}

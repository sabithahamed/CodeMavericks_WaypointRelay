/** Clock helpers. All planning times are minutes after midnight, Asia/Colombo. */
export const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export const toHHMM = (min: number): string => {
  const m = Math.round(min);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** Fresh runs in the pre-dawn window, Style and Tech in the trading day (booklet Task 2B). */
export const FRESH_START = toMin('03:30');
export const DAYTIME_START = toMin('08:00');
export const FRESH_BUDGET_MIN = 270;
export const DAYTIME_BUDGET_MIN = 480;
export const MAX_TRIPS = 2;
/** Proposed operational reload time between trips (documented assumption). */
export const RELOAD_MIN = 15;

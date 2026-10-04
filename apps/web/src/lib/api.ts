const TOKEN_KEY = 'relay.token';

export const getToken = () => {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
};
export const setToken = (t: string | null) => {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ }
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: any) { super(message); }
}

/** Set by the driver's "simulate no signal" switch so judges can test offline without airplane mode. */
export const network = {
  simulatedOffline: (() => { try { return localStorage.getItem('relay.simOffline') === '1'; } catch { return false; } })(),
  isOnline() { return !this.simulatedOffline && navigator.onLine; },
};

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  if (network.simulatedOffline) throw new ApiError(0, 'No connection (simulated).', null);
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? (opts.body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'No connection to Waypoint Relay.', null);
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/auth/login') {
    setToken(null);
    window.location.assign('/login');
  }
  if (!res.ok) throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`, body);
  return body as T;
}

export const fmtTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit' }) : '—';
export const fmtDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Colombo', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
export const fmtDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
}));

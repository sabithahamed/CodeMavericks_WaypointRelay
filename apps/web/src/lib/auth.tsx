import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getToken, setToken } from './api';

export type Role = 'dispatcher' | 'loader' | 'driver' | 'store';
export interface User { id: number; email: string; role: Role; name: string; depot: string | null; outlet_id: string | null; vehicle_id: string | null }

interface AuthState { user: User | null; ready: boolean; login(email: string, password: string): Promise<User>; logout(): void }
const Ctx = createContext<AuthState>(null!);
const USER_KEY = 'relay.user';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    try { return getToken() ? JSON.parse(localStorage.getItem(USER_KEY) ?? 'null') : null; } catch { return null; }
  });
  const [ready, setReady] = useState(true);
  useEffect(() => {
    if (!getToken()) return;
    // Refresh the profile when online; keep the cached profile when offline (driver use).
    api<{ user: User }>('/me').then((r) => { setUser(r.user); try { localStorage.setItem(USER_KEY, JSON.stringify(r.user)); } catch { /* ignore */ } }).catch(() => undefined).finally(() => setReady(true));
  }, []);
  const value: AuthState = {
    user,
    ready,
    async login(email, password) {
      const r = await api<{ token: string; user: User }>('/auth/login', { body: { email, password } });
      setToken(r.token);
      try { localStorage.setItem(USER_KEY, JSON.stringify(r.user)); } catch { /* ignore */ }
      setUser(r.user);
      return r.user;
    },
    logout() {
      setToken(null);
      try { localStorage.removeItem(USER_KEY); } catch { /* ignore */ }
      setUser(null);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
export const HOME: Record<Role, string> = { dispatcher: '/dispatch', loader: '/loader', driver: '/driver', store: '/store' };

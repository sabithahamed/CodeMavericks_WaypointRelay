import type { ReactNode } from 'react';

type Tone = 'ok' | 'attention' | 'block' | 'info' | 'action' | 'neutral';

export function Chip({ tone = 'neutral', icon, children }: { tone?: Tone; icon?: string; children: ReactNode }) {
  return <span className={`chip ${tone}`}>{icon && <span aria-hidden>{icon}</span>}{children}</span>;
}

export function Banner({ tone, icon, children, role }: { tone: Exclude<Tone, 'neutral' | 'action'>; icon: string; children: ReactNode; role?: string }) {
  return (
    <div className={`banner ${tone}`} role={role ?? (tone === 'block' ? 'alert' : 'status')}>
      <span className="icon" aria-hidden>{icon}</span>
      <div className="grow">{children}</div>
    </div>
  );
}

/** One shared vocabulary for order states across every role. */
export const ORDER_STATUS: Record<string, { label: string; tone: Tone; icon: string }> = {
  confirmed: { label: 'Confirmed', tone: 'info', icon: '✓' },
  planned: { label: 'Planned', tone: 'action', icon: '▣' },
  deferred: { label: 'Deferred', tone: 'attention', icon: '⏸' },
  loaded: { label: 'Loaded', tone: 'action', icon: '▤' },
  en_route: { label: 'On the way', tone: 'action', icon: '➜' },
  delivered: { label: 'Delivered · awaiting store', tone: 'ok', icon: '✓' },
  partial: { label: 'Partly delivered', tone: 'attention', icon: '◐' },
  failed: { label: 'Not delivered', tone: 'block', icon: '✕' },
  received: { label: 'Receipt confirmed', tone: 'ok', icon: '✔' },
  issue: { label: 'Issue reported', tone: 'block', icon: '!' },
};

export function StatusChip({ status }: { status: string }) {
  const s = ORDER_STATUS[status] ?? { label: status, tone: 'neutral' as Tone, icon: '•' };
  return <Chip tone={s.tone} icon={s.icon}>{s.label}</Chip>;
}

export const TRIP_STATUS: Record<string, { label: string; tone: Tone; icon: string }> = {
  to_load: { label: 'To load', tone: 'info', icon: '○' },
  loading: { label: 'Loading', tone: 'action', icon: '◔' },
  held: { label: 'Held · shortfall', tone: 'block', icon: '⏸' },
  released: { label: 'Released', tone: 'ok', icon: '✓' },
  en_route: { label: 'On the road', tone: 'action', icon: '➜' },
  completed: { label: 'All stops recorded', tone: 'ok', icon: '✔' },
};

export function TripChip({ status }: { status: string }) {
  const s = TRIP_STATUS[status] ?? { label: status, tone: 'neutral' as Tone, icon: '•' };
  return <Chip tone={s.tone} icon={s.icon}>{s.label}</Chip>;
}

export function TempChip({ temp }: { temp: string }) {
  return temp === 'chilled' ? <Chip tone="info" icon="❄">Chilled</Chip> : <Chip icon="▢">Ambient</Chip>;
}

export function Meter({ label, used, cap, unit }: { label: string; used: number; cap: number; unit: string }) {
  const pct = cap > 0 ? (used / cap) * 100 : 0;
  const cls = pct > 100 ? 'over' : pct > 90 ? 'high' : '';
  return (
    <div className="meter" aria-label={`${label} ${used} of ${cap} ${unit}`}>
      <span className="muted">{label}</span>
      <span className="bar"><span className={cls} style={{ width: `${Math.min(100, pct)}%` }} /></span>
      <span className="num">{used.toLocaleString()} / {cap.toLocaleString()} {unit}</span>
    </div>
  );
}

export function Loading() {
  return <p className="muted" role="status">Loading…</p>;
}

export function ErrorNote({ error }: { error: string | null }) {
  return error ? <Banner tone="block" icon="!">{error}</Banner> : null;
}

export function Timeline({ events }: { events: { id: number; at: string; actor_role: string; actor_name: string; message: string }[] }) {
  if (!events.length) return <p className="muted small">No activity yet.</p>;
  return (
    <ol className="timeline">
      {events.map((e) => (
        <li key={e.id}>
          <div className="t">{new Date(e.at).toLocaleString('en-GB', { timeZone: 'Asia/Colombo', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {e.actor_role === 'system' ? 'System' : `${e.actor_name} (${e.actor_role})`}</div>
          <div>{e.message}</div>
        </li>
      ))}
    </ol>
  );
}

import { createStore, get, set } from 'idb-keyval';
import { api, network, uuid } from './api';

/**
 * Driver offline store. The run sheet and every unsent record live in IndexedDB on the phone.
 * A record is shown as "Saved on this phone" only after the IndexedDB write has resolved,
 * and as "Uploaded" only after the server acknowledges its client_id.
 */
const db = createStore('waypoint-relay', 'driver');

export type OutboxItem =
  | { kind: 'ack' | 'depart'; client_id: string; recorded_at: string; trip_no: number; plan_version: number; state: ItemState; message?: string }
  | ({ kind: 'delivery'; client_id: string; recorded_at: string; trip_no: number; plan_version: number; order_id: string; outcome: 'delivered' | 'partial' | 'failed'; delivered_units: number; condition?: string; recipient?: string; note?: string; arrived_at?: string; has_photo: boolean; state: ItemState; message?: string })
  | { kind: 'proof'; client_id: string; recorded_at: string; delivery_client_id: string; order_id: string; photo: string; state: ItemState; message?: string };

export type ItemState = 'saved' | 'uploading' | 'uploaded' | 'conflict' | 'failed';

const listeners = new Set<() => void>();
export const onOutboxChange = (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((f) => f());

export const getOutbox = async (): Promise<OutboxItem[]> => (await get<OutboxItem[]>('outbox', db)) ?? [];
const putOutbox = async (items: OutboxItem[]) => { await set('outbox', items, db); emit(); };

export const getRun = () => get<any>('run', db);
export const saveRun = (run: any) => set('run', run, db);

/** Durably saves a new record; throws if the phone could not store it. */
export async function enqueue(item: Omit<OutboxItem, 'client_id' | 'recorded_at' | 'state'> & { client_id?: string }): Promise<OutboxItem> {
  const full = { ...item, client_id: item.client_id ?? uuid(), recorded_at: new Date().toISOString(), state: 'saved' } as OutboxItem;
  const items = await getOutbox();
  await putOutbox([...items, full]);
  void sync();
  return full;
}

let syncing = false;
/** Uploads pending items in order. Safe to call repeatedly: the server deduplicates by client_id. */
export async function sync(): Promise<{ sent: number; pending: number }> {
  if (syncing || !network.isOnline()) return { sent: 0, pending: (await getOutbox()).filter((i) => i.state !== 'uploaded').length };
  syncing = true;
  try {
    const items = await getOutbox();
    // Records first, then photos, so a large photo never blocks the delivery facts.
    const pending = items.filter((i) => i.state === 'saved' || i.state === 'failed' || i.state === 'uploading');
    const records = pending.filter((i) => i.kind !== 'proof');
    const proofs = pending.filter((i) => i.kind === 'proof');
    let sent = 0;
    for (const batch of [records, ...proofs.map((p) => [p])]) {
      if (batch.length === 0) continue;
      const payload = batch.map(({ state, message, ...rest }) => {
        const { order_id, ...proofRest } = rest as any;
        return rest.kind === 'proof' ? proofRest : rest;
      });
      try {
        const r = await api<{ results: { client_id: string; result: string; message?: string }[] }>('/driver/sync', { body: { items: payload } });
        const latest = await getOutbox();
        for (const res of r.results) {
          const it = latest.find((x) => x.client_id === res.client_id);
          if (!it) continue;
          it.state = res.result === 'accepted' || res.result === 'duplicate' ? 'uploaded' : res.result === 'conflict' ? 'conflict' : 'failed';
          it.message = res.message;
          if (it.state !== 'failed') sent++;
        }
        await putOutbox(latest);
      } catch (e: any) {
        const latest = await getOutbox();
        for (const b of batch) {
          const it = latest.find((x) => x.client_id === b.client_id);
          if (it) { it.state = 'failed'; it.message = e.message; }
        }
        await putOutbox(latest);
        break;
      }
    }
    return { sent, pending: (await getOutbox()).filter((i) => i.state === 'saved' || i.state === 'failed').length };
  } finally {
    syncing = false;
  }
}

/** Shrinks a camera photo so it fits comfortably in local storage and on a weak connection. */
export function compressPhoto(file: File, max = 900): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => reject(new Error('Could not read that photo.'));
    img.src = URL.createObjectURL(file);
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void sync());
}

/**
 * On-device storage for route recordings.
 *
 * A recording ride lasts an hour on a bus with no reliable signal, on a phone
 * that may lock, background the tab, or run out of memory. So nothing is held
 * in RAM and nothing is uploaded: every fix is appended to IndexedDB in small
 * batches. Kill the tab mid-ride and the recording is still on the phone.
 */

const DB_NAME = 'campusbus-recorder';
const DB_VERSION = 1;

export interface Fix {
  t: number;      // epoch ms
  lat: number;
  lng: number;
  spd: number | null;
  acc: number | null;
  alt: number | null;
  heading: number | null;
}

export interface Marker {
  t: number;
  lat: number;
  lng: number;
  label: string;
  /** Metres of GPS uncertainty when the flag was made, if the phone said. */
  acc?: number | null;
}

/** A marker as stored, carrying the key needed to rename or remove it. */
export interface StoredMarker extends Marker {
  key: number;
}

export interface Session {
  id: string;
  name: string;
  startedAt: number;
  endedAt: number | null;
  fixCount: number;
  markerCount: number;
  distanceM: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('fixes')) {
        const s = db.createObjectStore('fixes', { autoIncrement: true });
        s.createIndex('session', 'sessionId');
      }
      if (!db.objectStoreNames.contains('markers')) {
        const s = db.createObjectStore('markers', { autoIncrement: true });
        s.createIndex('session', 'sessionId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function createSession(name: string): Promise<Session> {
  const db = await open();
  const session: Session = {
    id: `rec-${Date.now()}`,
    name,
    startedAt: Date.now(),
    endedAt: null,
    fixCount: 0,
    markerCount: 0,
    distanceM: 0,
  };
  const tx = db.transaction('sessions', 'readwrite');
  tx.objectStore('sessions').put(session);
  await done(tx);
  db.close();
  return session;
}

/** Append a batch of fixes and update the session counters in one transaction. */
export async function appendFixes(sessionId: string, fixes: Fix[], patch: Partial<Session>) {
  if (!fixes.length && !Object.keys(patch).length) return;
  const db = await open();
  const tx = db.transaction(['fixes', 'sessions'], 'readwrite');
  const store = tx.objectStore('fixes');
  for (const f of fixes) store.add({ sessionId, ...f });

  const sessions = tx.objectStore('sessions');
  const get = sessions.get(sessionId);
  get.onsuccess = () => {
    const s = get.result as Session | undefined;
    if (s) sessions.put({ ...s, ...patch });
  };
  await done(tx);
  db.close();
}

export async function addMarker(sessionId: string, marker: Marker) {
  const db = await open();
  const tx = db.transaction(['markers', 'sessions'], 'readwrite');
  tx.objectStore('markers').add({ sessionId, ...marker });
  const sessions = tx.objectStore('sessions');
  const get = sessions.get(sessionId);
  get.onsuccess = () => {
    const s = get.result as Session | undefined;
    if (s) sessions.put({ ...s, markerCount: s.markerCount + 1 });
  };
  await done(tx);
  db.close();
}

/**
 * The marks made during a session, oldest first.
 *
 * Returned with their IndexedDB keys, because a mark made on a moving bus is
 * provisional: it needs a name adding later, and a mis-tap needs removing.
 */
export async function listMarkers(sessionId: string): Promise<StoredMarker[]> {
  const db = await open();
  const tx = db.transaction('markers', 'readonly');
  const store = tx.objectStore('markers').index('session');
  const req = store.openCursor(IDBKeyRange.only(sessionId));
  const out: StoredMarker[] = [];
  req.onsuccess = () => {
    const cur = req.result;
    if (!cur) return;
    const v = cur.value as Marker & { sessionId: string };
    out.push({ key: cur.primaryKey as number, t: v.t, lat: v.lat, lng: v.lng, label: v.label, acc: v.acc ?? null });
    cur.continue();
  };
  await done(tx);
  db.close();
  return out.sort((a, b) => a.t - b.t);
}

/** Name a mark after the fact — the whole point of marking with one tap. */
export async function renameMarker(key: number, label: string) {
  const db = await open();
  const tx = db.transaction('markers', 'readwrite');
  const store = tx.objectStore('markers');
  const get = store.get(key);
  get.onsuccess = () => {
    if (get.result) store.put({ ...get.result, label }, key);
  };
  await done(tx);
  db.close();
}

/** Undo a mis-tap. Keeps the session's marker count honest. */
export async function deleteMarker(key: number, sessionId: string) {
  const db = await open();
  const tx = db.transaction(['markers', 'sessions'], 'readwrite');
  tx.objectStore('markers').delete(key);
  const sessions = tx.objectStore('sessions');
  const get = sessions.get(sessionId);
  get.onsuccess = () => {
    const s = get.result as Session | undefined;
    if (s) sessions.put({ ...s, markerCount: Math.max(0, s.markerCount - 1) });
  };
  await done(tx);
  db.close();
}

export async function listSessions(): Promise<Session[]> {
  const db = await open();
  const tx = db.transaction('sessions', 'readonly');
  const req = tx.objectStore('sessions').getAll();
  await done(tx);
  db.close();
  return (req.result as Session[]).sort((a, b) => b.startedAt - a.startedAt);
}

async function byIndex<T>(db: IDBDatabase, store: string, sessionId: string): Promise<T[]> {
  const tx = db.transaction(store, 'readonly');
  const req = tx.objectStore(store).index('session').getAll(sessionId);
  await done(tx);
  return req.result as T[];
}

export async function exportSession(sessionId: string) {
  const db = await open();
  const tx = db.transaction('sessions', 'readonly');
  const sReq = tx.objectStore('sessions').get(sessionId);
  await done(tx);
  const session = sReq.result as Session;

  const fixes = await byIndex<Fix & { sessionId: string }>(db, 'fixes', sessionId);
  const markers = await byIndex<Marker & { sessionId: string }>(db, 'markers', sessionId);
  db.close();

  return {
    format: 'campusbus-trace/1',
    session,
    markers: markers
      .map(({ sessionId: _s, ...m }) => m)
      .sort((a, b) => a.t - b.t),
    fixes: fixes
      .map(({ sessionId: _s, ...f }) => f)
      .sort((a, b) => a.t - b.t),
  };
}

export async function deleteSession(sessionId: string) {
  const db = await open();
  for (const store of ['fixes', 'markers'] as const) {
    const tx = db.transaction(store, 'readwrite');
    const idx = tx.objectStore(store).index('session');
    const req = idx.openCursor(IDBKeyRange.only(sessionId));
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) { cur.delete(); cur.continue(); }
    };
    await done(tx);
  }
  const tx = db.transaction('sessions', 'readwrite');
  tx.objectStore('sessions').delete(sessionId);
  await done(tx);
  db.close();
}

/** Rough storage headroom, so a long ride never fails silently. */
export async function storageEstimate(): Promise<{ usedMB: number; quotaMB: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  return {
    usedMB: Math.round(((e.usage ?? 0) / 1048576) * 10) / 10,
    quotaMB: Math.round((e.quota ?? 0) / 1048576),
  };
}

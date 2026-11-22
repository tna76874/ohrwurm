// Lokale Datenhaltung in IndexedDB. Jedes Gerät hält eine vollständige Kopie des
// Op-Logs seiner Sitzungen. Nichts davon verlässt das Gerät unverschlüsselt.
import type { Op } from './types';

type StoreName = 'kv' | 'ops';
let dbp: Promise<IDBDatabase> | undefined;

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('ohrwurm', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const old of ['segments', 'outbox']) if (d.objectStoreNames.contains(old)) d.deleteObjectStore(old);
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('ops')) d.createObjectStore('ops', { keyPath: 'id' }).createIndex('sid', 'sid');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

async function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  const d = await db();
  return new Promise<T>((resolve, reject) => {
    const tx = d.transaction(store, mode);
    let result: unknown;
    const req = fn(tx.objectStore(store));
    if (req) req.onsuccess = () => (result = req.result);
    tx.oncomplete = () => resolve(result as T);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const kv = {
  get: <T>(key: string) => run<T | undefined>('kv', 'readonly', (s) => s.get(key)),
  set: (key: string, value: unknown) => run<void>('kv', 'readwrite', (s) => s.put(value, key)),
  del: (key: string) => run<void>('kv', 'readwrite', (s) => s.delete(key)),
  keys: async () => (await run<IDBValidKey[]>('kv', 'readonly', (s) => s.getAllKeys())).map(String),
};

interface StoredOp {
  id: string;
  sid: string;
  op: Op;
}

export const opStore = {
  putMany: (sid: string, ops: Op[]) =>
    run<void>('ops', 'readwrite', (s) => {
      for (const op of ops) s.put({ id: `${sid}|${op.a}|${op.s}`, sid, op } satisfies StoredOp);
    }),
  all: async (sid: string) => (await run<StoredOp[]>('ops', 'readonly', (s) => s.index('sid').getAll(sid))).map((r) => r.op),
  count: (sid: string) => run<number>('ops', 'readonly', (s) => s.index('sid').count(sid)),
  clear: (sid: string) =>
    run<void>('ops', 'readwrite', (s) => {
      const c = s.index('sid').openKeyCursor(IDBKeyRange.only(sid));
      c.onsuccess = () => {
        const cur = c.result;
        if (cur) {
          s.delete(cur.primaryKey);
          cur.continue();
        }
      };
    }),
};

export async function deleteSessionData(sid: string) {
  await kv.del(`mesh:${sid}`);
  await opStore.clear(sid);
}

/** Bittet den Browser, die Daten nicht bei Speicherdruck zu löschen. */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

"use client";

// A local-first write queue for field mode: when there's no connectivity,
// mission actions (snapshots, clips, telemetry readings) get written here
// instead of failing outright. Nothing in this file talks to the
// network — that's the sync engine's job (not yet built). This is purely
// the local storage layer underneath it.
//
// One object store ("queue"), not one per data kind, so the eventual sync
// engine can walk a single store in creation order rather than
// coordinating across several — a snapshot taken before a clip should
// sync before it, and a single ordered store makes that free.

const DB_NAME = "telesto-offline";
const DB_VERSION = 1;
const STORE_NAME = "queue";

function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB isn't available in this environment"));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("by-kind", "kind", { unique: false });
        store.createIndex("by-createdAt", "createdAt", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function newId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Queues a mission action for later sync. `kind` is a string like
 * "snapshot" | "clip" | "telemetry" — the sync engine (next phase) will
 * dispatch on this to know which backend endpoint to replay it against.
 * `payload` is plain JSON (telemetry readings, snapshot metadata, etc.);
 * `blob`, if given, is the actual image/video binary — IndexedDB stores
 * Blobs natively, no base64 round-trip needed.
 *
 * Returns the queued item's id.
 */
export async function enqueue(kind, payload, blob = null) {
  const db = await openDB();
  const item = {
    id: newId(),
    kind,
    payload,
    blob,
    createdAt: new Date().toISOString(),
    synced: false,
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).add(item);
    tx.oncomplete = () => resolve(item.id);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Lists queued items in creation order, optionally filtered to a single
 * kind. Defaults to unsynced items only — pass includeSynced=true to
 * also see ones already pushed to the backend (kept around rather than
 * deleted immediately, so a "recently synced" UI state is possible).
 */
export async function listQueued(kind = null, includeSynced = false) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const source = kind ? store.index("by-kind").getAll(kind) : store.getAll();

    source.onsuccess = () => {
      let items = source.result.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      if (!includeSynced) items = items.filter((item) => !item.synced);
      resolve(items);
    };
    source.onerror = () => reject(source.error);
  });
}

export async function countPending(kind = null) {
  const items = await listQueued(kind, false);
  return items.length;
}

/** Marks an item as synced without deleting it, so a "recently synced"
 * view is possible later. Use removeItem to actually clear it out. */
export async function markSynced(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const getRequest = store.get(id);

    getRequest.onsuccess = () => {
      const item = getRequest.result;
      if (!item) {
        resolve(false);
        return;
      }
      item.synced = true;
      store.put(item);
    };
    getRequest.onerror = () => reject(getRequest.error);

    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function removeItem(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

/** Deletes every item already marked synced. Safe to call periodically
 * to keep the local database from growing forever. */
export async function clearSynced() {
  const items = await listQueued(null, true);
  const synced = items.filter((item) => item.synced);
  await Promise.all(synced.map((item) => removeItem(item.id)));
  return synced.length;
}
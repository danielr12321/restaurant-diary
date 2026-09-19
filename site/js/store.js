/* Everything the diary keeps on this device.

   Local-first: every change is saved here first and queued, so the diary opens
   instantly and keeps working offline. The sync (cloud.js) sends the queue to
   the shared diary and brings in the other devices' edits. */

const ITEMS_KEY = "diary:items";
const OUTBOX_KEY = "diary:outbox";
const PHOTO_OUTBOX_KEY = "diary:photo-outbox";

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    return false;
  }
}

export function readSetting(key, fallback) {
  return read("diary:" + key, fallback);
}

export function writeSetting(key, value) {
  if (value === undefined || value === null) {
    try { localStorage.removeItem("diary:" + key); } catch (err) { /* private mode */ }
    return;
  }
  write("diary:" + key, value);
}

export function newId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "");
  let id = "";
  while (id.length < 32) id += Math.floor(Math.random() * 16).toString(16);
  return id;
}

export const nowIso = () => new Date().toISOString();
const time = (iso) => Date.parse(iso || "") || 0;

const listeners = new Set();

export const store = {
  items: read(ITEMS_KEY, []),
  // {id, deleted, updatedAt}: restaurants changed here and not yet sent
  outbox: read(OUTBOX_KEY, []),
  // {itemId, name, op: "upload" | "delete"}: photo files not yet sent or removed
  photoOutbox: read(PHOTO_OUTBOX_KEY, []),
  storageFull: false,

  get(id) {
    return this.items.find((item) => item.id === id) || null;
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

function emit(reason) {
  listeners.forEach((fn) => {
    try {
      fn(reason);
    } catch (err) {
      console.error(err);
    }
  });
}

function persist() {
  const ok = write(ITEMS_KEY, store.items) && write(OUTBOX_KEY, store.outbox);
  store.storageFull = !ok;
}

function queue(id, deleted, updatedAt) {
  store.outbox = store.outbox.filter((entry) => entry.id !== id);
  store.outbox.push({ id, deleted, updatedAt });
}

/** Insert or replace a whole restaurant. */
export function saveItem(item) {
  const stamped = { ...item, updated_at: nowIso() };
  const index = store.items.findIndex((existing) => existing.id === item.id);
  if (index >= 0) store.items[index] = stamped;
  else store.items.push(stamped);
  queue(item.id, false, stamped.updated_at);
  persist();
  emit("local");
  return stamped;
}

/** Change some fields; a field set to undefined is removed. */
export function updateItem(id, changes) {
  const item = store.get(id);
  if (!item) return null;
  const next = { ...item, ...changes };
  Object.keys(changes).forEach((key) => {
    if (changes[key] === undefined) delete next[key];
  });
  return saveItem(next);
}

export function deleteItem(id) {
  const item = store.get(id);
  store.items = store.items.filter((existing) => existing.id !== id);
  queue(id, true, nowIso());
  ((item && item.photos) || []).forEach((name) => forgetPhoto(id, name));
  persist();
  emit("local");
}

/** Other devices' changes. Per restaurant, the newer edit wins. */
export function applyRemote(rows) {
  let changed = false;
  rows.forEach((row) => {
    const id = row.item_id;
    const pending = store.outbox.find((entry) => entry.id === id);
    if (pending) {
      if (time(pending.updatedAt) > time(row.updated_at)) return; // ours is newer and will be sent
      store.outbox = store.outbox.filter((entry) => entry.id !== id);
    }
    const index = store.items.findIndex((item) => item.id === id);
    if (row.deleted) {
      if (index >= 0) {
        store.items.splice(index, 1);
        changed = true;
      }
      return;
    }
    if (!row.data) return;
    const item = { ...row.data, id, updated_at: row.updated_at };
    if (index >= 0) store.items[index] = item;
    else store.items.push(item);
    changed = true;
  });
  persist();
  if (changed) emit("remote");
  return changed;
}

/** Everything on this device goes to a diary that's being shared or joined. */
export async function queueEverything() {
  store.items.forEach((item) => {
    if (!store.outbox.some((entry) => entry.id === item.id)) {
      store.outbox.push({ id: item.id, deleted: false, updatedAt: item.updated_at || nowIso() });
    }
  });
  const stored = new Set(await photoNames());
  store.items.forEach((item) => {
    (item.photos || []).forEach((name) => {
      if (stored.has(name)) queuePhoto(item.id, name, "upload");
    });
  });
  persist();
  emit("queue");
}

export function clearOutbox(sent) {
  store.outbox = store.outbox.filter((entry) =>
    !sent.some((done) => done.id === entry.id && done.updatedAt === entry.updatedAt));
  persist();
  emit("queue");
}

/** Replace the list wholesale (a restore from a file). */
export function replaceAll(items) {
  store.items = items;
  persist();
  emit("local");
}

/* ---------- photos ----------
   Photo files live in the browser's own database: the ones taken on this device,
   waiting to be sent or kept for offline viewing. Shared photos from the other
   devices are fetched from the diary's storage when shown. */

const DB_NAME = "restaurant-diary";
const PHOTO_STORE = "photos";
let dbPromise = null;

function photoDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(PHOTO_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

async function photoTx(mode, run) {
  const db = await photoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE, mode);
    const request = run(tx.objectStore(PHOTO_STORE));
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Photo storage is unavailable."));
  });
}

export function putPhoto(name, blob) {
  return photoTx("readwrite", (s) => s.put(blob, name));
}

export async function getPhoto(name) {
  try {
    return (await photoTx("readonly", (s) => s.get(name))) || null;
  } catch (err) {
    return null;
  }
}

async function photoNames() {
  try {
    return (await photoTx("readonly", (s) => s.getAllKeys())) || [];
  } catch (err) {
    return [];
  }
}

export function queuePhoto(itemId, name, op) {
  store.photoOutbox = store.photoOutbox.filter((entry) => entry.name !== name);
  store.photoOutbox.push({ itemId, name, op });
  write(PHOTO_OUTBOX_KEY, store.photoOutbox);
  emit("queue");
}

export function photoSent(name) {
  store.photoOutbox = store.photoOutbox.filter((entry) => entry.name !== name);
  write(PHOTO_OUTBOX_KEY, store.photoOutbox);
  emit("queue");
}

/** A removed photo: gone here now, and from the shared diary on the next sync. */
export function forgetPhoto(itemId, name) {
  const waiting = store.photoOutbox.find((entry) => entry.name === name && entry.op === "upload");
  if (waiting) photoSent(name); // never left this device, so there's nothing to remove remotely
  else queuePhoto(itemId, name, "delete");
  photoTx("readwrite", (s) => s.delete(name)).catch(() => {});
}

export function clearPhotoOutbox() {
  store.photoOutbox = [];
  write(PHOTO_OUTBOX_KEY, store.photoOutbox);
}

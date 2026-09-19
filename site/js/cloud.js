/* The shared diary: keeps this device and the other members in step.

   Nobody signs in. Sharing or joining quietly gives this device an anonymous
   identity (Supabase anonymous sign-in); the diary's code is what lets a second
   person or device in. Changes are saved on the device first (store.js), then
   pushed; other devices' changes arrive live, or on the next pull. Per
   restaurant, the most recent edit wins. */

import { SUPABASE_URL, SUPABASE_KEY, MENU_FUNCTION_URL, MENU_FUNCTION_IS_LOCAL } from "./config.js";
import {
  store, applyRemote, clearOutbox, queueEverything, getPhoto, photoSent, readSetting, writeSetting,
} from "./store.js";

const BUCKET = "diary-photos";
const PHOTO_URL_LIFETIME = 7 * 24 * 3600; // seconds

let client = null;

function supabase() {
  if (client) return client;
  if (!window.supabase || !window.supabase.createClient) return null;
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      // Its own sign-in, separate from the cocktail app on the same site
      storageKey: "restaurant-diary-auth",
    },
  });
  return client;
}

const listeners = new Set();

export const cloud = {
  // idle (not sharing) | connecting | syncing | synced | offline | error
  status: "idle",
  error: "",
  diary: null, // { id, name, invite_code, google_key }
  usage: null, // { month, counts: { details, autocomplete, map_load } }
  userId: null,
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

function emit() {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (err) {
      console.error(err);
    }
  });
}

function setStatus(status, error) {
  cloud.status = status;
  cloud.error = error || "";
  emit();
}

function isNetworkError(err) {
  return /failed to fetch|networkerror|load failed|network request failed|fetch failed/i
    .test((err && err.message) || String(err));
}

// Supabase's wording is for developers; these are the failures a person can hit.
function friendly(err) {
  const message = (err && err.message) || String(err);
  const code = err && err.code;
  if (code === "anonymous_provider_disabled" || /anonymous sign-ins are disabled/i.test(message)) {
    return new Error("Sharing needs one switch in Supabase: Authentication → Sign In / Providers → " +
      "“Allow anonymous sign-ins”.");
  }
  if (message === "invalid invite code") return new Error("No diary with that code. Check it and try again.");
  if (code === "42P01" || code === "PGRST202" || code === "PGRST205" ||
      /does not exist|could not find the (table|function)/i.test(message)) {
    return new Error("The shared diary isn't set up in Supabase yet: run supabase/schema.sql there once.");
  }
  if (isNetworkError(err)) return new Error("Can't reach the shared diary. Check your internet connection.");
  return err instanceof Error ? err : new Error(message);
}

async function ensureSession() {
  const sb = supabase();
  if (!sb) throw new Error("The sharing library didn't load. Check your internet connection and reload.");
  const { data } = await sb.auth.getSession();
  if (data.session) {
    cloud.userId = data.session.user.id;
    return data.session;
  }
  const { data: created, error } = await sb.auth.signInAnonymously();
  if (error) throw friendly(error);
  cloud.userId = created.session.user.id;
  return created.session;
}

/* ---------- which diary this device is in ---------- */

const DIARY_FIELDS = "id, name, invite_code, google_key";

export async function startCloud() {
  const sb = supabase();
  if (!sb) return;
  const cached = readSetting("diary", null);
  const { data } = await sb.auth.getSession();
  if (!data.session) {
    if (cached) forgetDiary();
    return;
  }
  cloud.userId = data.session.user.id;

  sb.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT" && cloud.diary) {
      stopLive();
      forgetDiary();
      setStatus("idle");
    }
  });

  if (cached) {
    // Open straight away with what was saved last time; the lookup below confirms it.
    cloud.diary = cached;
    setStatus(navigator.onLine ? "connecting" : "offline");
  }
  if (!navigator.onLine) {
    if (cached) subscribeLive();
    return;
  }

  const { data: rows, error } = await sb.from("diary_members")
    .select("diary_id, joined_at, diaries(" + DIARY_FIELDS + ")")
    .order("joined_at", { ascending: false });
  if (error) {
    if (cached) {
      subscribeLive();
      setStatus(isNetworkError(error) ? "offline" : "error", isNetworkError(error) ? "" : friendly(error).message);
    }
    return;
  }
  const preferred = readSetting("diary-id", cached && cached.id);
  const found = ((rows || []).find((row) => row.diary_id === preferred) || (rows || [])[0] || {}).diaries;
  if (!found) {
    forgetDiary();
    setStatus("idle");
    return;
  }
  await enterDiary(found);
}

function rememberDiary(diary) {
  cloud.diary = diary;
  writeSetting("diary", diary);
  writeSetting("diary-id", diary.id);
}

function forgetDiary() {
  cloud.diary = null;
  cloud.usage = null;
  writeSetting("diary", null);
  writeSetting("diary-id", null);
  writeSetting("pulled-at", null);
}

async function enterDiary(diary) {
  rememberDiary(diary);
  emit();
  subscribeLive();
  await syncNow();
  refreshUsage();
}

/* ---------- pull & push ---------- */

async function pull() {
  const sb = supabase();
  const since = readSetting("pulled-at", "1970-01-01T00:00:00Z");
  // Look a minute further back than the last pull, so rows committed out of
  // order around it are never missed. Seeing a row twice is harmless.
  const from = new Date(Math.max(0, Date.parse(since) - 60000)).toISOString();
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await sb.from("diary_restaurants")
      .select("item_id, data, deleted, updated_at, changed_at")
      .eq("diary_id", cloud.diary.id)
      .gt("changed_at", from)
      .order("changed_at", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (data.length) {
      applyRemote(data);
      writeSetting("pulled-at", data[data.length - 1].changed_at);
    }
    if (data.length < pageSize) break;
  }
}

let pushing = false;

async function push() {
  const sb = supabase();
  if (!cloud.diary || pushing) return;
  pushing = true;
  try {
    // Photos first, so a restaurant never arrives pointing at a photo that isn't there yet.
    for (const entry of store.photoOutbox.slice()) {
      const path = cloud.diary.id + "/" + entry.itemId + "/" + entry.name;
      if (entry.op === "upload") {
        const blob = await getPhoto(entry.name);
        if (blob) {
          const { error } = await sb.storage.from(BUCKET).upload(path, blob, {
            upsert: true, contentType: blob.type || "image/jpeg", cacheControl: "31536000",
          });
          if (error) throw error;
        }
      } else {
        const { error } = await sb.storage.from(BUCKET).remove([path]);
        if (error) throw error;
      }
      photoSent(entry.name);
    }

    const pending = store.outbox.slice();
    const rows = [];
    pending.forEach((entry) => {
      const base = {
        diary_id: cloud.diary.id, item_id: entry.id, updated_by: cloud.userId,
      };
      if (entry.deleted) {
        rows.push({ ...base, data: null, deleted: true, updated_at: entry.updatedAt });
        return;
      }
      const item = store.get(entry.id);
      if (item) rows.push({ ...base, data: item, deleted: false, updated_at: item.updated_at || entry.updatedAt });
    });
    for (let i = 0; i < rows.length; i += 50) {
      const { error } = await sb.from("diary_restaurants")
        .upsert(rows.slice(i, i + 50), { onConflict: "diary_id,item_id" });
      if (error) throw error;
    }
    if (pending.length) clearOutbox(pending);
  } finally {
    pushing = false;
  }
}

let syncing = null;

export function syncNow() {
  if (!cloud.diary) return Promise.resolve();
  if (syncing) return syncing;
  syncing = (async () => {
    if (!navigator.onLine) {
      setStatus("offline");
      return;
    }
    setStatus("syncing");
    try {
      await pull();
      await push();
      setStatus("synced");
    } catch (err) {
      if (!navigator.onLine || isNetworkError(err)) setStatus("offline");
      else setStatus("error", friendly(err).message);
    }
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

// Anything saved on this device goes out shortly after it lands.
let pushTimer = null;
store.subscribe((reason) => {
  if (!cloud.diary || (reason !== "local" && reason !== "queue")) return;
  if (!store.outbox.length && !store.photoOutbox.length) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    if (!navigator.onLine) {
      setStatus("offline");
      return;
    }
    if (syncing) await syncing;
    setStatus("syncing");
    try {
      await push();
      setStatus("synced");
    } catch (err) {
      if (!navigator.onLine || isNetworkError(err)) setStatus("offline");
      else setStatus("error", friendly(err).message);
    }
  }, 600);
});

window.addEventListener("online", () => syncNow());
window.addEventListener("offline", () => {
  if (cloud.diary) setStatus("offline");
});
// Phones drop the live connection while asleep: catch up when the diary comes back.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && cloud.diary) syncNow();
});

/* ---------- live updates ---------- */

let channel = null;

function stopLive() {
  if (channel) supabase().removeChannel(channel);
  channel = null;
}

function subscribeLive() {
  stopLive();
  const sb = supabase();
  const id = cloud.diary.id;
  channel = sb.channel("diary:" + id)
    .on("postgres_changes",
      { event: "*", schema: "public", table: "diary_restaurants", filter: "diary_id=eq." + id },
      (payload) => {
        const row = payload.new;
        if (!row || !row.item_id || row.updated_by === cloud.userId) return;
        applyRemote([row]);
      })
    .on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "diaries", filter: "id=eq." + id },
      (payload) => {
        const row = payload.new;
        if (!row || !cloud.diary) return;
        rememberDiary({ ...cloud.diary, name: row.name, google_key: row.google_key || "" });
        emit();
      })
    .subscribe();
}

/* ---------- share, join, leave ---------- */

/** Start a shared diary from everything on this device. */
export async function shareDiary({ googleKey, usage }) {
  const sb = supabase();
  const session = await ensureSession();
  const { data: created, error } = await sb.from("diaries")
    .insert({ created_by: session.user.id, google_key: googleKey || "" })
    .select(DIARY_FIELDS).single();
  if (error) throw friendly(error);
  const { error: memberError } = await sb.from("diary_members")
    .insert({ diary_id: created.id, user_id: session.user.id });
  if (memberError) throw friendly(memberError);

  // Google requests this device already made this month count toward the diary.
  for (const [kind, used] of Object.entries(usage || {})) {
    if (used > 0) await sb.rpc("add_google_usage", { target: created.id, what: kind, amount: used });
  }
  writeSetting("pulled-at", null);
  await queueEverything();
  await enterDiary(created);
}

/** Join a friend's diary, or add another of your own devices, with its code. */
export async function joinDiary(code, { googleKey }) {
  const sb = supabase();
  await ensureSession();
  const { data: id, error } = await sb.rpc("join_diary", { code: code.trim() });
  if (error) throw friendly(error);
  const { data: diary, error: readError } = await sb.from("diaries")
    .select(DIARY_FIELDS).eq("id", id).single();
  if (readError) throw friendly(readError);

  // A key saved only on this device fills in a diary that doesn't have one yet.
  if (!diary.google_key && googleKey) {
    const { error: keyError } = await sb.from("diaries").update({ google_key: googleKey }).eq("id", id);
    if (!keyError) diary.google_key = googleKey;
  }
  writeSetting("pulled-at", null);
  // Anything added here before joining comes along into the diary.
  await queueEverything();
  await enterDiary(diary);
}

/** This device stops sharing. Everything stays here as a local copy. */
export async function leaveDiary() {
  const sb = supabase();
  stopLive();
  if (cloud.diary && navigator.onLine) {
    await sb.from("diary_members").delete()
      .eq("diary_id", cloud.diary.id).eq("user_id", cloud.userId);
  }
  forgetDiary();
  await sb.auth.signOut({ scope: "local" });
  setStatus("idle");
}

/* ---------- Google key and usage ---------- */

export async function setDiaryGoogleKey(key) {
  const sb = supabase();
  const { error } = await sb.from("diaries").update({ google_key: key }).eq("id", cloud.diary.id);
  if (error) throw friendly(error);
  rememberDiary({ ...cloud.diary, google_key: key });
  emit();
}

export async function refreshUsage() {
  if (!cloud.diary || !navigator.onLine) return;
  const { data, error } = await supabase().rpc("google_usage", { target: cloud.diary.id });
  if (!error && data) {
    cloud.usage = data;
    emit();
  }
}

/** Count one Google request for the whole diary; false once the month's limit is reached. */
export async function reserveShared(kind) {
  const { data, error } = await supabase().rpc("reserve_google", { target: cloud.diary.id, what: kind });
  if (error) throw friendly(error);
  cloud.usage = data.usage;
  emit();
  return !!data.ok;
}

export async function refundShared(kind) {
  const { data, error } = await supabase().rpc("refund_google", { target: cloud.diary.id, what: kind });
  if (!error && data) {
    cloud.usage = data;
    emit();
  }
}

/* ---------- photos ---------- */

// Signed links last a week; they're kept so the same photo isn't re-signed on every screen.
const signed = new Map(Object.entries(readSetting("signed-photos", {})));

export function photoPath(itemId, name) {
  return cloud.diary ? cloud.diary.id + "/" + itemId + "/" + name : "";
}

export async function photoLinks(paths) {
  const now = Date.now();
  const fresh = (path) => {
    const entry = signed.get(path);
    return entry && entry.expires > now + 3600e3 ? entry.url : "";
  };
  const missing = [...new Set(paths.filter((path) => path && !fresh(path)))];
  if (missing.length && cloud.diary && navigator.onLine) {
    const { data, error } = await supabase().storage.from(BUCKET)
      .createSignedUrls(missing, PHOTO_URL_LIFETIME);
    if (!error && data) {
      data.forEach((entry) => {
        if (entry.signedUrl && entry.path) {
          signed.set(entry.path, { url: entry.signedUrl, expires: now + PHOTO_URL_LIFETIME * 1000 });
        }
      });
      signed.forEach((entry, path) => {
        if (entry.expires < now) signed.delete(path);
      });
      writeSetting("signed-photos", Object.fromEntries(signed));
    }
  }
  return paths.map(fresh);
}

/* ---------- menu finder ---------- */

export async function findMenuOnline(website, url) {
  const headers = { "Content-Type": "application/json", apikey: SUPABASE_KEY };
  if (!MENU_FUNCTION_IS_LOCAL) {
    const session = await ensureSession();
    headers.Authorization = "Bearer " + session.access_token;
  }
  let response;
  try {
    response = await fetch(MENU_FUNCTION_URL, {
      method: "POST", headers, body: JSON.stringify({ website: website || "", url: url || "" }),
    });
  } catch (err) {
    throw new Error("Can't reach the menu finder. Check your internet connection.");
  }
  let data = {};
  try {
    data = await response.json();
  } catch (err) {
    /* empty body */
  }
  if (response.status === 404 && !data.error) {
    throw new Error("The menu finder isn't set up in Supabase yet (Edge Function “find-menu”).");
  }
  if (!response.ok || !data.menu) {
    throw new Error(data.error || data.message || data.msg || "The menu finder failed (" + response.status + ").");
  }
  return data.menu;
}

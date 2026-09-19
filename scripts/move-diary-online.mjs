// Moves the old local diary (restaurant-diary/data on this computer) into a new
// shared diary online, then prints the diary's code. Run it once, after
// supabase/schema.sql has been run in the Supabase project:
//
//   node scripts/move-diary-online.mjs
//
// Then open the site on each device, tap Share -> Join with a code, and type the code.
// Restaurants keep their ids, so running it twice would make two separate diaries,
// not duplicates inside one.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const dataDir = process.argv[2] || path.join(root, "restaurant-diary", "data");

// The site's own copy of the Supabase library and project settings.
const lib = new Function(readFileSync(path.join(root, "site", "vendor", "supabase.js"), "utf8") + "; return supabase;")();
const config = readFileSync(path.join(root, "site", "js", "config.js"), "utf8");
const url = /SUPABASE_URL = "([^"]+)"/.exec(config)[1];
const key = /SUPABASE_KEY = "([^"]+)"/.exec(config)[1];

const sb = lib.createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const fail = (what, error) => {
  console.error(what + ": " + (error.message || error));
  process.exit(1);
};

const store = JSON.parse(readFileSync(path.join(dataDir, "restaurants.json"), "utf8"));
const restaurants = (store.restaurants || []).filter((r) => /^[0-9a-f]{32}$/.test(r.id || ""));
console.log("Found " + restaurants.length + " restaurants in " + dataDir);

const { data: signedIn, error: signInError } = await sb.auth.signInAnonymously();
if (signInError) fail("Signing in", signInError);
const userId = signedIn.user.id;

const { data: diary, error: diaryError } = await sb.from("diaries")
  .insert({ created_by: userId }).select("id, invite_code").single();
if (diaryError) fail("Creating the diary", diaryError);
const { error: memberError } = await sb.from("diary_members").insert({ diary_id: diary.id, user_id: userId });
if (memberError) fail("Joining the diary", memberError);

// Photos first, so no restaurant points at a photo that isn't there.
let photos = 0;
for (const item of restaurants) {
  for (const name of item.photos || []) {
    const file = path.join(dataDir, "photos", item.id, name);
    if (!existsSync(file)) continue;
    const type = name.endsWith(".png") ? "image/png" : name.endsWith(".webp") ? "image/webp" : "image/jpeg";
    const { error } = await sb.storage.from("diary-photos")
      .upload(diary.id + "/" + item.id + "/" + name, readFileSync(file), { contentType: type, upsert: true });
    if (error) fail("Uploading " + name, error);
    photos += 1;
  }
}

// Postgres can't store the "null" character, which text read from websites sometimes carries.
const NUL = String.fromCharCode(0);
const clean = (value) => typeof value === "string" ? value.split(NUL).join("")
  : Array.isArray(value) ? value.map(clean)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]))
  : value;

const now = new Date().toISOString();
const rows = restaurants.map((item) => ({
  diary_id: diary.id, item_id: item.id, data: clean({ ...item, updated_at: now }),
  deleted: false, updated_at: now, updated_by: userId,
}));
for (let i = 0; i < rows.length; i += 50) {
  const { error } = await sb.from("diary_restaurants").upsert(rows.slice(i, i + 50), { onConflict: "diary_id,item_id" });
  if (error) fail("Saving restaurants", error);
}

// Google requests already made this month count toward the diary's monthly limit.
const usageFile = path.join(dataDir, "google-usage.json");
if (existsSync(usageFile)) {
  const usage = JSON.parse(readFileSync(usageFile, "utf8"));
  const billing = new Date(Date.now() - 8 * 3600e3);
  const month = billing.getUTCFullYear() + "-" + String(billing.getUTCMonth() + 1).padStart(2, "0");
  if (usage.month === month) {
    for (const [kind, used] of Object.entries(usage.counts || {})) {
      if (used > 0) {
        const { error } = await sb.rpc("add_google_usage", { target: diary.id, what: kind, amount: used });
        if (error) fail("Carrying over Google usage", error);
      }
    }
  }
}

console.log("\nMoved " + rows.length + " restaurants and " + photos + " photos.");
console.log("Your diary's code: " + diary.invite_code);
console.log("On each device: open the diary, tap Share -> Join with a code, and type it.");

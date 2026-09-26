/* Google Maps Platform access with a hard monthly budget.

   Every billable Google request is counted first and refused once the month's
   limit is reached, so nothing past the limit is ever sent to Google. While the
   diary is shared, the count is the diary's (kept in Supabase, shared by every
   member); otherwise it's kept on this device.

   Limits sit at 90% of Google's free monthly usage per request type. The margin
   covers the small lag in Google's own quota enforcement; Google's per-API quotas
   in the Cloud console remain the backstop outside this app. */

import { PLACES_BASE } from "./config.js";
import { cloud, reserveShared, refundShared, setDiaryGoogleKey } from "./cloud.js";
import { readSetting, writeSetting } from "./store.js";

// Free monthly usage per type. Place Details is billed at the Enterprise tier
// because it asks for hours, phone, website, price and rating.
export const FREE_MONTHLY = { details: 1000, autocomplete: 10000, map_load: 10000, suggest: 1000 };
export const LIMITS = { details: 900, autocomplete: 9000, map_load: 9000, suggest: 900 };
const LABELS = {
  details: "Place details", autocomplete: "Search suggestions", map_load: "Map loads",
  suggest: "Recommendations",
};
const KINDS = ["details", "autocomplete", "map_load", "suggest"];

// Only Essentials/Pro/Enterprise fields. Anything from the "Atmosphere" group
// (reviews, serves_*, dine_in...) would move every lookup to a pricier SKU.
const DETAILS_FIELDS = [
  "id", "displayName", "formattedAddress", "shortFormattedAddress", "addressComponents",
  "location", "primaryType", "types", "googleMapsUri", "regularOpeningHours",
  "nationalPhoneNumber", "internationalPhoneNumber", "websiteUri", "priceLevel", "rating",
  "userRatingCount",
].join(",");

// Israel, used to bias (not restrict) suggestions toward home.
const HOME_BIAS = {
  rectangle: { low: { latitude: 29.45, longitude: 34.23 }, high: { latitude: 33.34, longitude: 35.90 } },
};

const PRICE_LEVELS = {
  PRICE_LEVEL_FREE: 1, PRICE_LEVEL_INEXPENSIVE: 2, PRICE_LEVEL_MODERATE: 3,
  PRICE_LEVEL_EXPENSIVE: 4, PRICE_LEVEL_VERY_EXPENSIVE: 5,
};
const FOOD_TYPES = new Set(["cafe", "bar", "bakery", "coffee_shop", "meal_takeaway", "meal_delivery",
  "food_court", "ice_cream_shop", "pub", "wine_bar", "deli", "dessert_shop", "juice_shop", "tea_house",
  "confectionery", "food"]);
const GENERIC_TYPES = new Set(["restaurant", "food", "point_of_interest", "establishment", "store"]);
const OSM_DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** A failure worth showing. `billable` is false when Google can't have charged for it. */
export class GoogleError extends Error {
  constructor(message, billable = true) {
    super(message);
    this.billable = billable;
  }
}

export class LimitReached extends Error {}

/* ---------- key ---------- */

export function googleKey() {
  if (cloud.diary) return cloud.diary.google_key || "";
  return readSetting("google-key", "");
}

export async function saveGoogleKey(key) {
  const clean = (key || "").trim();
  if (clean && (clean.length > 200 || !/^[A-Za-z0-9_-]+$/.test(clean))) {
    throw new Error("That doesn't look like a Google API key.");
  }
  if (cloud.diary) await setDiaryGoogleKey(clean);
  else writeSetting("google-key", clean || null);
}

function mask(key) {
  return key.length > 10 ? key.slice(0, 4) + "…" + key.slice(-4) : key ? "set" : "";
}

/* ---------- usage ---------- */

// Google bills by calendar month in Pacific time. A fixed UTC-8 never starts the
// new month before Google does, so the counters never reset early.
function billingNow() {
  return new Date(Date.now() - 8 * 3600e3);
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function monthKey() {
  const now = billingNow();
  return now.getUTCFullYear() + "-" + pad(now.getUTCMonth() + 1);
}

function nextReset() {
  const now = billingNow();
  const year = now.getUTCMonth() === 11 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  return year + "-" + pad((now.getUTCMonth() + 1) % 12 + 1) + "-01";
}

function localCounts() {
  const saved = readSetting("usage", null);
  return saved && saved.month === monthKey() ? saved.counts || {} : {};
}

/** This device's own counts, carried into a diary when it starts sharing. */
export function deviceUsage() {
  const counts = localCounts();
  return Object.fromEntries(KINDS.map((kind) => [kind, Number(counts[kind]) || 0]));
}

function counts() {
  const source = cloud.diary
    ? (cloud.usage && cloud.usage.month === monthKey() ? cloud.usage.counts : {})
    : localCounts();
  return Object.fromEntries(KINDS.map((kind) => [kind, Number((source || {})[kind]) || 0]));
}

export function hasRoom(kind) {
  return counts()[kind] < LIMITS[kind];
}

export function limitMessage(kind) {
  const reset = new Date(nextReset() + "T00:00:00");
  return "This month's safe limit for Google " + LABELS[kind].toLowerCase() + " is used up (" +
    LIMITS[kind].toLocaleString("en-US") + " of the " + FREE_MONTHLY[kind].toLocaleString("en-US") +
    " free), so Google won't be called again until " +
    reset.toLocaleDateString("en-US", { month: "short" }) + " " + reset.getDate() + ".";
}

/** Count one request of `kind`, or throw LimitReached without counting. */
export async function reserve(kind) {
  if (cloud.diary) {
    let ok;
    try {
      ok = await reserveShared(kind);
    } catch (err) {
      throw new GoogleError("Couldn't check this month's Google usage: " + err.message, false);
    }
    if (!ok) throw new LimitReached(limitMessage(kind));
    return;
  }
  const current = localCounts();
  const used = Number(current[kind]) || 0;
  if (used >= LIMITS[kind]) throw new LimitReached(limitMessage(kind));
  writeSetting("usage", { month: monthKey(), counts: { ...current, [kind]: used + 1 } });
}

export async function refund(kind) {
  if (cloud.diary) {
    await refundShared(kind);
    return;
  }
  const current = localCounts();
  writeSetting("usage", {
    month: monthKey(), counts: { ...current, [kind]: Math.max(0, (Number(current[kind]) || 0) - 1) },
  });
}

export function googleStatus() {
  const key = googleKey();
  const used = counts();
  return {
    configured: !!key,
    key,
    masked: mask(key),
    shared: !!cloud.diary,
    resets_on: nextReset(),
    usage: KINDS.map((kind) => ({
      kind, label: LABELS[kind], used: used[kind], limit: LIMITS[kind], free: FREE_MONTHLY[kind],
    })),
  };
}

/* ---------- HTTP ---------- */

function explain(code, data) {
  const error = (data && data.error) || {};
  const message = error.message || "HTTP " + code;
  const text = (message + " " + JSON.stringify(error.details || [])).toLowerCase();

  if (text.includes("referer") || text.includes("referrer")) {
    return new GoogleError("This Google key doesn't allow this website yet. In the Google Cloud console, " +
      "add " + location.origin + "/* to the key's website restrictions.", false);
  }
  if (text.includes("api_key_invalid") || text.includes("api key not valid")) {
    return new GoogleError("Google rejected the API key. Check it in Settings.", false);
  }
  if (text.includes("service_disabled") || text.includes("has not been used") || text.includes("is disabled")) {
    return new GoogleError("\"Places API (New)\" isn't turned on for this Google project.", false);
  }
  if (text.includes("billing")) return new GoogleError("Billing isn't set up on this Google project.", false);
  if (code === 429 || text.includes("resource_exhausted")) {
    return new GoogleError("The daily quota set in the Google console was reached.", false);
  }
  if ([400, 401, 403, 404].includes(code)) return new GoogleError("Google refused the request: " + message, false);
  return new GoogleError("Google returned an error: " + message);
}

async function call(method, path, key, { body, fieldMask, query } = {}) {
  let url = PLACES_BASE + path;
  if (query) url += "?" + new URLSearchParams(query);
  const headers = { "X-Goog-Api-Key": key, "Content-Type": "application/json" };
  if (fieldMask) headers["X-Goog-FieldMask"] = fieldMask;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
    });
  } catch (err) {
    // A timeout may have reached Google; a failed connection can't have.
    const timedOut = err && err.name === "TimeoutError";
    throw new GoogleError(timedOut ? "Google took too long to answer."
      : "Could not reach Google. Check your internet connection.", timedOut);
  }
  let data = {};
  try {
    data = await response.json();
  } catch (err) {
    /* empty body */
  }
  if (!response.ok) throw explain(response.status, data);
  return data;
}

async function billedCall(kind, ...args) {
  await reserve(kind);
  try {
    return await call(...args);
  } catch (err) {
    if (err instanceof GoogleError && !err.billable) await refund(kind).catch(() => {});
    throw err;
  }
}

/* ---------- normalizing ---------- */

function isFood(types) {
  return (types || []).some((t) => t.includes("restaurant") || FOOD_TYPES.has(t));
}

function cuisineOf(primary) {
  if (!primary || GENERIC_TYPES.has(primary)) return "";
  return primary.replace(/_restaurant$/, "").replace(/_/g, " ");
}

/** Google's opening periods as the OSM opening_hours text the app reads. */
export function hoursToOsm(openingHours) {
  const periods = (openingHours && openingHours.periods) || [];
  if (!periods.length) return "";
  for (const period of periods) {
    const start = period.open || {};
    if (!period.close && !start.day && !start.hour && !start.minute) return "24/7";
  }

  const week = 7 * 1440;
  const days = [[], [], [], [], [], [], []];
  // Google: 0 = Sunday. The app's week starts on Monday.
  const minuteOfWeek = (point) => (((point.day || 0) + 6) % 7) * 1440 + (point.hour || 0) * 60 + (point.minute || 0);

  for (const period of periods) {
    if (!period.open || !period.close) continue;
    const begin = minuteOfWeek(period.open);
    let finish = minuteOfWeek(period.close);
    if (finish <= begin) finish += week;
    const length = finish - begin;
    const offset = begin % 1440;
    // One overnight span stays a single "20:00-02:00" rule on its start day;
    // anything longer is split so each day shows its own hours.
    if (offset + length <= 2 * 1440 && length < 1440) {
      const end = offset + length === 1440 ? 1440 : (offset + length) % 1440;
      days[Math.floor(begin / 1440) % 7].push([offset, end]);
      continue;
    }
    let cursor = begin;
    while (cursor < finish) {
      const at = cursor % 1440;
      const spanEnd = Math.min(finish - (cursor - at), 1440);
      days[Math.floor(cursor / 1440) % 7].push([at, spanEnd]);
      cursor += spanEnd - at;
    }
  }

  const clock = (minutes) => pad(Math.floor(minutes / 60)) + ":" + pad(minutes % 60);
  return days.map((spans, index) => spans.length
    ? OSM_DAYS[index] + " " + spans.sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .map(([a, b]) => clock(a) + "-" + clock(b)).join(",")
    : OSM_DAYS[index] + " off").join("; ");
}

function component(place, kind, field = "longText") {
  const part = (place.addressComponents || []).find((c) => (c.types || []).includes(kind));
  return (part && part[field]) || "";
}

function normalizeDetails(place) {
  const location = place.location || {};
  const types = place.types || [];
  return {
    name: (place.displayName && place.displayName.text) || "",
    local_name: "",
    address: place.shortFormattedAddress || place.formattedAddress || "",
    full_address: place.formattedAddress || "",
    city: component(place, "locality") || component(place, "administrative_area_level_2"),
    country: component(place, "country"),
    country_code: component(place, "country", "shortText").toLowerCase(),
    lat: location.latitude !== undefined ? String(location.latitude) : "",
    lon: location.longitude !== undefined ? String(location.longitude) : "",
    cuisine: cuisineOf(place.primaryType),
    opening_hours: hoursToOsm(place.regularOpeningHours),
    phone: place.nationalPhoneNumber || place.internationalPhoneNumber || "",
    website: place.websiteUri || "",
    price: PRICE_LEVELS[place.priceLevel] || 0,
    google_place_id: place.id || "",
    google_rating: place.rating || 0,
    google_rating_count: place.userRatingCount || 0,
    google_maps_uri: place.googleMapsUri || "",
    place_type: (place.primaryType || "").replace(/_/g, " "),
    is_food: isFood(types.concat([place.primaryType || ""])),
    source: "google",
  };
}

/* ---------- public calls ---------- */

export async function autocomplete(query, session, country) {
  const key = googleKey();
  if (!key) throw new GoogleError("No Google API key is set.", false);
  const body = { input: query, languageCode: "en", regionCode: country || "il" };
  if (country) body.includedRegionCodes = [country];
  // The Israel nudge would pull results the wrong way in any other country.
  if (!country || country === "il") body.locationBias = HOME_BIAS;
  if (session) body.sessionToken = session;
  const raw = await billedCall("autocomplete", "POST", "/places:autocomplete", key, { body });

  const places = [];
  (raw.suggestions || []).forEach((suggestion) => {
    const prediction = suggestion.placePrediction;
    if (!prediction || !prediction.placeId) return;
    const structured = prediction.structuredFormat || {};
    const types = prediction.types || [];
    const label = types.find((t) => !GENERIC_TYPES.has(t)) || types[0] || "";
    places.push({
      name: (structured.mainText && structured.mainText.text) || (prediction.text && prediction.text.text) || "",
      full_address: (structured.secondaryText && structured.secondaryText.text) || "",
      google_place_id: prediction.placeId,
      place_type: label.replace(/_/g, " "),
      is_food: isFood(types),
      needs_details: true,
      source: "google",
    });
  });
  // Google suggests streets, towns and shops too; only places to eat or drink stay.
  return places.filter((place) => place.is_food);
}

// Finding a chain's branches needs only where they are: Pro-tier fields.
const BRANCH_FIELDS = [
  "places.id", "places.displayName", "places.formattedAddress", "places.shortFormattedAddress",
  "places.addressComponents", "places.location", "places.primaryType", "places.types",
].join(",");

// A recommendation is shown like any search result, so it asks for what Place
// Details would: rating, price, hours, phone and website. That's the Enterprise
// tier (1,000 free a month rather than 5,000), but one search brings twenty
// complete places, and adding one then needs no further lookup.
const SUGGEST_FIELDS = DETAILS_FIELDS.split(",").map((field) => "places." + field).join(",");

/**
 * Well-known places for "recommend me one". `query` is asked as typed; `area`,
 * when given, keeps the answers within a circle: { lat, lon, radius } in km.
 */
export async function suggestPlaces(country, query, options = {}) {
  const key = googleKey();
  if (!key) throw new GoogleError("No Google API key is set.", false);
  const body = {
    textQuery: query,
    languageCode: "en",
    regionCode: country || "il",
    includedType: options.includedType || "restaurant",
    pageSize: 20,
  };
  const area = options.area;
  const located = area && isFinite(area.lat) && isFinite(area.lon);
  const radiusKm = located ? Math.min(50, Math.max(0.5, Number(area.radius) || 5)) : 0;
  if (located) {
    // Text Search only restricts to a rectangle (a circle is merely a "bias"),
    // so ask for the box around the circle and trim its corners off below.
    const lat = Number(area.lat);
    const lon = Number(area.lon);
    const dLat = radiusKm / 111.32;
    const dLon = radiusKm / (111.32 * Math.max(0.01, Math.cos(lat * Math.PI / 180)));
    body.locationRestriction = {
      rectangle: {
        low: { latitude: lat - dLat, longitude: lon - dLon },
        high: { latitude: lat + dLat, longitude: lon + dLon },
      },
    };
  }
  const raw = await billedCall("suggest", "POST", "/places:searchText", key,
    { body, fieldMask: SUGGEST_FIELDS });
  return (raw.places || []).map(normalizeDetails).filter((place) => place.is_food &&
    (!located || kmBetween(area, place) <= radiusKm));
}

function kmBetween(from, to) {
  const rad = Math.PI / 180;
  const lat1 = Number(from.lat) * rad;
  const lat2 = parseFloat(to.lat) * rad;
  const dLat = lat2 - lat1;
  const dLon = (parseFloat(to.lon) - Number(from.lon)) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

/**
 * The branches of a chain, for countries the built-in Israeli list doesn't
 * cover. Same search and same monthly allowance as a recommendation.
 */
export async function findBranchesOnline(name, country, where) {
  const key = googleKey();
  if (!key) throw new GoogleError("No Google API key is set.", false);
  const body = {
    textQuery: name + (where ? " " + where : ""),
    languageCode: "en",
    regionCode: country || "il",
    includedType: "restaurant",
    pageSize: 20,
  };
  const raw = await billedCall("suggest", "POST", "/places:searchText", key,
    { body, fieldMask: BRANCH_FIELDS });
  return (raw.places || []).map(normalizeDetails).filter((place) => place.is_food);
}

export async function placeDetails(placeId, session, country) {
  const key = googleKey();
  if (!key) throw new GoogleError("No Google API key is set.", false);
  if (!placeId || placeId.includes("/") || placeId.length > 300) {
    throw new GoogleError("That place ID doesn't look right.", false);
  }
  const query = { languageCode: "en", regionCode: country || "il" };
  if (session) query.sessionToken = session;
  const raw = await billedCall("details", "GET", "/places/" + encodeURIComponent(placeId), key,
    { fieldMask: DETAILS_FIELDS, query });
  return normalizeDetails(raw);
}

/* Restaurant Diary - the page */

import { SITE_URL, IS_LOCAL } from "./config.js";
import {
  store, saveItem, updateItem, deleteItem, newId, nowIso, readSetting, writeSetting,
  putPhoto, getPhoto, queuePhoto, forgetPhoto,
} from "./store.js";
import {
  cloud, startCloud, syncNow, shareDiary, joinDiary, leaveDiary, refreshUsage,
  photoPath, photoLinks, findMenuOnline,
} from "./cloud.js";
import {
  googleStatus, saveGoogleKey, deviceUsage, hasRoom, limitMessage, autocomplete, placeDetails,
  LimitReached,
} from "./google.js";
import { searchFreePlaces } from "./osm.js";
import { createMapView } from "./map.js";

const DAY_KEYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

const state = {
  tab: "wishlist",
  view: "list",
  filter: "",
  cuisine: "",
  city: "",
  sort: "added",
  origin: null,
  radius: 5,
  openNow: false,
  pendingPhotos: [],
  menuId: null,
  selectedPlace: null,
  editingId: null,
  draftRating: 0,
  editRating: 0,
  draftPrice: 0,
  editPrice: 0,
  activeResult: -1,
  results: [],
  google: null,
  searchSession: "",
  choosing: false,
  searchCountry: readSetting("search-country", ""),
};

// The restaurants live in the store (this device, synced with the diary); the page only reads them.
Object.defineProperty(state, "items", { get: () => store.items });

const $ = (id) => document.getElementById(id);

/* ---------- helpers ---------- */

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch (err) {
    return null;
  }
}

function icon(name, cls) {
  return '<svg class="icon ' + (cls || "") + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
}

function prettyCuisine(value) {
  if (!value) return "";
  return String(value).split(";")[0].replace(/_/g, " ").trim();
}

function newSession() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

let toastTimer = null;
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

/* ---------- OpenStreetMap opening_hours ---------- */

function expandDays(spec) {
  const days = new Set();
  spec.split(",").forEach((chunk) => {
    const part = chunk.trim();
    const range = part.match(/^(Mo|Tu|We|Th|Fr|Sa|Su)\s*-\s*(Mo|Tu|We|Th|Fr|Sa|Su)$/i);
    if (range) {
      const from = DAY_KEYS.findIndex((d) => d.toLowerCase() === range[1].toLowerCase());
      const to = DAY_KEYS.findIndex((d) => d.toLowerCase() === range[2].toLowerCase());
      if (from < 0 || to < 0) return;
      let i = from;
      for (;;) { days.add(i); if (i === to) break; i = (i + 1) % 7; }
      return;
    }
    const single = part.match(/^(Mo|Tu|We|Th|Fr|Sa|Su)$/i);
    if (single) {
      const idx = DAY_KEYS.findIndex((d) => d.toLowerCase() === single[1].toLowerCase());
      if (idx >= 0) days.add(idx);
    }
  });
  return Array.from(days);
}

function parseSpans(text) {
  if (/^(off|closed)$/i.test(text.trim())) return [];
  const spans = [];
  let valid = true;
  text.split(",").forEach((chunk) => {
    const match = chunk.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!match) { valid = false; return; }
    spans.push({
      start: Number(match[1]) * 60 + Number(match[2]),
      end: Number(match[3]) * 60 + Number(match[4]),
    });
  });
  return valid ? spans : null;
}

function parseOpeningHours(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  if (/^24\/7$/.test(text)) return { always: true, ok: true, days: null, raw: text };

  const days = [[], [], [], [], [], [], []];
  let ok = true;
  let touched = false;

  text.split(";").forEach((rule) => {
    const line = rule.trim();
    if (!line) return;
    if (/^(PH|SH)\b/i.test(line)) return;

    const match = line.match(
      /^([A-Za-z,\s-]*?)\s*((?:\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\s*,?\s*)+|off|closed)$/i
    );
    if (!match) { ok = false; return; }

    const dayPart = (match[1] || "").trim();
    const indices = dayPart ? expandDays(dayPart) : [0, 1, 2, 3, 4, 5, 6];
    if (!indices.length) { ok = false; return; }

    const spans = parseSpans(match[2]);
    if (spans === null) { ok = false; return; }

    indices.forEach((i) => { days[i] = spans; });
    touched = true;
  });

  return { always: false, ok: ok && touched, days: days, raw: text };
}

function minutesToLabel(minutes) {
  if (minutes >= 1440) return "24:00";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// The span open at `now`, if any. A span past midnight ("Fri 20:00-02:00")
// covers the late evening of its own day and the early hours of the next day,
// never the early hours of its own day.
function currentSpan(parsed, now) {
  const today = (now.getDay() + 6) % 7;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const own = parsed.days[today].find((span) => (span.end > span.start
    ? minutes >= span.start && minutes < span.end
    : minutes >= span.start));
  if (own) return own;
  return parsed.days[(today + 6) % 7].find((span) => span.end <= span.start && minutes < span.end);
}

function openNow(parsed, now) {
  if (!parsed || (!parsed.always && !parsed.ok)) return null;
  if (parsed.always) return true;
  return !!currentSpan(parsed, now);
}

function nextChange(parsed, now) {
  if (!parsed || parsed.always || !parsed.ok) return "";
  const span = currentSpan(parsed, now);
  if (span) return "Closes " + minutesToLabel(span.end);

  const today = (now.getDay() + 6) % 7;
  const minutes = now.getHours() * 60 + now.getMinutes();
  for (let offset = 0; offset < 7; offset += 1) {
    const day = (today + offset) % 7;
    const starts = parsed.days[day]
      .map((s) => s.start)
      .filter((start) => offset > 0 || start > minutes)
      .sort((a, b) => a - b);
    if (starts.length) {
      const when = offset === 0 ? "" : offset === 1 ? "tomorrow " : DAY_NAMES[day] + " ";
      return "Opens " + when + minutesToLabel(starts[0]);
    }
  }
  return "";
}

function todayHours(parsed, now) {
  if (!parsed || (!parsed.always && !parsed.ok)) return null;
  if (parsed.always) return "Open 24 hours";
  const spans = parsed.days[(now.getDay() + 6) % 7];
  if (!spans.length) return "Closed today";
  return spans.map((s) => minutesToLabel(s.start) + "–" + minutesToLabel(s.end)).join(", ");
}

function hoursMarkup(rawHours) {
  if (!rawHours) {
    return '<div class="meta-row">' + icon("clock") +
      "<span>No opening hours listed</span></div>";
  }
  const now = new Date();
  const parsed = parseOpeningHours(rawHours);
  const open = openNow(parsed, now);
  const today = todayHours(parsed, now);

  if (open === null || today === null) {
    return '<div class="meta-row">' + icon("clock") + "<span>" + esc(rawHours) + "</span></div>";
  }
  const badge = open
    ? '<span class="badge badge-open"><span class="badge-dot"></span>Open now</span>'
    : '<span class="badge badge-closed"><span class="badge-dot"></span>Closed now</span>';
  const change = nextChange(parsed, now);
  return '<div class="meta-row">' + icon("clock") +
    '<span class="hours-today">' + badge +
    (change ? '<span class="hours-next">' + esc(change) + "</span>" : "") +
    '<span class="hours-span">' + (today === "Closed today" ? "Closed today" : "Today " + esc(today)) +
    "</span></span></div>";
}

function isOpenNow(item) {
  return openNow(parseOpeningHours(item.opening_hours), new Date()) === true;
}

function hasReadableHours(item) {
  return openNow(parseOpeningHours(item.opening_hours), new Date()) !== null;
}

/* ---------- metadata rows shared by cards and the preview ---------- */

function metaMarkup(item, withContact) {
  let html = "";
  const address = item.address || "";
  const city = item.city || "";
  // format_address already ends with the locality for most OSM results.
  const includesCity = city && address.toLowerCase().includes(city.toLowerCase());
  const place = [address, includesCity ? "" : city].filter(Boolean).join(", ");
  if (place) html += '<div class="meta-row">' + icon("pin") + "<span>" + esc(place) + "</span></div>";
  html += hoursMarkup(item.opening_hours);

  if (item.google_rating) {
    const count = item.google_rating_count
      ? " (" + Number(item.google_rating_count).toLocaleString() + " reviews)" : "";
    html += '<div class="meta-row">' + icon("star") + "<span>Google rating " +
      esc(Number(item.google_rating).toFixed(1)) + esc(count) + "</span></div>";
  }

  if (withContact && item.phone) {
    html += '<div class="meta-row">' + icon("phone") + "<span>" + esc(item.phone) + "</span></div>";
  }
  if (withContact && item.website) {
    const url = safeUrl(item.website);
    if (url) {
      html += '<div class="meta-row">' + icon("globe") +
        '<span><a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' +
        esc(url.replace(/^https?:\/\//, "").replace(/\/$/, "")) + "</a></span></div>";
    }
  }
  return html;
}

/* ---------- price & distance ---------- */

function priceStatic(price) {
  if (!price) return "";
  const label = "Price level " + price + " of 5";
  let html = '<span class="price-static" role="img" aria-label="' + label + '">';
  for (let i = 1; i <= 5; i += 1) {
    html += '<span class="' + (i <= price ? "on" : "off") + '">₪</span>';
  }
  return html + "</span>";
}

function haversineKm(from, to) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (to.lat - from.lat) * rad;
  const dLon = (to.lon - from.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(from.lat * rad) * Math.cos(to.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function distanceKm(item) {
  if (!state.origin) return null;
  const lat = parseFloat(item.lat);
  const lon = parseFloat(item.lon);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  return haversineKm(state.origin, { lat: lat, lon: lon });
}

function formatDistance(km) {
  if (km === null) return "";
  return km < 1 ? Math.round(km * 1000) + " m away" : km.toFixed(1) + " km away";
}

function starsStatic(rating) {
  let html = '<span class="stars-static" role="img" aria-label="' + (rating || 0) + ' out of 5">';
  for (let i = 1; i <= 5; i += 1) html += icon("star", i <= (rating || 0) ? "on" : "");
  return html + "</span>";
}

/* ---------- photos & menu on cards ---------- */

// A photo shows from this device's own copy when it has one, otherwise from the
// shared diary. Images are drawn empty and filled in once their address is known.
const localPhotoUrls = new Map();

function photoImg(itemId, name) {
  // crossorigin lets the offline cache keep shared photos (see sw.js)
  return '<img data-photo="' + esc(itemId + "/" + name) + '" alt="" loading="lazy" decoding="async" ' +
    'crossorigin="anonymous">';
}

async function photoSources(wanted) {
  const urls = [];
  const remote = [];
  for (let i = 0; i < wanted.length; i += 1) {
    const { name } = wanted[i];
    let url = localPhotoUrls.get(name);
    if (!url) {
      const blob = await getPhoto(name);
      if (blob) {
        url = URL.createObjectURL(blob);
        localPhotoUrls.set(name, url);
      }
    }
    urls[i] = url || "";
    if (!url && cloud.diary) remote.push(i);
  }
  if (remote.length) {
    const links = await photoLinks(remote.map((i) => photoPath(wanted[i].itemId, wanted[i].name)));
    remote.forEach((i, k) => { urls[i] = links[k] || ""; });
  }
  return urls;
}

async function hydratePhotos(root) {
  const images = Array.from(root.querySelectorAll("img[data-photo]:not([src])"));
  if (!images.length) return;
  const wanted = images.map((img) => {
    const [itemId, name] = img.dataset.photo.split("/");
    return { itemId, name };
  });
  const urls = await photoSources(wanted);
  images.forEach((img, i) => {
    if (urls[i]) img.src = urls[i];
    else img.closest(".card-photo, .photo-tile")?.classList.add("is-missing");
  });
}

function cardPhotosMarkup(item) {
  const photos = Array.isArray(item.photos) ? item.photos : [];
  if (!photos.length) return "";
  let html = '<div class="card-photos">';
  photos.slice(0, 4).forEach((name, i) => {
    const more = i === 3 && photos.length > 4 ? photos.length - 4 : 0;
    html += '<button type="button" class="card-photo" data-act="photo" data-id="' + esc(item.id) +
      '" data-index="' + i + '" aria-label="Open photo ' + (i + 1) + " of " + photos.length +
      " from " + esc(item.name) + '">' + photoImg(item.id, name) +
      (more ? '<span class="card-photo-more">+' + more + "</span>" : "") + "</button>";
  });
  return html + "</div>";
}

function menuRowMarkup(item) {
  const menu = item.menu;
  let label;
  if (menu && menu.url) {
    const count = (menu.items || []).length;
    label = count ? "Menu · " + count + " dish" + (count === 1 ? "" : "es") : "Menu";
  } else if (menu) {
    label = "No menu found — add a link";
  } else if (item.website) {
    label = "Find the menu";
  } else {
    label = "Add a menu link";
  }
  return '<div class="meta-row">' + icon("book") +
    '<span><button type="button" class="link-btn" data-act="menu" data-id="' + esc(item.id) + '">' +
    esc(label) + "</button></span></div>";
}

/* ---------- favorites ---------- */

function favoriteLabel(item) {
  return (item.favorite ? "Remove " + item.name + " from favorites" : "Mark " + item.name + " as a favorite");
}

function favoriteButtonMarkup(item) {
  return '<button type="button" class="fav-btn" data-act="favorite" data-id="' + esc(item.id) +
    '" aria-pressed="' + (item.favorite ? "true" : "false") + '" aria-label="' +
    esc(favoriteLabel(item)) + '" title="' + (item.favorite ? "Favorite" : "Mark as favorite") + '">' +
    icon("star") + "</button>";
}

// Toggled in place rather than re-rendering the list, so the card's colour
// fades in and out instead of the card being rebuilt.
function toggleFavorite(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  const on = !item.favorite;
  const card = $("list").querySelector('[data-card-id="' + CSS.escape(id) + '"]');
  if (card) {
    card.classList.toggle("is-favorite", on);
    const button = card.querySelector(".fav-btn");
    button.setAttribute("aria-pressed", on ? "true" : "false");
    button.setAttribute("aria-label", favoriteLabel({ ...item, favorite: on }));
    button.title = on ? "Favorite" : "Mark as favorite";
    button.classList.toggle("pop", on);
    if (on) setTimeout(() => button.classList.remove("pop"), 400);
  }
  updateItem(id, { favorite: on });
  if (state.sort === "favorite" || state.view === "map") render();
}

/* ---------- cards ---------- */

function cardMarkup(item) {
  const initial = (item.name || "?").trim().charAt(0).toUpperCase();
  const cuisine = prettyCuisine(item.cuisine);
  const dishes = Array.isArray(item.dishes) ? item.dishes.filter(Boolean) : [];
  const visited = item.status === "visited";

  let html = '<article class="card' + (item.favorite ? " is-favorite" : "") +
    '" data-card-id="' + esc(item.id) + '">';
  html += '<div class="card-top">';
  html += '<div class="card-mark" aria-hidden="true">' + esc(initial) + "</div>";
  html += '<div class="card-title-group"><h3>' + esc(item.name) + "</h3>";
  if (item.local_name) html += '<div class="card-local">' + esc(item.local_name) + "</div>";
  const tagline = [];
  if (cuisine) tagline.push('<span class="card-cuisine">' + esc(cuisine) + "</span>");
  if (item.price) tagline.push(priceStatic(item.price));
  if (tagline.length) html += '<div class="card-tagline">' + tagline.join("") + "</div>";
  html += "</div>" + favoriteButtonMarkup(item) + "</div>";

  const km = distanceKm(item);
  html += '<div class="card-meta">' + metaMarkup(item, true);
  if (km !== null) {
    html += '<div class="meta-row">' + icon("crosshair") +
      "<span>" + esc(formatDistance(km)) + "</span></div>";
  }
  html += menuRowMarkup(item);
  html += "</div>";

  html += cardPhotosMarkup(item);

  if (visited && (item.rating || item.review || dishes.length)) {
    html += '<div class="card-review">';
    if (item.rating) html += starsStatic(item.rating);
    if (item.review) html += '<p class="review-text">' + esc(item.review) + "</p>";
    if (dishes.length) {
      html += '<div class="dishes">' +
        dishes.map((d) => '<span class="dish-chip">' + esc(d) + "</span>").join("") + "</div>";
    }
    html += "</div>";
  } else if (!visited && item.wish_note) {
    html += '<div class="card-review"><p class="review-text">' + esc(item.wish_note) + "</p></div>";
  }

  html += '<div class="card-actions">';
  if (visited) {
    html += '<button type="button" class="btn btn-ghost btn-sm" data-act="edit" data-id="' + esc(item.id) + '">' +
      icon("edit") + "Edit notes</button>";
  } else {
    html += '<button type="button" class="btn btn-primary btn-sm" data-act="visit" data-id="' + esc(item.id) + '">' +
      icon("check") + "I've been here</button>";
  }
  html += '<span class="spacer"></span>';
  let maps = null;
  if (item.google_place_id) {
    maps = safeUrl(item.google_maps_uri) ||
      "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(item.name) +
      "&query_place_id=" + encodeURIComponent(item.google_place_id);
  } else if (item.lat && item.lon) {
    maps = "https://www.openstreetmap.org/?mlat=" + encodeURIComponent(item.lat) +
      "&mlon=" + encodeURIComponent(item.lon) + "#map=18/" + encodeURIComponent(item.lat) +
      "/" + encodeURIComponent(item.lon);
  }
  if (maps) {
    const where = item.google_place_id ? "Google Maps" : "the map";
    html += '<a class="btn-icon" href="' + esc(maps) + '" target="_blank" rel="noopener noreferrer" ' +
      'title="Show on ' + where + '" aria-label="Show ' + esc(item.name) + " on " + where + '">' +
      icon("external") + "</a>";
  }
  html += '<button type="button" class="btn-icon danger" data-act="delete" data-id="' + esc(item.id) +
    '" title="Remove" aria-label="Remove ' + esc(item.name) + '">' + icon("trash") + "</button>";
  html += "</div></article>";
  return html;
}

function emptyMarkup() {
  const nearby = state.origin && state.radius > 0;
  if (state.openNow) {
    const withoutHours = state.items
      .filter((i) => i.status === state.tab && !hasReadableHours(i)).length;
    return '<div class="empty">' +
      '<div class="empty-mark">' + icon("clock") + "</div>" +
      "<h3>Nothing open right now" + (nearby ? " within " + state.radius + " km" : "") + "</h3>" +
      "<p>" + (withoutHours
        ? withoutHours + " of these places " + (withoutHours === 1 ? "has" : "have") +
          " no opening hours listed, so they can't be checked and are hidden. "
        : "") +
      "Turn off Open now to see everything.</p></div>";
  }
  if (nearby) {
    return '<div class="empty">' +
      '<div class="empty-mark">' + icon("crosshair") + "</div>" +
      "<h3>Nothing within " + state.radius + " km</h3>" +
      "<p>None of these places are that close to you. Pick a wider distance, " +
      "or turn off Near me to see everything.</p></div>";
  }
  const filtering = state.filter.trim().length > 0;
  if (filtering) {
    return '<div class="empty">' +
      '<div class="empty-mark">' + icon("search") + "</div>" +
      "<h3>No matches</h3><p>Nothing here matches “" + esc(state.filter) +
      "”. Try a shorter word, or clear the filter to see everything.</p></div>";
  }
  if (state.tab === "wishlist") {
    return '<div class="empty">' +
      '<div class="empty-mark">' + icon("bookmark") + "</div>" +
      "<h3>Nothing on the wishlist yet</h3>" +
      "<p>Add a place you've been meaning to try — type the name and the address, " +
      "hours and cuisine are filled in for you.</p>" +
      '<button type="button" class="btn btn-primary" data-act="add">' + icon("plus") +
      "Add your first restaurant</button></div>";
  }
  return '<div class="empty">' +
    '<div class="empty-mark">' + icon("utensils") + "</div>" +
    "<h3>No visits recorded yet</h3>" +
    "<p>When you eat somewhere, add it here with a rating and the dishes worth ordering again.</p>" +
    '<button type="button" class="btn btn-primary" data-act="add">' + icon("plus") +
    "Add a restaurant</button></div>";
}

function visibleItems() {
  const term = state.filter.trim().toLowerCase();
  let items = state.items.filter((item) => item.status === state.tab);

  if (term) {
    items = items.filter((item) => [item.name, item.local_name, item.cuisine,
      item.city, item.address, item.review]
      .filter(Boolean).join(" ").toLowerCase().includes(term));
  }
  if (state.cuisine) {
    items = items.filter((item) => prettyCuisine(item.cuisine) === state.cuisine);
  }
  if (state.city) {
    items = items.filter((item) => (item.city || "") === state.city);
  }
  if (state.origin && state.radius > 0) {
    items = items.filter((item) => {
      const km = distanceKm(item);
      return km !== null && km <= state.radius;
    });
  }
  if (state.openNow) {
    items = items.filter(isOpenNow);
  }

  const sorters = {
    added: (a, b) => String(b.added_at || "").localeCompare(String(a.added_at || "")),
    favorite: (a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) ||
      String(b.added_at || "").localeCompare(String(a.added_at || "")),
    name: (a, b) => String(a.name || "").localeCompare(String(b.name || "")),
    city: (a, b) => String(a.city || "~").localeCompare(String(b.city || "~")),
    rating: (a, b) => (b.rating || 0) - (a.rating || 0),
    price: (a, b) => (a.price || 99) - (b.price || 99),
    distance: (a, b) => {
      const da = distanceKm(a);
      const db = distanceKm(b);
      if (da === null && db === null) return 0;
      if (da === null) return 1;
      if (db === null) return -1;
      return da - db;
    },
  };
  return items.slice().sort(sorters[state.sort] || sorters.added);
}

function refreshFilterOptions() {
  const cuisines = new Set();
  const cities = new Set();
  state.items.forEach((item) => {
    const cuisine = prettyCuisine(item.cuisine);
    if (cuisine) cuisines.add(cuisine);
    if (item.city) cities.add(item.city);
  });

  const fill = (id, values, allLabel, selected) => {
    const select = $(id);
    const sorted = Array.from(values).sort((a, b) => a.localeCompare(b));
    select.innerHTML = '<option value="">' + allLabel + "</option>" +
      sorted.map((v) => '<option value="' + esc(v) + '"' +
        (v === selected ? " selected" : "") + ">" + esc(v) + "</option>").join("");
    if (selected && !sorted.includes(selected)) select.value = "";
  };

  fill("cuisine-filter", cuisines, "All cuisines", state.cuisine);
  fill("city-filter", cities, "All cities", state.city);
}

/* ---------- map ---------- */

function popupMarkup(item) {
  const bits = ['<strong>' + (item.favorite ? "★ " : "") + esc(item.name) + "</strong>"];
  const cuisine = prettyCuisine(item.cuisine);
  if (cuisine) bits.push(esc(cuisine));
  const parsed = parseOpeningHours(item.opening_hours);
  const open = openNow(parsed, new Date());
  if (open !== null) {
    const change = nextChange(parsed, new Date());
    bits.push((open ? "Open now" : "Closed now") + (change ? " · " + esc(change) : ""));
  }
  if (item.rating) bits.push("★".repeat(item.rating));
  if (item.price) bits.push("₪".repeat(item.price));
  if (item.address) bits.push(esc(item.address));
  return bits.join("<br>");
}

const mapView = createMapView({
  canvas: $("map-canvas"),
  message: $("map-message"),
  popupHtml: popupMarkup,
});

// Typing in the search box redraws the list on every key; the map takes the
// first change at once and then at most one update every 180 ms.
let mapPending = null;
let mapCooldown = null;

function renderMap(items) {
  mapPending = items;
  if (!mapCooldown) flushMap();
}

function flushMap() {
  mapCooldown = null;
  if (!mapPending) return;
  const items = mapPending;
  mapPending = null;
  if (state.view === "map") {
    mapView.show(items, {
      key: googleStatus().key, origin: state.origin, radius: state.radius, scope: state.tab,
    });
  }
  mapCooldown = setTimeout(flushMap, 180);
}

/* ---------- Google usage & settings ---------- */

function formatReset(isoDate) {
  const date = new Date(isoDate + "T00:00:00");
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function applyGoogleStatus() {
  state.google = googleStatus();
  renderGoogleUsage();
}

function usageMarkup(g, withSettingsLink) {
  const reset = formatReset(g.resets_on);
  const paused = [];
  const rows = g.usage.map((u) => {
    const exact = u.limit ? Math.min(100, (u.used / u.limit) * 100) : 100;
    const full = u.used >= u.limit;
    const level = full ? "full" : exact >= 75 ? "high" : "ok";
    if (full) paused.push(u.label.toLowerCase());
    // Small amounts must not round down to "0%" (5 of 9,000 map loads is 0.06%),
    // nor 897 of 900 round up to a "100%" that isn't actually the limit.
    const shown = !u.used ? "0%"
      : exact < 1 ? "<1%"
      : exact < 10 ? (Math.round(exact * 10) / 10) + "%"
      : full ? "100%"
      : Math.min(99, Math.round(exact)) + "%";
    const width = u.used ? Math.max(exact, 1.5) : 0;
    return '<div class="usage-row ' + level + '">' +
      '<span class="usage-label">' + esc(u.label) + "</span>" +
      '<span class="usage-track" role="progressbar" aria-label="' + esc(u.label) + '" ' +
      'aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + (Math.round(exact * 10) / 10) + '" ' +
      'aria-valuetext="' + shown + " of the safe limit, " + u.used + " of " + u.limit + '">' +
      '<span class="usage-fill" style="width:' + width + '%"></span></span>' +
      '<span class="usage-value">' + shown + "</span>" +
      '<span class="usage-count">' + u.used.toLocaleString() + " / " +
      u.limit.toLocaleString() + "</span></div>";
  }).join("");

  const note = paused.length
    ? "<strong>Paused:</strong> " + esc(paused.join(", ")) + ". Google won't be called for " +
      (paused.length === 1 ? "it" : "them") + " until " + esc(reset) + ", so it can't cost money."
    : "Each bar stops Google at 100% — that's 90% of Google's free monthly allowance." +
      (g.shared ? " The counts are shared by everyone in the diary." : "");

  return '<div class="usage-head">' +
    "<h2>Google Maps this month</h2>" +
    '<span class="usage-connected">' + icon("check") + "Connected</span>" +
    '<span class="usage-reset">Resets ' + esc(reset) + "</span>" +
    (withSettingsLink ? '<button type="button" class="link-btn" data-open-settings>Settings</button>' : "") +
    "</div>" +
    '<div class="usage-rows">' + rows + "</div>" +
    '<p class="usage-note">' + note + "</p>";
}

function renderGoogleUsage() {
  const g = state.google;
  const page = $("google-usage");
  const sheet = $("settings-usage");
  page.hidden = false;
  if (!g.configured) {
    page.innerHTML = '<div class="usage-off">' + icon("map") +
      "<p><strong>Using free OpenStreetMap.</strong> Connect Google Maps for better " +
      "restaurant coverage — it stops itself before it could cost money.</p>" +
      '<button type="button" class="btn btn-ghost btn-sm" data-open-settings>' +
      "Connect Google Maps</button></div>";
    sheet.hidden = true;
    sheet.innerHTML = "";
    return;
  }
  page.innerHTML = usageMarkup(g, true);
  sheet.hidden = false;
  sheet.innerHTML = usageMarkup(g, false);
}

function renderGoogleSettings() {
  const g = state.google;
  const connected = g.configured;
  $("google-key").value = "";
  $("google-site").textContent = SITE_URL + "*";
  // The saved key is never shown in full, so the box stays empty; say plainly
  // that a connection exists so it doesn't look unsaved.
  $("google-state").hidden = !connected;
  $("google-state").innerHTML = connected
    ? icon("check") + "<div><strong>Connected.</strong> Your key (" + esc(g.masked) + ") is saved " +
      (g.shared ? "in your shared diary, so every phone and computer in it uses it."
        : "on this device.") + " You don't need to enter it again.</div>"
    : "";
  $("google-hint").hidden = connected;
  $("google-key-label").textContent = connected ? "Replace key" : "API key";
  $("google-key").placeholder = connected ? "Only if you want to change it" : "AIza…";
  $("google-save").textContent = connected ? "Save new key" : "Save key";
  $("google-error").hidden = true;
  $("google-remove").hidden = !connected;
}

function openSettings() {
  applyGoogleStatus();
  renderGoogleSettings();
  renderInstall();
  openLayer("settings-modal", closeSettings);
  // The other phone may have used Google since this one last looked.
  refreshUsage();
}

function closeSettings() {
  closeLayer("settings-modal");
}

async function saveGoogleSettings(remove) {
  const key = $("google-key").value.trim();
  if (!remove && !key) {
    $("google-key").focus();
    return;
  }
  const button = remove ? $("google-remove") : $("google-save");
  button.disabled = true;
  try {
    await saveGoogleKey(remove ? "" : key);
  } catch (err) {
    $("google-error").textContent = err.message;
    $("google-error").hidden = false;
    return;
  } finally {
    button.disabled = false;
  }
  applyGoogleStatus();
  renderGoogleSettings();
  toast(remove ? "Google Maps disconnected." : "Google Maps key saved.");
  if (state.view === "map") render();
}

/* ---------- installing on a phone ---------- */

let installPrompt = null;

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  renderInstall();
});

function renderInstall() {
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  $("install-section").hidden = !!standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const touch = window.matchMedia("(pointer: coarse)").matches;
  $("install-btn").hidden = !installPrompt;
  $("install-hint").textContent = installPrompt
    ? "Install the diary: it opens like an app, full screen, and works without a connection."
    : ios ? "In Safari, tap the Share button, then “Add to Home Screen”. The diary then opens like an app."
    : touch ? "In your browser's menu, choose “Add to Home screen” or “Install app”. The diary then opens " +
      "like an app."
    : "Open " + SITE_URL + " on your phone and add it to the home screen: it opens like an app, full screen.";
}

/* ---------- sharing with a friend ---------- */

const SYNC_LABELS = {
  idle: "Not sharing",
  connecting: "Connecting…",
  syncing: "Syncing…",
  synced: "Everything is in sync",
  offline: "Offline — changes will send later",
  error: "Sync problem",
};

let shareBusy = "";
let shareError = "";
let leaveArmed = false;

function renderShareButton() {
  const sharing = !!cloud.diary;
  $("share-label").textContent = sharing ? "Shared diary" : "Share with a friend";
  $("share-label-short").textContent = sharing ? "Shared" : "Share";
  $("sync-dot").hidden = !sharing;
  $("sync-dot").dataset.status = cloud.status;
  $("share-open").setAttribute("aria-label", sharing
    ? "Shared diary: " + (SYNC_LABELS[cloud.status] || "") : "Share with a friend");
}

function spinnerMarkup() {
  return '<span class="spinner-inline" aria-hidden="true"></span>';
}

function renderShare() {
  const body = $("share-body");
  if (!cloud.diary) {
    if (cloud.status === "connecting" && !shareBusy) {
      body.innerHTML = '<p class="menu-status">' + spinnerMarkup() + "Connecting…</p>";
      return;
    }
    const typed = $("join-code") ? $("join-code").value : "";
    body.innerHTML =
      '<div class="share-card"><h3>Share this diary</h3>' +
      "<p>You get a code to send to a friend. Every restaurant, rating, note and photo on this device goes " +
      "into the shared diary, and you both see each other's changes as they happen.</p>" +
      '<button type="button" class="btn btn-primary" id="share-start"' + (shareBusy ? " disabled" : "") + ">" +
      (shareBusy === "share" ? spinnerMarkup() + "Setting up…" : icon("share") + "Share this diary") +
      "</button></div>" +
      '<div class="share-card"><h3>Join with a code</h3>' +
      "<p>Got a code from a friend, or already sharing on another device, like your computer? Type it " +
      "here. Anything you added on this device comes along.</p>" +
      '<form class="share-join" id="share-join">' +
      '<label class="sr-only" for="join-code">Diary code</label>' +
      '<input id="join-code" class="code-input" autocomplete="off" autocapitalize="characters" ' +
      'spellcheck="false" maxlength="12" placeholder="ABCD1234" enterkeyhint="go" value="' + esc(typed) + '">' +
      '<button type="submit" class="btn btn-ghost"' + (shareBusy ? " disabled" : "") + ">" +
      (shareBusy === "join" ? spinnerMarkup() + "Joining…" : "Join") + "</button></form></div>" +
      (shareError ? '<p class="menu-error" role="alert">' + esc(shareError) + "</p>" : "");
    return;
  }

  const code = cloud.diary.invite_code;
  const pending = store.outbox.length + store.photoOutbox.length;
  const trouble = cloud.status === "error" || cloud.status === "offline";
  const touch = window.matchMedia("(pointer: coarse)").matches && navigator.share;
  body.innerHTML =
    '<div class="sync-status" data-status="' + esc(cloud.status) + '">' +
    icon(trouble ? "cloud-off" : "cloud") +
    '<span class="sync-text"><strong>' + esc(SYNC_LABELS[cloud.status] || "") + "</strong>" +
    "<small>" + (pending ? pending + " change" + (pending === 1 ? "" : "s") + " waiting to send"
      : "Changes show up on every device in the diary") + "</small></span>" +
    '<button type="button" class="btn-icon" id="sync-now" aria-label="Sync now" title="Sync now">' +
    icon("refresh") + "</button></div>" +
    (cloud.error ? '<p class="menu-error" role="alert">' + esc(cloud.error) + "</p>" : "") +
    '<h3 class="settings-heading">Your diary’s code</h3>' +
    '<div class="code-row"><code class="code-box">' + esc(code) + "</code>" +
    '<button type="button" class="btn btn-ghost btn-sm" id="copy-code">' + icon("copy") + "Copy</button></div>" +
    '<p class="hint">Every device joins once with this code — your friend’s, and your own phone or computer ' +
    "too. On that device, open the diary, tap <strong>Share</strong>, choose <strong>Join with a code</strong> " +
    "and type it.</p>" +
    '<button type="button" class="btn btn-primary share-invite" id="send-invite">' + icon("share") +
    (touch ? "Send an invite" : "Copy an invite message") + "</button>" +
    '<button type="button" class="link-btn share-leave' + (leaveArmed ? " is-armed" : "") + '" id="share-leave">' +
    icon("logout") + (leaveArmed ? "Tap again to stop — you can rejoin with the code"
      : "Stop sharing on this device") + "</button>";
}

function openShare() {
  shareError = "";
  leaveArmed = false;
  renderShare();
  openLayer("share-modal", closeShare);
}

function closeShare() {
  closeLayer("share-modal");
}

async function runShare(which, action, done) {
  shareBusy = which;
  shareError = "";
  renderShare();
  try {
    await action();
    toast(done);
  } catch (err) {
    shareError = err.message;
  } finally {
    shareBusy = "";
    applyGoogleStatus();
    render(true);
    renderShare();
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    return false;
  }
}

async function sendInvite() {
  const code = cloud.diary.invite_code;
  const text = "Join my restaurant diary!\n1. Open " + SITE_URL + "\n2. Tap “Share” → “Join with a code”\n" +
    "3. Type the code " + code;
  if (navigator.share && window.matchMedia("(pointer: coarse)").matches) {
    try {
      await navigator.share({ title: "Restaurant Diary", text });
      return;
    } catch (err) {
      if (err.name === "AbortError") return;
    }
  }
  toast(await copyText(text) ? "Invite copied — paste it in a message."
    : "Couldn't copy it. The code is " + code + ".");
}

/* ---------- dialogs and the Back button ----------
   Every open dialog takes a step in the browser history, so the phone's Back
   button or swipe closes the dialog instead of leaving the diary. */

const layers = [];
let ignorePops = 0;
let closingFromBack = false;

function openLayer(id, close, guard) {
  $(id).hidden = false;
  document.body.classList.add("has-sheet");
  layers.push({ id, close, guard });
  try {
    history.pushState({ diaryLayer: id }, "");
  } catch (err) {
    /* history unavailable: the close buttons still work */
  }
}

function closeLayer(id) {
  $(id).hidden = true;
  const index = layers.findIndex((layer) => layer.id === id);
  if (index < 0) return;
  layers.splice(index, 1);
  if (!layers.length) {
    document.body.classList.remove("has-sheet");
    if (remoteRedrawWaiting) setTimeout(redrawForRemote, 0);
  }
  if (!closingFromBack) {
    ignorePops += 1;
    history.back();
  }
}

window.addEventListener("popstate", () => {
  if (ignorePops > 0) {
    ignorePops -= 1;
    return;
  }
  const top = layers[layers.length - 1];
  if (!top) return;
  // Back is easy to press by accident: typed notes aren't thrown away without asking.
  if (top.guard && !top.guard()) {
    try {
      history.pushState({ diaryLayer: top.id }, "");
    } catch (err) {
      /* ignore */
    }
    return;
  }
  closingFromBack = true;
  try {
    top.close();
  } finally {
    closingFromBack = false;
  }
});

function anyModalOpen() {
  return layers.length > 0;
}

// Cards animate in when the list is loaded or the tab changes, not on every
// filter keystroke, where replaying the entrance just makes the page flicker.
function render(animate) {
  $("list").classList.toggle("calm", !animate);
  const wishlist = state.items.filter((i) => i.status === "wishlist");
  const visited = state.items.filter((i) => i.status === "visited");
  const rated = visited.filter((i) => i.rating > 0);
  const average = rated.length
    ? (rated.reduce((sum, i) => sum + i.rating, 0) / rated.length).toFixed(1)
    : "–";

  $("stats").innerHTML =
    '<div class="stat"><div class="stat-value">' + wishlist.length + '</div>' +
    '<div class="stat-label">To try</div></div>' +
    '<div class="stat"><div class="stat-value">' + visited.length + '</div>' +
    '<div class="stat-label">Visited</div></div>' +
    '<div class="stat"><div class="stat-value">' + average + '</div>' +
    '<div class="stat-label"><span class="stat-long">Average rating</span>' +
    '<span class="stat-short">Avg rating</span></div></div>';

  document.querySelectorAll('[data-count="wishlist"]').forEach((el) => { el.textContent = wishlist.length; });
  document.querySelectorAll('[data-count="visited"]').forEach((el) => { el.textContent = visited.length; });

  refreshFilterOptions();
  updateFilterBar();

  const items = visibleItems();
  const showingMap = state.view === "map";

  const note = $("list-note");
  if (state.origin || state.openNow) {
    const inTab = state.items.filter((i) => i.status === state.tab);
    const places = items.length + " place" + (items.length === 1 ? "" : "s");
    let text;
    if (state.origin && state.radius > 0) {
      text = places + (state.openNow ? " open now" : "") + " within " + state.radius + " km of you.";
    } else if (state.origin) {
      text = places + (state.openNow ? " open now" : "") + ", closest first.";
    } else {
      text = places + " open right now.";
    }

    const hidden = [];
    if (state.origin) {
      const withoutLocation = inTab.filter((i) => distanceKm(i) === null).length;
      if (withoutLocation) {
        hidden.push(withoutLocation + " with no known location " +
          (state.radius > 0 ? "hidden" : "listed last"));
      }
    }
    if (state.openNow) {
      const withoutHours = inTab.filter((i) => !hasReadableHours(i)).length;
      if (withoutHours) hidden.push(withoutHours + " with no listed opening hours hidden");
    }
    if (hidden.length) text += " " + hidden.join("; ") + ".";

    note.textContent = text;
    note.hidden = false;
  } else {
    note.hidden = true;
  }

  $("list").hidden = showingMap;
  $("map").hidden = !showingMap;
  $("list").setAttribute("aria-labelledby", "tab-" + state.tab);

  if (showingMap) {
    renderMap(items);
  } else {
    $("list").innerHTML = items.length ? items.map(cardMarkup).join("") : emptyMarkup();
    hydratePhotos($("list"));
  }
}

// Changes from the other devices redraw the page, except under someone's hands:
// while a dialog is open or the list has focus, they wait for it to close.
let remoteRedrawWaiting = false;

function redrawForRemote() {
  if (anyModalOpen() || $("list").contains(document.activeElement)) {
    remoteRedrawWaiting = true;
    return;
  }
  remoteRedrawWaiting = false;
  render();
}

/* ---------- duplicates ---------- */

// Words that differ between two records of the same place ("OCD" vs "OCD
// Restaurant", "Café X" vs "Cafe X") and would hide an obvious duplicate.
const GENERIC_NAME_WORDS = /\b(restaurant|ristorante|cafe|caffe|coffee|bar|bistro|the)\b/g;
const GENERIC_HEBREW_WORDS = /(^|\s)(מסעדת|מסעדה|קפה|בית קפה)(?=\s|$)/g;

function normalizeName(name) {
  const base = String(name || "").toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u0591-\u05c7]/g, "")
    .replace(/['"״׳`’.,!?&()\-–—_/:]+/g, " ");
  const stripped = base.replace(GENERIC_NAME_WORDS, " ").replace(GENERIC_HEBREW_WORDS, " ")
    .replace(/\s+/g, " ").trim();
  return stripped || base.replace(/\s+/g, " ").trim();
}

function namesMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  // Containment only for names long enough not to match by accident.
  return Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a));
}

function findDuplicates(place) {
  const names = [place.name, place.local_name].map(normalizeName).filter(Boolean);
  const lat = parseFloat(place.lat);
  const lon = parseFloat(place.lon);
  const located = isFinite(lat) && isFinite(lon);

  return state.items.filter((item) => {
    if (place.google_place_id && place.google_place_id === item.google_place_id) return true;
    if (place.osm_id && item.osm_id && String(place.osm_id) === String(item.osm_id) &&
        (place.osm_type || "") === (item.osm_type || "")) {
      return true;
    }
    // A Google suggestion has no location yet, so a name alone would flag every
    // branch of a chain; the full check runs once its details are loaded.
    if (place.needs_details) return false;
    const itemNames = [item.name, item.local_name].map(normalizeName).filter(Boolean);
    if (!names.some((a) => itemNames.some((b) => namesMatch(a, b)))) return false;

    // Same name: only a duplicate if it's the same spot, so another branch of
    // a chain (Miznon Paris vs Miznon Tel Aviv) can still be added freely.
    const itemLat = parseFloat(item.lat);
    const itemLon = parseFloat(item.lon);
    if (located && isFinite(itemLat) && isFinite(itemLon)) {
      return haversineKm({ lat: lat, lon: lon }, { lat: itemLat, lon: itemLon }) <= 0.5;
    }
    const city = normalizeName(place.city);
    const itemCity = normalizeName(item.city);
    return !city || !itemCity || city === itemCity;
  });
}

function listName(item) {
  return item.status === "visited" ? "your visits" : "your wishlist";
}

function renderDuplicateWarning(place) {
  const box = $("dup-warning");
  const matches = findDuplicates(place);
  $("save-place").textContent = matches.length ? "Add anyway" : "Save restaurant";

  if (!matches.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  const first = matches[0];
  const added = first.added_at ? new Date(first.added_at).toLocaleDateString() : "";
  box.innerHTML = icon("bookmark") + '<div class="dup-body"><p><strong>' +
    (matches.length === 1
      ? "Looks like this is already in " + esc(listName(first))
      : "You may already have this " + matches.length + " times") +
    "</strong> — " + esc(first.name) + (first.city ? ", " + esc(first.city) : "") +
    (added ? " (added " + esc(added) + ")" : "") + ".</p>" +
    '<button type="button" class="btn btn-ghost btn-sm" data-reveal="' + esc(first.id) + '">' +
    "Show me the saved one</button></div>";
  box.hidden = false;
}

function revealItem(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  closeAdd();
  setView("list");
  state.tab = item.status;
  syncTabs();

  if (!visibleItems().some((i) => i.id === id)) {
    clearFilters();
    render(true);
    toast("Cleared your filters to show " + item.name + ".");
  }

  const card = $("list").querySelector('[data-card-id="' + CSS.escape(id) + '"]');
  if (!card) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  card.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), 2000);
  const focusable = card.querySelector("button, a");
  if (focusable) focusable.focus({ preventScroll: true });
}

/* ---------- open now ---------- */

function setOpenNow(on) {
  state.openNow = on;
  setChipOn($("open-now"), on, "clock");
}

/* ---------- filter bar ---------- */

// An "on" toggle chip swaps its icon for a check mark as well as changing
// colour, so its state doesn't rely on colour alone.
function setChipOn(button, on, offIcon) {
  button.classList.toggle("is-on", on);
  button.setAttribute("aria-pressed", on ? "true" : "false");
  button.querySelector("use").setAttribute("href", "#i-" + (on ? "check" : offIcon));
}

function clearFilters() {
  state.filter = "";
  $("filter").value = "";
  state.cuisine = "";
  state.city = "";
  setOpenNow(false);
  if (state.origin) setOrigin(null);
}

function updateFilterBar() {
  document.querySelectorAll(".chip-value").forEach((label) => {
    const select = $(label.dataset.for);
    const option = select.options[select.selectedIndex];
    label.textContent = option ? option.textContent : "";
  });
  $("cuisine-wrap").classList.toggle("is-on", !!state.cuisine);
  $("city-wrap").classList.toggle("is-on", !!state.city);

  const active = [state.openNow, !!state.origin, !!state.cuisine, !!state.city].filter(Boolean).length;
  $("filters-count").textContent = active;
  $("filters-count").hidden = !active;
  $("clear-filters").hidden = !(active || state.filter.trim());
}

/* ---------- search country ---------- */

// ISO 3166-1 codes; the browser supplies the names, so no list of names to maintain.
const COUNTRY_CODES = (
  "AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ " +
  "BR BS BT BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM " +
  "DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR " +
  "GT GU GW GY HK HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN " +
  "KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP " +
  "MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK " +
  "PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR " +
  "SS ST SV SX SY SZ TC TD TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE " +
  "VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(" ");

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" });
  } catch (err) {
    return null;
  }
})();

function countryName(code) {
  if (!code) return "";
  try {
    return (regionNames && regionNames.of(code.toUpperCase())) || code.toUpperCase();
  } catch (err) {
    return code.toUpperCase();
  }
}

function buildCountryOptions() {
  const others = COUNTRY_CODES.filter((c) => c !== "IL")
    .map((c) => ({ code: c.toLowerCase(), name: countryName(c) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  $("search-country").innerHTML =
    '<option value="">Any country</option>' +
    '<option value="il">' + esc(countryName("IL")) + "</option>" +
    '<optgroup label="All countries">' +
    others.map((c) => '<option value="' + c.code + '">' + esc(c.name) + "</option>").join("") +
    "</optgroup>";
}

function showSearchCountry() {
  $("search-country").value = state.searchCountry;
  $("country-wrap").querySelector(".chip-value").textContent =
    state.searchCountry ? countryName(state.searchCountry) : "Any country";
  $("country-wrap").classList.toggle("is-on", !!state.searchCountry);
}

// Kept on this device until it's changed, so each person can search their own way.
function setSearchCountry(code) {
  state.searchCountry = /^[a-z]{2}$/.test(code || "") ? code : "";
  writeSetting("search-country", state.searchCountry || null);
  showSearchCountry();
  const query = $("place-search").value.trim();
  if (query.length >= 3) runSearch(query);
}

/* ---------- add flow ---------- */

let searchTimer = null;
let searchSeq = 0;

function resetAddModal() {
  state.selectedPlace = null;
  state.results = [];
  state.activeResult = -1;
  state.draftRating = 0;
  $("place-search").value = "";
  $("results").innerHTML = "";
  $("results-empty").hidden = true;
  $("step-search").hidden = false;
  $("step-confirm").hidden = true;
  $("add-foot").hidden = true;
  $("dishes").value = "";
  $("review").value = "";
  $("wish-note").value = "";
  const wishRadio = document.querySelector('input[name="status"][value="wishlist"]');
  if (wishRadio) wishRadio.checked = true;
  $("review-block").hidden = true;
  $("wish-block").hidden = false;
  $("place-search").setAttribute("aria-expanded", "false");
  setSearchNotice("");
  $("search-credit").hidden = true;
  clearDraftPhotos();
}

function setSearchNotice(text) {
  $("search-notice").textContent = text;
  $("search-notice").hidden = !text;
}

function openAdd() {
  resetAddModal();
  // One Google session per search; Google groups its suggestions with the
  // details lookup that ends it for billing.
  state.searchSession = newSession();
  applyGoogleStatus();
  refreshUsage();
  openLayer("add-modal", closeAdd, confirmLeaveAdd);
  setTimeout(() => $("place-search").focus(), 60);
}

function closeAdd() {
  closeLayer("add-modal");
}

// Leaving with Back after typing notes or adding photos asks first.
function confirmLeaveAdd() {
  if ($("step-confirm").hidden) return true;
  const typed = $("review").value.trim() || $("dishes").value.trim() || $("wish-note").value.trim() ||
    state.pendingPhotos.length || state.draftRating;
  return !typed || window.confirm("Leave without saving this restaurant?");
}

function resultMarkup(place, index) {
  const cuisine = prettyCuisine(place.cuisine);
  const place_type = (place.place_type || "").replace(/_/g, " ");
  let tags = "";
  if (cuisine) tags += '<span class="tag-mini">' + esc(cuisine) + "</span>";
  if (place_type) tags += '<span class="tag-mini">' + esc(place_type) + "</span>";
  if (place.opening_hours) tags += '<span class="tag-mini">hours listed</span>';
  const saved = findDuplicates(place)[0];
  if (saved) {
    tags = '<span class="tag-mini tag-saved">Already in ' + esc(listName(saved)) + "</span>" + tags;
  }

  // Index entries often have no street address, where full_address falls back
  // to the name - showing it again would just repeat the title.
  const where = place.full_address || place.address || "";
  const subtitle = where && where !== place.name ? where
    : place.source === "google" ? "" : (place.city || "No address listed");

  return '<li role="option" aria-selected="false" id="result-' + index + '">' +
    '<button type="button" class="result" data-index="' + index + '" tabindex="-1">' +
    '<span class="result-mark">' + icon("utensils") + "</span>" +
    '<span class="result-body">' +
    '<span class="result-name">' + esc(place.name) +
    (place.local_name ? '<span class="result-local"> · ' + esc(place.local_name) + "</span>" : "") +
    "</span>" +
    '<span class="result-addr">' + esc(subtitle) + "</span>" +
    (tags ? '<span class="result-tags">' + tags + "</span>" : "") +
    "</span></button></li>";
}

function renderResults(places, query, source) {
  state.results = places;
  state.activeResult = -1;
  const list = $("results");
  const empty = $("results-empty");
  $("search-credit").hidden = !(source === "google" && places.length);

  if (!places.length) {
    list.innerHTML = "";
    empty.hidden = false;
    const where = state.searchCountry ? " in " + esc(countryName(state.searchCountry)) : "";
    empty.innerHTML = "No restaurant or café called <strong>" + esc(query) + "</strong>" + where +
      ". Check the spelling, add the city (“Name, Tel Aviv”), " +
      "or add it yourself with just the name." +
      '<div class="results-empty-actions">' +
      (state.searchCountry
        ? '<button type="button" class="btn btn-ghost btn-sm" id="search-any">' +
          icon("globe") + "Search all countries</button>"
        : "") +
      '<button type="button" class="btn btn-ghost btn-sm" id="manual-add">' +
      icon("plus") + "Add “" + esc(query) + "” manually</button></div>";
    $("place-search").setAttribute("aria-expanded", "false");
    return;
  }
  empty.hidden = true;
  list.innerHTML = places.map(resultMarkup).join("");
  $("place-search").setAttribute("aria-expanded", "true");
}

// Google first while it's set up and both the suggestion and the follow-up
// details lookup fit this month's limits. Otherwise, or if Google fails, the
// free OpenStreetMap search answers instead.
async function searchPlaces(query) {
  let notice = "";
  if (googleStatus().configured) {
    if (hasRoom("autocomplete") && hasRoom("details")) {
      try {
        return {
          places: await autocomplete(query, state.searchSession, state.searchCountry),
          source: "google",
        };
      } catch (err) {
        notice = err.message + " Showing free OpenStreetMap results instead.";
      }
    } else {
      notice = limitMessage(hasRoom("details") ? "autocomplete" : "details") +
        " Search is using free OpenStreetMap meanwhile.";
    }
  }
  return { places: await searchFreePlaces(query, state.searchCountry), source: "osm", notice };
}

function runSearch(query) {
  const seq = ++searchSeq;
  $("search-spinner").hidden = false;

  searchPlaces(query)
    .then((data) => {
      if (seq !== searchSeq) return;
      applyGoogleStatus();
      setSearchNotice(data.notice || "");
      renderResults(data.places || [], query, data.source);
    })
    .catch((err) => {
      if (seq !== searchSeq) return;
      state.results = [];
      $("results").innerHTML = "";
      $("results-empty").hidden = false;
      $("results-empty").innerHTML = esc(err.message) +
        '<br><button type="button" class="btn btn-ghost btn-sm" id="manual-add">' +
        icon("plus") + "Add “" + esc(query) + "” manually</button>";
    })
    .finally(() => {
      if (seq === searchSeq) $("search-spinner").hidden = true;
    });
}

function setActiveResult(index) {
  const buttons = $("results").querySelectorAll(".result");
  if (!buttons.length) return;
  const next = (index + buttons.length) % buttons.length;
  buttons.forEach((btn, i) => {
    btn.classList.toggle("is-active", i === next);
    btn.parentElement.setAttribute("aria-selected", i === next ? "true" : "false");
  });
  state.activeResult = next;
  buttons[next].scrollIntoView({ block: "nearest" });
}

// Google suggestions carry only a name; the details (hours, phone, price...)
// are one billed lookup, made only for the place actually picked.
async function choosePlace(place, row) {
  if (!place.needs_details) {
    showConfirm(place);
    return;
  }
  if (state.choosing) return;
  state.choosing = true;
  if (row) row.classList.add("is-loading");
  $("search-spinner").hidden = false;
  try {
    const details = await placeDetails(place.google_place_id, state.searchSession, state.searchCountry);
    applyGoogleStatus();
    state.searchSession = newSession();
    showConfirm(details);
  } catch (err) {
    applyGoogleStatus();
    if (err instanceof LimitReached) {
      // Limit just reached: search again, which now answers from OpenStreetMap.
      runSearch($("place-search").value.trim());
    } else {
      setSearchNotice(err.message + " You can pick another result or add it manually.");
    }
  } finally {
    state.choosing = false;
    if (row) row.classList.remove("is-loading");
    $("search-spinner").hidden = true;
  }
}

function showConfirm(place) {
  state.selectedPlace = place;
  const manual = !!place.manual;
  const sourceName = place.source === "google" ? "Google Maps" : "OpenStreetMap";

  let html = "<h3>" + esc(place.name) + "</h3>";
  if (manual) {
    html += '<div class="field" style="margin:16px 0 0">' +
      '<label class="field-label" for="manual-name">Name</label>' +
      '<input type="text" id="manual-name" value="' + esc(place.name) + '">' +
      '<span class="field-help">Not found in search, so address and hours stay empty ' +
      "— you can still track it.</span></div>" +
      '<div class="field" style="margin:16px 0 0">' +
      '<label class="field-label" for="manual-city">City <span style="text-transform:none">(optional)</span></label>' +
      '<input type="text" id="manual-city" value="' + esc(place.city || "") + '"></div>';
  } else {
    const cuisine = prettyCuisine(place.cuisine);
    if (place.local_name) html += '<div class="card-local">' + esc(place.local_name) + "</div>";
    if (cuisine) html += '<div class="card-cuisine">' + esc(cuisine) + "</div>";
    html += '<div class="card-meta">' + metaMarkup(place, true) + "</div>";
    html += '<div class="preview-note">' + icon("check") +
      "<span>Details from " + sourceName + ".</span></div>";
  }
  $("preview").innerHTML = html;

  $("step-search").hidden = true;
  $("step-confirm").hidden = false;
  $("add-foot").hidden = false;
  renderDuplicateWarning(place);
  if (manual) {
    $("manual-name").addEventListener("input", () => {
      renderDuplicateWarning({ name: $("manual-name").value, city: $("manual-city").value });
    });
    $("manual-city").addEventListener("input", () => {
      renderDuplicateWarning({ name: $("manual-name").value, city: $("manual-city").value });
    });
  }

  state.draftPrice = place.price || 0;
  $("price-help").textContent = manual
    ? "Optional — tap again to clear."
    : place.price
      ? "Filled in from " + sourceName + " — change it if that looks wrong."
      : "Optional — " + sourceName + " has no price for this one. Tap again to clear.";

  buildStars("rating-input", "draftRating");
  buildShekels("price-input", "draftPrice");
}

function buildPicker(containerId, stateKey, kind) {
  const container = $(containerId);
  const current = state[stateKey];
  const isStar = kind === "star";
  const cls = isStar ? "star-btn" : "shekel-btn";
  let html = "";

  for (let i = 1; i <= 5; i += 1) {
    const label = isStar
      ? i + " star" + (i > 1 ? "s" : "")
      : "Price level " + i + " of 5";
    html += '<button type="button" class="' + cls + " " + (i <= current ? "on" : "") +
      '" data-value="' + i + '" role="radio" aria-checked="' + (i === current) +
      '" aria-label="' + label + '">' + (isStar ? icon("star") : "₪") + "</button>";
  }

  container.innerHTML = html;
  container.onclick = (event) => {
    const btn = event.target.closest("." + cls);
    if (!btn) return;
    const value = Number(btn.dataset.value);
    state[stateKey] = state[stateKey] === value ? 0 : value;
    buildPicker(containerId, stateKey, kind);
  };
}

function buildStars(containerId, stateKey) {
  buildPicker(containerId, stateKey, "star");
}

function buildShekels(containerId, stateKey) {
  buildPicker(containerId, stateKey, "shekel");
}

async function savePlace() {
  const place = state.selectedPlace;
  if (!place) return;

  const status = (document.querySelector('input[name="status"]:checked') || {}).value || "wishlist";
  const item = {
    id: newId(),
    name: place.manual ? ($("manual-name").value || "").trim() : place.name,
    local_name: place.local_name || "",
    status: status,
    address: place.address || "",
    city: place.manual ? ($("manual-city").value || "").trim() : (place.city || ""),
    country: place.manual ? countryName(state.searchCountry) : (place.country || ""),
    lat: place.lat || "",
    lon: place.lon || "",
    cuisine: place.cuisine || "",
    opening_hours: place.opening_hours || "",
    phone: place.phone || "",
    website: place.website || "",
    osm_id: place.osm_id || null,
    osm_type: place.osm_type || null,
    google_place_id: place.google_place_id || "",
    google_rating: place.google_rating || 0,
    google_rating_count: place.google_rating_count || 0,
    google_maps_uri: place.google_maps_uri || "",
    price: state.draftPrice,
    source: place.google_place_id ? "google" : place.osm_id ? "osm" : "manual",
    added_at: nowIso(),
    dishes: [],
    photos: [],
  };

  if (!item.name) { toast("Give the restaurant a name first."); return; }

  if (status === "visited") {
    item.rating = state.draftRating;
    item.review = $("review").value.trim();
    item.dishes = $("dishes").value.split(",").map((d) => d.trim()).filter(Boolean);
    item.visited_at = nowIso();
  } else {
    item.wish_note = $("wish-note").value.trim();
  }

  const button = $("save-place");
  const buttonText = button.textContent;
  button.disabled = true;
  saveItem(item);

  let upload = null;
  if (status === "visited" && state.pendingPhotos.length) {
    upload = await addPhotos(item.id, state.pendingPhotos.map((p) => p.file), (n, total) => {
      button.textContent = "Saving photo " + n + " of " + total + "…";
    });
  }
  button.textContent = buttonText;
  button.disabled = false;

  closeAdd();
  state.tab = status;
  syncTabs();
  if (upload && upload.failures.length) {
    reportUpload(upload);
  } else {
    toast(item.name + (status === "visited" ? " added to your visits." : " added to your wishlist."));
  }

  // Look for the menu in the background; the card updates when it's done.
  if (item.website) {
    findMenu(item.id, "").then((updated) => {
      if (updated && updated.menu && updated.menu.url) toast("Found a menu for " + updated.name + ".");
    });
  }
}

/* ---------- review modal ---------- */

let reviewSnapshot = "";

function reviewValues() {
  return JSON.stringify([state.editRating, state.editPrice, $("edit-review").value.trim(),
    $("edit-dishes").value.trim()]);
}

function openReview(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  state.editingId = id;
  state.editRating = item.rating || 0;
  state.editPrice = item.price || 0;

  $("review-title").textContent = item.status === "visited" ? "Edit your notes" : "How was it?";
  $("review-for").innerHTML = "<strong>" + esc(item.name) + "</strong>";
  $("edit-dishes").value = (item.dishes || []).join(", ");
  $("edit-review").value = item.review || "";
  buildStars("edit-rating", "editRating");
  buildShekels("edit-price", "editPrice");
  renderEditPhotos();
  reviewSnapshot = reviewValues();

  openLayer("review-modal", closeReview, () =>
    reviewValues() === reviewSnapshot || window.confirm("Leave without saving your changes?"));
}

function closeReview() {
  closeLayer("review-modal");
  state.editingId = null;
}

function saveReview() {
  const item = state.editingId && store.get(state.editingId);
  if (!item) {
    toast("Nothing to save — reopen the restaurant and try again.");
    return;
  }
  const changes = {
    status: "visited",
    rating: state.editRating,
    price: state.editPrice,
    review: $("edit-review").value.trim(),
    dishes: $("edit-dishes").value.split(",").map((d) => d.trim()).filter(Boolean),
  };
  if (!item.visited_at) changes.visited_at = nowIso();
  updateItem(item.id, changes);
  closeReview();
  state.tab = "visited";
  syncTabs();
  toast("Saved.");
}

function removeItem(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  if (!window.confirm("Remove “" + item.name + "” from your diary? This cannot be undone.")) return;
  deleteItem(id);
  render();
  toast(item.name + " removed.");
}

/* ---------- photos ---------- */

// Phone photos are often 4-12 MB; 1600px JPEGs look the same on screen at a
// tenth of the size, which keeps the diary and page loads light.
const PHOTO_MAX_SIDE = 1600;
const MAX_PHOTOS_PER_PLACE = 40;

async function compressImage(file) {
  if (file.type && !file.type.startsWith("image/")) {
    throw new Error(file.name + " isn't an image.");
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (err) {
    throw new Error("Couldn't read " + file.name +
      " — try a JPG or PNG (iPhone HEIC photos may need converting first).");
  }
  const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (bitmap.close) bitmap.close();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  if (!blob) throw new Error("Couldn't prepare " + file.name + ".");
  return blob;
}

// Each photo is kept on this device straight away and sent to the shared diary
// with the next sync, so adding photos works without a connection too.
async function addPhotos(id, files, onProgress) {
  const failures = [];
  let saved = 0;
  for (let i = 0; i < files.length; i += 1) {
    if (onProgress) onProgress(i + 1, files.length);
    try {
      const item = store.get(id);
      if (!item) throw new Error("This restaurant was removed.");
      if ((item.photos || []).length >= MAX_PHOTOS_PER_PLACE) {
        throw new Error("This restaurant already has " + MAX_PHOTOS_PER_PLACE + " photos, the limit.");
      }
      const blob = await compressImage(files[i]);
      const name = newId() + ".jpg";
      try {
        await putPhoto(name, blob);
      } catch (err) {
        throw new Error("This browser wouldn't store the photo (is it in private mode?).");
      }
      updateItem(id, { photos: (store.get(id).photos || []).concat(name) });
      queuePhoto(id, name, "upload");
      saved += 1;
    } catch (err) {
      failures.push(err.message);
    }
  }
  return { saved, failures };
}

function removePhoto(id, name) {
  const item = store.get(id);
  if (!item) return;
  updateItem(id, { photos: (item.photos || []).filter((p) => p !== name) });
  forgetPhoto(id, name);
  const url = localPhotoUrls.get(name);
  if (url) {
    URL.revokeObjectURL(url);
    localPhotoUrls.delete(name);
  }
}

function reportUpload(result) {
  if (result.failures.length) {
    toast(result.saved + " saved, " + result.failures.length + " failed: " + result.failures[0]);
  } else if (result.saved) {
    toast(result.saved === 1 ? "Photo saved." : result.saved + " photos saved.");
  }
}

function renderEditPhotos() {
  const item = state.items.find((i) => i.id === state.editingId);
  const photos = (item && item.photos) || [];
  $("edit-photos").innerHTML = photos.map((name, i) =>
    '<div class="photo-tile">' +
    '<button type="button" class="photo-open" data-index="' + i + '" aria-label="Open photo ' + (i + 1) + '">' +
    photoImg(item.id, name) + "</button>" +
    '<button type="button" class="photo-remove" data-name="' + esc(name) + '" aria-label="Remove photo ' +
    (i + 1) + '">' + icon("x") + "</button></div>").join("");
  hydratePhotos($("edit-photos"));
}

function renderDraftPhotos() {
  $("draft-photos").innerHTML = state.pendingPhotos.map((photo, i) =>
    '<div class="photo-tile">' +
    '<img src="' + esc(photo.url) + '" alt="Photo ' + (i + 1) + ' to add">' +
    '<button type="button" class="photo-remove" data-index="' + i + '" aria-label="Remove photo ' +
    (i + 1) + '">' + icon("x") + "</button></div>").join("");
}

function clearDraftPhotos() {
  state.pendingPhotos.forEach((photo) => URL.revokeObjectURL(photo.url));
  state.pendingPhotos = [];
  renderDraftPhotos();
}

/* ---------- photo viewer ---------- */

const viewer = { id: null, index: 0, returnFocus: null };

function openLightbox(id, index) {
  const item = state.items.find((i) => i.id === id);
  if (!item || !(item.photos || []).length) return;
  viewer.id = id;
  viewer.index = index;
  viewer.returnFocus = document.activeElement;
  openLayer("lightbox", closeLightbox);
  showLightboxPhoto();
  $("lightbox-close").focus();
}

async function showLightboxPhoto() {
  const item = state.items.find((i) => i.id === viewer.id);
  const photos = (item && item.photos) || [];
  if (!photos.length) { closeLightbox(); return; }
  viewer.index = (viewer.index + photos.length) % photos.length;
  const index = viewer.index;
  const img = $("lightbox-img");
  img.removeAttribute("src");
  img.alt = "Photo " + (index + 1) + " of " + photos.length + " from " + item.name;
  $("lightbox-caption").textContent = item.name + " — " + (index + 1) + " / " + photos.length;
  $("lightbox-prev").hidden = photos.length < 2;
  $("lightbox-next").hidden = photos.length < 2;
  const [url] = await photoSources([{ itemId: item.id, name: photos[index] }]);
  if (viewer.index === index && viewer.id === item.id && !$("lightbox").hidden) {
    if (url) img.src = url;
    else $("lightbox-caption").textContent += " — this photo hasn't arrived yet";
  }
}

function closeLightbox() {
  closeLayer("lightbox");
  $("lightbox-img").removeAttribute("src");
  if (viewer.returnFocus && document.contains(viewer.returnFocus)) viewer.returnFocus.focus();
}

/* ---------- menu ---------- */

let menuReturnFocus = null;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (err) {
    return "the website";
  }
}

const MENU_FINDER_VERSION = 2;

function openMenu(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  state.menuId = id;
  menuReturnFocus = document.activeElement;
  $("menu-title").textContent = "Menu — " + item.name;
  $("menu-url").value = "";
  openLayer("menu-modal", closeMenu);
  renderMenu(item);
  $("close-menu").focus();
  // Menus looked up by the older, weaker search get one automatic second try -
  // unless that search already read dishes, which a re-check must not throw away.
  const stale = item.menu && (item.menu.finder || 1) < MENU_FINDER_VERSION &&
    !(item.menu.items && item.menu.items.length);
  if (item.website && (!item.menu || stale)) findMenu(id, "");
}

function closeMenu() {
  closeLayer("menu-modal");
  state.menuId = null;
  if (menuReturnFocus && document.contains(menuReturnFocus)) menuReturnFocus.focus();
}

function renderMenu(item, busyText, errorText) {
  const body = $("menu-body");
  $("menu-retry").hidden = !item.website;
  $("menu-clear").hidden = !item.menu;

  if (busyText) {
    body.innerHTML = '<p class="menu-status"><span class="spinner-inline" aria-hidden="true"></span>' +
      esc(busyText) + "</p>";
    return;
  }

  let html = errorText ? '<p class="menu-error" role="alert">' + esc(errorText) + "</p>" : "";
  const menu = item.menu;

  if (!menu) {
    html += '<p class="menu-message">' + (item.website
      ? "Search " + esc(hostOf(item.website)) + " for a menu, or paste a link below."
      : "There's no website on record for " + esc(item.name) +
        ". Paste a menu link — or the restaurant's website and it will be searched.") + "</p>";
    body.innerHTML = html;
    return;
  }

  html += '<p class="menu-message">' + esc(menu.message) + "</p>";
  const url = safeUrl(menu.url);
  if (url) {
    html += '<a class="btn btn-primary btn-sm menu-open" href="' + esc(url) +
      '" target="_blank" rel="noopener noreferrer">' + icon("external") + "Open the menu</a>";
  }
  if (menu.items && menu.items.length) {
    html += '<ul class="menu-items">' + menu.items.map((dish) =>
      '<li><span class="menu-dish">' + esc(dish.name) +
      (dish.desc ? '<span class="menu-desc">' + esc(dish.desc) + "</span>" : "") + "</span>" +
      (dish.price ? '<span class="menu-price">' + esc(dish.price) + "</span>" : "") +
      "</li>").join("") + "</ul>";
  }
  const others = (menu.links || []).filter((l) => l.url !== menu.url && safeUrl(l.url)).slice(0, 4);
  if (others.length) {
    html += '<p class="field-label menu-other-label">Other links that might be the menu</p>' +
      '<ul class="menu-links">' + others.map((l) =>
        '<li><a href="' + esc(safeUrl(l.url)) + '" target="_blank" rel="noopener noreferrer">' +
        esc(l.label && l.label !== "Menu" ? l.label : hostOf(l.url)) + "</a></li>").join("") + "</ul>";
  }
  if (menu.checked_at) {
    html += '<p class="field-help">Checked ' + esc(new Date(menu.checked_at).toLocaleDateString()) + "</p>";
  }
  body.innerHTML = html;
}

function setMenuBusy(busy) {
  ["menu-retry", "menu-url-btn", "menu-clear"].forEach((id) => { $(id).disabled = busy; });
}

async function findMenu(id, url) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return null;
  if (state.menuId === id) {
    renderMenu(item, url
      ? "Reading " + hostOf(url.startsWith("http") ? url : "https://" + url) + "…"
      : "Looking through " + hostOf(item.website) + " for a menu…");
    setMenuBusy(true);
  }
  try {
    const menu = await findMenuOnline(item.website || "", url || "");
    const updated = updateItem(id, { menu });
    if (!updated) return null;
    if (state.menuId === id) renderMenu(updated);
    render();
    return updated;
  } catch (err) {
    const current = store.get(id);
    if (state.menuId === id && current) renderMenu(current, null, err.message);
    return null;
  } finally {
    if (state.menuId === id) setMenuBusy(false);
  }
}

/* ---------- near me ---------- */

function setView(view) {
  state.view = view;
  document.querySelectorAll(".view-btn").forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function setOrigin(origin) {
  state.origin = origin;
  const distanceOption = $("sort").querySelector('option[value="distance"]');
  const button = $("near-me");
  distanceOption.disabled = !origin;
  distanceOption.textContent = origin ? "Closest first" : "Closest (use Near me)";
  setChipOn(button, !!origin, "crosshair");
  button.title = origin ? "Click to stop filtering by distance" : "";
  $("radius-wrap").hidden = !origin;

  if (origin) {
    state.sort = "distance";
  } else if (state.sort === "distance") {
    state.sort = "added";
  }
  $("sort").value = state.sort;
}

/* ---------- tabs ---------- */

function syncTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.tab === state.tab;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll(".bottom-tab").forEach((tab) => {
    const active = tab.dataset.tab === state.tab;
    tab.classList.toggle("is-active", active);
    if (active) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  });
  render(true);
}

/* ---------- events ---------- */

$("open-add").addEventListener("click", openAdd);
$("bottom-add").addEventListener("click", openAdd);
$("close-add").addEventListener("click", closeAdd);
$("back-search").addEventListener("click", () => {
  $("step-confirm").hidden = true;
  $("add-foot").hidden = true;
  $("step-search").hidden = false;
  $("dup-warning").hidden = true;
  $("save-place").textContent = "Save restaurant";
  $("place-search").focus();
});

$("dup-warning").addEventListener("click", (event) => {
  const button = event.target.closest("[data-reveal]");
  if (button) revealItem(button.dataset.reveal);
});

$("open-now").addEventListener("click", () => {
  setOpenNow(!state.openNow);
  render();
});

$("filters-toggle").addEventListener("click", () => {
  const open = !$("filter-bar").classList.contains("is-open");
  $("filter-bar").classList.toggle("is-open", open);
  $("filters-toggle").setAttribute("aria-expanded", open ? "true" : "false");
});

$("clear-filters").addEventListener("click", () => {
  clearFilters();
  render();
  $("filter").focus();
});

// "Open now" and the open/closed badges go stale as the clock moves, so refresh
// once a minute - but never under the user's hands (open dialog, focus in the
// list) and never re-fit a map they may have panned unless the result changed.
let lastVisibleIds = "";
setInterval(() => {
  if (document.hidden || anyModalOpen() || !$("lightbox").hidden) return;
  if ($("list").contains(document.activeElement)) return;
  const ids = visibleItems().map((i) => i.id).join(",");
  if (state.view === "list" || ids !== lastVisibleIds) render();
  lastVisibleIds = ids;
}, 60000);
$("save-place").addEventListener("click", savePlace);

$("place-search").addEventListener("input", (event) => {
  const query = event.target.value.trim();
  clearTimeout(searchTimer);
  if (query.length < 3) {
    searchSeq += 1;
    $("search-spinner").hidden = true;
    $("results").innerHTML = "";
    $("results-empty").hidden = true;
    $("place-search").setAttribute("aria-expanded", "false");
    return;
  }
  searchTimer = setTimeout(() => runSearch(query), 350);
});

$("place-search").addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") { event.preventDefault(); setActiveResult(state.activeResult + 1); }
  else if (event.key === "ArrowUp") { event.preventDefault(); setActiveResult(state.activeResult - 1); }
  else if (event.key === "Enter") {
    if (state.activeResult >= 0 && state.results[state.activeResult]) {
      event.preventDefault();
      const rows = $("results").querySelectorAll(".result");
      choosePlace(state.results[state.activeResult], rows[state.activeResult]);
    }
  }
});

$("results").addEventListener("click", (event) => {
  const button = event.target.closest(".result");
  if (!button) return;
  const place = state.results[Number(button.dataset.index)];
  if (place) choosePlace(place, button);
});

/* settings */
document.addEventListener("click", (event) => {
  if (event.target.closest("[data-open-settings]")) openSettings();
});
$("settings-open").addEventListener("click", openSettings);
$("close-settings").addEventListener("click", closeSettings);
$("google-remove").addEventListener("click", () => {
  const who = cloud.diary ? " for everyone in the diary" : "";
  if (window.confirm("Disconnect Google Maps" + who + "? The diary goes back to free OpenStreetMap.")) {
    saveGoogleSettings(true);
  }
});
$("google-form").addEventListener("submit", (event) => {
  event.preventDefault();
  saveGoogleSettings(false);
});
$("install-btn").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  renderInstall();
});

/* sharing */
$("share-open").addEventListener("click", openShare);
$("close-share").addEventListener("click", closeShare);
$("share-body").addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.id === "share-start") {
    runShare("share", () => shareDiary({ googleKey: readSetting("google-key", ""), usage: deviceUsage() }),
      "Your diary is shared. Send the code to your friend.");
  } else if (button.id === "sync-now") {
    syncNow();
  } else if (button.id === "copy-code") {
    toast(await copyText(cloud.diary.invite_code) ? "Code copied." : "Couldn't copy — the code is on screen.");
  } else if (button.id === "send-invite") {
    sendInvite();
  } else if (button.id === "share-leave") {
    if (!leaveArmed) {
      leaveArmed = true;
      renderShare();
      setTimeout(() => {
        leaveArmed = false;
        if (!$("share-modal").hidden) renderShare();
      }, 4000);
      return;
    }
    leaveArmed = false;
    await leaveDiary();
    applyGoogleStatus();
    renderShare();
    toast("This device stopped sharing. Everything stays here as your own copy.");
  }
});
$("share-body").addEventListener("submit", (event) => {
  if (event.target.id !== "share-join") return;
  event.preventDefault();
  const code = $("join-code").value.trim();
  if (code.length < 4) {
    $("join-code").focus();
    return;
  }
  runShare("join", () => joinDiary(code, { googleKey: readSetting("google-key", "") }),
    "You're in. The shared diary is on this device now.");
});
$("share-body").addEventListener("input", (event) => {
  if (event.target.id === "join-code") {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  }
});

$("results-empty").addEventListener("click", (event) => {
  if (event.target.closest("#search-any")) {
    setSearchCountry("");
    $("place-search").focus();
    return;
  }
  if (!event.target.closest("#manual-add")) return;
  showConfirm({ manual: true, name: $("place-search").value.trim(), city: "" });
});

$("search-country").addEventListener("change", (event) => {
  setSearchCountry(event.target.value);
  $("place-search").focus();
});

document.querySelectorAll('input[name="status"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const visited = radio.value === "visited" && radio.checked;
    $("review-block").hidden = !visited;
    $("wish-block").hidden = visited;
  });
});

$("close-review").addEventListener("click", closeReview);
$("cancel-review").addEventListener("click", closeReview);
$("save-review").addEventListener("click", saveReview);

$("list").addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-act]");
  if (!trigger) return;
  const action = trigger.dataset.act;
  if (action === "add") openAdd();
  else if (action === "visit" || action === "edit") openReview(trigger.dataset.id);
  else if (action === "delete") removeItem(trigger.dataset.id);
  else if (action === "favorite") toggleFavorite(trigger.dataset.id);
  else if (action === "photo") openLightbox(trigger.dataset.id, Number(trigger.dataset.index));
  else if (action === "menu") openMenu(trigger.dataset.id);
});

/* photos in the add dialog wait in memory until the restaurant exists */
$("draft-photos-btn").addEventListener("click", () => $("draft-photos-input").click());
$("draft-photos-input").addEventListener("change", (event) => {
  Array.from(event.target.files || []).forEach((file) => {
    state.pendingPhotos.push({ file: file, url: URL.createObjectURL(file) });
  });
  event.target.value = "";
  renderDraftPhotos();
});
$("draft-photos").addEventListener("click", (event) => {
  const remove = event.target.closest(".photo-remove");
  if (!remove) return;
  const [photo] = state.pendingPhotos.splice(Number(remove.dataset.index), 1);
  if (photo) URL.revokeObjectURL(photo.url);
  renderDraftPhotos();
});

/* photos in the review dialog are kept straight away */
$("edit-photos-btn").addEventListener("click", () => $("edit-photos-input").click());
$("edit-photos-input").addEventListener("change", async (event) => {
  const files = Array.from(event.target.files || []);
  event.target.value = "";
  if (!files.length || !state.editingId) return;

  const button = $("edit-photos-btn");
  const original = button.innerHTML;
  button.disabled = true;
  const result = await addPhotos(state.editingId, files, (n, total) => {
    button.textContent = "Saving " + n + " of " + total + "…";
  });
  button.innerHTML = original;
  button.disabled = false;
  renderEditPhotos();
  render();
  reportUpload(result);
});
$("edit-photos").addEventListener("click", (event) => {
  const open = event.target.closest(".photo-open");
  if (open) {
    openLightbox(state.editingId, Number(open.dataset.index));
    return;
  }
  const remove = event.target.closest(".photo-remove");
  if (!remove || !state.editingId) return;
  if (!window.confirm("Remove this photo?")) return;
  removePhoto(state.editingId, remove.dataset.name);
  renderEditPhotos();
  render();
  toast("Photo removed.");
});

/* menu dialog */
$("close-menu").addEventListener("click", closeMenu);
$("menu-retry").addEventListener("click", () => {
  if (state.menuId) findMenu(state.menuId, "");
});
$("menu-paste").addEventListener("submit", (event) => {
  event.preventDefault();
  const url = $("menu-url").value.trim();
  if (!url) {
    $("menu-url").focus();
    return;
  }
  if (state.menuId) findMenu(state.menuId, url);
});
$("menu-clear").addEventListener("click", () => {
  const id = state.menuId;
  if (!id || !window.confirm("Remove the saved menu for this restaurant?")) return;
  const updated = updateItem(id, { menu: undefined });
  if (updated) renderMenu(updated);
  render();
});

/* photo viewer: buttons, arrow keys, and a swipe on touch screens */
$("lightbox-close").addEventListener("click", closeLightbox);
$("lightbox-prev").addEventListener("click", () => { viewer.index -= 1; showLightboxPhoto(); });
$("lightbox-next").addEventListener("click", () => { viewer.index += 1; showLightboxPhoto(); });
$("lightbox").addEventListener("click", (event) => {
  if (event.target === $("lightbox")) closeLightbox();
});
let swipeStart = null;
$("lightbox").addEventListener("pointerdown", (event) => {
  if (event.pointerType !== "mouse") swipeStart = { x: event.clientX, y: event.clientY };
});
$("lightbox").addEventListener("pointerup", (event) => {
  if (!swipeStart) return;
  const dx = event.clientX - swipeStart.x;
  const dy = event.clientY - swipeStart.y;
  swipeStart = null;
  if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
  viewer.index += dx < 0 ? 1 : -1;
  showLightboxPhoto();
});

document.querySelectorAll(".tab, .bottom-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const again = state.tab === tab.dataset.tab;
    state.tab = tab.dataset.tab;
    syncTabs();
    // Tapping the list you're already on goes back to the top, as apps do.
    if (again && tab.classList.contains("bottom-tab")) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    }
  });
});

$("filter").addEventListener("input", (event) => { state.filter = event.target.value; render(); });
$("sort").addEventListener("change", (event) => { state.sort = event.target.value; render(); });
$("cuisine-filter").addEventListener("change", (e) => { state.cuisine = e.target.value; render(); });
$("city-filter").addEventListener("change", (e) => { state.city = e.target.value; render(); });

document.querySelectorAll(".view-btn").forEach((button) => {
  button.addEventListener("click", () => {
    setView(button.dataset.view);
    render();
  });
  // Start fetching the map as soon as someone reaches for the button.
  if (button.dataset.view === "map") {
    const warm = () => mapView.preload(googleStatus().key);
    button.addEventListener("pointerenter", warm, { once: true });
    button.addEventListener("pointerdown", warm, { once: true });
    button.addEventListener("focus", warm, { once: true });
  }
});

$("radius").addEventListener("change", (event) => {
  state.radius = Number(event.target.value);
  render();
});

$("near-me").addEventListener("click", () => {
  if (state.origin) {
    setOrigin(null);
    render();
    toast("Showing every place again.");
    return;
  }
  if (!navigator.geolocation) {
    toast("This browser can't share your location.");
    return;
  }
  const button = $("near-me");
  button.disabled = true;
  toast("Finding your location…");

  navigator.geolocation.getCurrentPosition(
    (position) => {
      setOrigin({
        lat: position.coords.latitude,
        lon: position.coords.longitude,
      });
      button.disabled = false;
      render();
      toast(state.radius > 0
        ? "Showing places within " + state.radius + " km of you, closest first."
        : "Showing places by distance from you.");
    },
    (error) => {
      button.disabled = false;
      toast(error.code === error.PERMISSION_DENIED
        ? "Location permission denied — allow it to sort by distance."
        : "Could not get your location.");
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
  );
});

/* ---------- export & import ---------- */

$("export-btn").addEventListener("click", () => {
  const data = { app: "restaurant-diary", exported_at: nowIso(), restaurants: store.items };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "restaurant-diary-" + nowIso().slice(0, 10).replace(/-/g, "") + ".json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
});

$("import-btn").addEventListener("click", () => $("import-file").click());

$("import-file").addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";
  if (!file) return;

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (err) {
    toast("That file isn't valid JSON.");
    return;
  }

  const restaurants = Array.isArray(parsed) ? parsed : parsed && parsed.restaurants;
  if (!Array.isArray(restaurants)) {
    toast("That file doesn't look like a Restaurant Diary export.");
    return;
  }

  // Places already in the diary (same name and address) are skipped.
  const key = (r) => String(r.name || "").toLowerCase() + " " + String(r.address || "").toLowerCase();
  const existing = new Set(store.items.map(key));
  let added = 0;
  let skipped = 0;
  restaurants.forEach((entry) => {
    if (!entry || typeof entry !== "object" || !String(entry.name || "").trim()) return;
    if (existing.has(key(entry))) {
      skipped += 1;
      return;
    }
    // Photo files aren't in the export, so references to them would only be broken.
    const { photos, updated_at, ...rest } = entry;
    saveItem({ ...rest, id: newId(), name: String(entry.name).trim(), added_at: entry.added_at || nowIso() });
    existing.add(key(entry));
    added += 1;
  });
  render(true);
  toast("Added " + added + " — " + skipped + " already in your diary.");
});

document.addEventListener("keydown", (event) => {
  if (!$("lightbox").hidden) {
    if (event.key === "Escape") closeLightbox();
    else if (event.key === "ArrowLeft") { viewer.index -= 1; showLightboxPhoto(); }
    else if (event.key === "ArrowRight") { viewer.index += 1; showLightboxPhoto(); }
    return;
  }
  if (event.key !== "Escape") return;
  const top = layers[layers.length - 1];
  if (top) top.close();
});

// Clicking the backdrop used to close instantly, silently discarding an
// unsaved rating or review. Closing is always deliberate: Cancel, X, Esc or Back.

/* ---------- keeping in step ---------- */

store.subscribe((reason) => {
  if (reason === "remote") redrawForRemote();
  if (reason === "queue" && !$("share-modal").hidden) renderShare();
});

cloud.subscribe(() => {
  renderShareButton();
  applyGoogleStatus();
  if (!$("share-modal").hidden) renderShare();
});

/* ---------- the app on a phone's home screen ---------- */

// A new version is published: reload into it, but never in the middle of something.
if ("serviceWorker" in navigator && !IS_LOCAL) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    const reload = () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };
    if (!anyModalOpen() && document.visibilityState === "visible") reload();
    else document.addEventListener("visibilitychange", reload, { once: true });
  });
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

buildCountryOptions();
showSearchCountry();
applyGoogleStatus();
renderShareButton();
render(true);
startCloud().catch((err) => console.warn("Sharing unavailable:", err));

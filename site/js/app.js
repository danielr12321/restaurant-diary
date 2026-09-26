/* Restaurant Diary - the page */

import { SITE_URL, IS_LOCAL } from "./config.js";
import {
  store, saveItem, updateItem, deleteItem, newId, nowIso, readSetting, writeSetting,
  putPhoto, getPhoto, queuePhoto, forgetPhoto,
} from "./store.js";
import {
  cloud, startCloud, syncNow, shareDiary, joinDiary, leaveDiary, refreshUsage,
  photoPath, photoLinks, findMenuOnline, readSharedLink, createShareLink, shareLinkId, readShareLink,
} from "./cloud.js";
import {
  googleStatus, saveGoogleKey, deviceUsage, hasRoom, limitMessage, autocomplete, placeDetails,
  suggestPlaces, findBranchesOnline, LimitReached,
} from "./google.js";
import { searchFreePlaces, findBranches, chainKey, chainNameParts, geocode, reverseGeocode } from "./osm.js";
import { createMapView, loadLeaflet } from "./map.js";

const DAY_KEYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
// Where the diary lives, used when no country is chosen for a search.
const HOME_COUNTRY = "il";

// Cards to begin with, on any screen; the simple list is one tap away and each
// device keeps whichever it was last left in. The map is never where a visit starts.
function startingView() {
  const saved = readSetting("view", "");
  return saved === "rows" || saved === "cards" ? saved : "cards";
}

const state = {
  tab: "wishlist",
  view: startingView(),
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
  detailsPrice: 0,
  activeResult: -1,
  results: [],
  google: null,
  searchSession: "",
  choosing: false,
  sharedLink: "",
  suggested: null,
  // what "recommend me one" should look for: kind of place, and where. It
  // starts at "any type, anywhere"; only the last spot and distance are kept.
  suggest: {
    type: "", where: "country",
    radius: Number((readSetting("suggest-filters", null) || {}).radius) || 5,
    point: (readSetting("suggest-filters", null) || {}).point || null,
  },
  branches: [],
  detailsBranches: [],
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

// `brief`: just today's hours, where "open now" is already said above them.
function hoursMarkup(rawHours, quiet, brief) {
  if (!rawHours) {
    return quiet ? "" : '<div class="meta-row">' + icon("clock") +
      "<span>No opening hours listed</span></div>";
  }
  const now = new Date();
  const parsed = parseOpeningHours(rawHours);
  const open = openNow(parsed, now);
  const today = todayHours(parsed, now);

  if (open === null || today === null) {
    return '<div class="meta-row">' + icon("clock") + "<span>" + esc(rawHours) + "</span></div>";
  }
  if (brief) {
    return '<div class="meta-row">' + icon("clock") + "<span>" +
      (today === "Closed today" ? "Closed today" : "Today " + esc(today)) + "</span></div>";
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
  return openNow(parseOpeningHours(hoursOf(item)), new Date()) === true;
}

function hasReadableHours(item) {
  return openNow(parseOpeningHours(hoursOf(item)), new Date()) !== null;
}

/* ---------- metadata rows shared by cards and the preview ---------- */

function metaMarkup(item, withContact, quiet, brief) {
  let html = "";
  const address = item.address || "";
  const city = item.city || "";
  // format_address already ends with the locality for most OSM results.
  const includesCity = city && address.toLowerCase().includes(city.toLowerCase());
  const place = [address, includesCity ? "" : city].filter(Boolean).join(", ");
  if (place) html += '<div class="meta-row">' + icon("pin") + "<span>" + esc(place) + "</span></div>";
  html += hoursMarkup(item.opening_hours, quiet, brief);

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

/* ---------- chains ----------
   A chain is one entry with the addresses of its branches on it, so the diary
   holds "Landwer", not fourteen Landwers. Distance, opening hours and the map
   then work from whichever branch is nearest. */

function branchesOf(item) {
  return item.chain && Array.isArray(item.branches) ? item.branches.filter((b) => b && b.lat) : [];
}

function nearestBranch(item) {
  if (!state.origin) return null;
  let best = null;
  branchesOf(item).forEach((branch) => {
    const lat = parseFloat(branch.lat);
    const lon = parseFloat(branch.lon);
    if (!isFinite(lat) || !isFinite(lon)) return;
    const km = haversineKm(state.origin, { lat: lat, lon: lon });
    if (!best || km < best.km) best = { branch, km };
  });
  return best;
}

/** The hours to judge "open now" by: the nearest branch's, or any branch's. */
function hoursOf(item) {
  if (item.opening_hours) return item.opening_hours;
  const near = nearestBranch(item);
  if (near && near.branch.opening_hours) return near.branch.opening_hours;
  const any = branchesOf(item).find((branch) => branch.opening_hours);
  return any ? any.opening_hours : "";
}

/** A chain shown as the branch that matters right now. */
function asShown(item) {
  const branches = branchesOf(item);
  if (!branches.length) return item;
  const near = nearestBranch(item);
  const branch = near ? near.branch : branches[0];
  return {
    ...item,
    address: branch.address || item.address,
    city: branch.city || item.city,
    phone: branch.phone || item.phone,
    opening_hours: hoursOf(item),
  };
}

function distanceKm(item) {
  if (!state.origin) return null;
  const near = nearestBranch(item);
  if (near) return near.km;
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
    return ""; // adding one by hand is in the card's "more" menu
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

function branchesMarkup(item) {
  const branches = branchesOf(item);
  if (!branches.length) return "";
  const near = nearestBranch(item);
  const where = item.country ? " in " + esc(item.country) : "";
  return '<div class="meta-row">' + icon("pin") + "<span>" + branches.length + " branch" +
    (branches.length === 1 ? "" : "es") + where +
    (near ? " · nearest: " + esc(near.branch.address || near.branch.city || formatDistance(near.km)) : "") +
    " · " +
    '<button type="button" class="link-btn branch-more" data-act="branches" data-id="' + esc(item.id) +
    '">see them all</button></span></div>';
}

// The address, hours, menu and distance, shared by both layouts. A card's
// status line already says how far and whether it's open, and its chain hint
// sits above, so there they're left out.
function detailsMarkup(item, inCard) {
  const km = inCard ? null : distanceKm(item);
  const branches = branchesOf(item);
  let html = '<div class="card-meta">';
  html += branches.length ? branchesMarkup(item) + hoursMarkup(hoursOf(item), true, inCard)
    : metaMarkup(item, true, true, inCard);
  if (branches.length) {
    // A chain's phone and website belong to the chain, not to one branch.
    const shown = asShown(item);
    if (shown.phone) html += '<div class="meta-row">' + icon("phone") + "<span>" + esc(shown.phone) + "</span></div>";
    const site = safeUrl(item.website);
    if (site) {
      html += '<div class="meta-row">' + icon("globe") +
        '<span><a href="' + esc(site) + '" target="_blank" rel="noopener noreferrer">' +
        esc(site.replace(/^https?:\/\//, "").replace(/\/$/, "")) + "</a></span></div>";
    }
  }
  if (km !== null) {
    html += '<div class="meta-row">' + icon("crosshair") +
      "<span>" + esc(formatDistance(km)) + "</span></div>";
  }
  if (!inCard) html += chainHintMarkup(item);
  html += menuRowMarkup(item);
  const source = safeUrl(item.source_url);
  if (source) {
    html += '<div class="meta-row">' + icon("share") +
      '<span><a href="' + esc(source) + '" target="_blank" rel="noopener noreferrer">' +
      esc(sourceLabel(source)) + "</a></span></div>";
  }
  return html + "</div>";
}

// Where a place was saved from, for the line on the card.
function sourceLabel(url) {
  const host = hostOf(url);
  if (host.endsWith("instagram.com")) return "Seen on Instagram";
  if (host.endsWith("tiktok.com")) return "Seen on TikTok";
  if (host.endsWith("facebook.com")) return "Seen on Facebook";
  if (host.endsWith("youtube.com") || host === "youtu.be") return "Seen on YouTube";
  return "Seen on " + host;
}

function notesMarkup(item) {
  const dishes = Array.isArray(item.dishes) ? item.dishes.filter(Boolean) : [];
  if (item.status !== "visited") {
    return item.wish_note ? '<div class="card-review"><p class="review-text">' +
      esc(item.wish_note) + "</p></div>" : "";
  }
  if (!item.rating && !item.review && !dishes.length) return "";
  let html = '<div class="card-review">';
  if (item.rating) html += starsStatic(item.rating);
  if (item.review) html += '<p class="review-text">' + esc(item.review) + "</p>";
  if (dishes.length) {
    html += '<div class="dishes">' +
      dishes.map((d) => '<span class="dish-chip">' + esc(d) + "</span>").join("") + "</div>";
  }
  return html + "</div>";
}

function mapsLink(item) {
  if (item.google_place_id) {
    return {
      where: "Google Maps",
      url: safeUrl(item.google_maps_uri) ||
        "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(item.name) +
        "&query_place_id=" + encodeURIComponent(item.google_place_id),
    };
  }
  if (item.lat && item.lon) {
    return {
      where: "the map",
      url: "https://www.openstreetmap.org/?mlat=" + encodeURIComponent(item.lat) +
        "&mlon=" + encodeURIComponent(item.lon) + "#map=18/" + encodeURIComponent(item.lat) +
        "/" + encodeURIComponent(item.lon),
    };
  }
  return null;
}

// The one thing a card is for, and a "more" menu for everything else: a row of
// bare icons left people guessing which was which.
function actionsMarkup(item) {
  const visited = item.status === "visited";
  let html = '<div class="card-actions">';
  if (visited) {
    html += '<button type="button" class="btn btn-ghost btn-sm" data-act="edit" data-id="' + esc(item.id) + '">' +
      icon("star") + "Rating & notes</button>";
  } else {
    html += '<button type="button" class="btn btn-primary btn-sm" data-act="visit" data-id="' + esc(item.id) + '">' +
      icon("check") + "I've been here</button>";
  }
  html += '<span class="spacer"></span>';
  html += '<button type="button" class="btn-icon more-btn" data-act="actions" data-id="' + esc(item.id) +
    '" aria-haspopup="menu" aria-expanded="false" title="More" aria-label="More for ' + esc(item.name) + '">' +
    icon("more") + "</button>";
  return html + "</div>";
}

function cardMarkup(item) {
  const initial = (item.name || "?").trim().charAt(0).toUpperCase();
  const cuisine = prettyCuisine(item.cuisine);

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

  html += statusMarkup(item);
  const hint = chainHintMarkup(item);
  if (hint) html += '<div class="card-meta card-hint">' + hint + "</div>";
  if (openCards.has(item.id)) html += moreMarkup(item);
  html += cardPhotosMarkup(item);
  html += notesMarkup(item);
  html += actionsMarkup(item);
  return html + "</article>";
}

/* A card says the few things that decide an evening — open or not, how far,
   where — on one line. The address, hours, phone and website wait behind it,
   one tap away, so a phone screen shows several places instead of one. */

const openCards = new Set();

function statusMarkup(item) {
  const bits = [];
  const now = new Date();
  const parsed = parseOpeningHours(hoursOf(item));
  const open = openNow(parsed, now);
  if (open !== null) {
    bits.push('<span class="status-' + (open ? "open" : "shut") + '"><span class="badge-dot"></span>' +
      (open ? "Open" : "Closed") + "</span>");
    const change = nextChange(parsed, now);
    if (change) bits.push(esc(change.charAt(0).toLowerCase() + change.slice(1)));
  }
  const km = distanceKm(item);
  if (km !== null) bits.push(esc(formatDistance(km).replace(/ away$/, "")));
  const branches = branchesOf(item);
  if (branches.length) bits.push(branches.length + " branches");
  else if (item.city) bits.push(esc(item.city));
  else if (item.address) bits.push(esc(item.address));
  const expanded = openCards.has(item.id);
  return '<button type="button" class="card-status" data-act="more" data-id="' + esc(item.id) +
    '" aria-expanded="' + (expanded ? "true" : "false") + '">' +
    '<span class="card-status-text">' +
    (bits.length ? bits.join('<span class="status-sep" aria-hidden="true"></span>') : "Address, hours and contact") +
    "</span>" + '<span class="card-status-more">' + (expanded ? "Less" : "More") + icon("chevron-down") +
    "</span></button>";
}

function moreMarkup(item) {
  const details = detailsMarkup(item, true);
  const empty = details === '<div class="card-meta"></div>';
  return '<div class="card-more">' + (empty
    ? '<div class="card-meta"><p class="card-more-empty">No address, hours or contact yet. ' +
      '<button type="button" class="link-btn" data-act="details" data-id="' + esc(item.id) +
      '">Add them</button></p></div>'
    : details) + "</div>";
}

function toggleCard(id) {
  if (openCards.has(id)) openCards.delete(id);
  else openCards.add(id);
  const item = store.get(id);
  const card = $("list").querySelector('.card[data-card-id="' + CSS.escape(id) + '"]');
  if (!item || !card) {
    render();
    return;
  }
  card.insertAdjacentHTML("afterend", cardMarkup(item));
  const next = card.nextElementSibling;
  next.classList.add("no-enter");
  card.remove();
  hydratePhotos(next);
  next.querySelector(".card-status").focus({ preventScroll: true });
}

/* ---------- the simple list ----------
   One line each, so a long diary can be read at a glance. Tapping a line opens
   the same details the card shows. Which lines are open is remembered while the
   page is open, so a redraw doesn't fold them back up. */

const openRows = new Set();

function rowMarkup(item) {
  const open = openRows.has(item.id);
  const cuisine = prettyCuisine(item.cuisine);
  const nowOpen = openNow(parseOpeningHours(hoursOf(item)), new Date());
  const km = distanceKm(item);

  const branches = branchesOf(item);
  const bits = [];
  if (item.rating) bits.push('<span class="row-rating">' + icon("star", "on") + item.rating + "</span>");
  if (branches.length) bits.push(branches.length + " branches");
  if (cuisine) bits.push('<span class="row-cuisine">' + esc(cuisine) + "</span>");
  if (item.price) bits.push(priceStatic(item.price));
  if (item.city) bits.push(esc(item.city));
  if (km !== null) bits.push(esc(formatDistance(km)));

  let html = '<li class="row' + (item.favorite ? " is-favorite" : "") + (open ? " is-open" : "") +
    '" data-card-id="' + esc(item.id) + '">';
  html += '<div class="row-line">';
  html += '<button type="button" class="row-main" data-act="expand" data-id="' + esc(item.id) +
    '" aria-expanded="' + (open ? "true" : "false") + '">';
  html += '<span class="row-dot' + (nowOpen === true ? " is-open-now" : nowOpen === false ? " is-shut" : "") +
    '" aria-hidden="true"></span>';
  html += '<span class="row-body"><span class="row-name">' + esc(item.name) +
    (item.local_name ? '<span class="row-local"> · ' + esc(item.local_name) + "</span>" : "") + "</span>";
  if (bits.length) html += '<span class="row-meta">' + bits.join('<span class="row-sep"></span>') + "</span>";
  html += "</span>";
  html += '<svg class="icon row-chevron" aria-hidden="true"><use href="#i-chevron-down"/></svg>';
  html += "</button>";
  html += favoriteButtonMarkup(item);
  html += "</div>";
  if (open) {
    html += '<div class="row-details">' + detailsMarkup(item) + cardPhotosMarkup(item) +
      notesMarkup(item) + actionsMarkup(item) + "</div>";
  }
  return html + "</li>";
}

function toggleRow(id) {
  if (openRows.has(id)) openRows.delete(id);
  else openRows.add(id);
  const item = store.get(id);
  const row = $("list").querySelector('[data-card-id="' + CSS.escape(id) + '"]');
  if (!item || !row) {
    render();
    return;
  }
  row.insertAdjacentHTML("afterend", rowMarkup(item));
  const next = row.nextElementSibling;
  row.remove();
  hydratePhotos(next);
  next.querySelector(".row-main").focus({ preventScroll: true });
}

// A browser that has never joined starts empty; the diary may well be waiting
// on another device, so the first thing offered is its code.
function welcomeMarkup() {
  return '<div class="empty welcome">' +
    '<div class="empty-mark">' + icon("users") + "</div>" +
    "<h3>Is your diary on another device?</h3>" +
    "<p>Type its code to bring it here. Your restaurants, notes and photos then stay in step on every " +
    "device. You'll find the code under Invite on a device that already has the diary.</p>" +
    '<form class="share-join welcome-join" id="welcome-join">' +
    '<label class="sr-only" for="welcome-code">Diary code</label>' +
    '<input id="welcome-code" class="code-input" autocomplete="off" autocapitalize="characters" ' +
    'spellcheck="false" maxlength="12" placeholder="ABCD1234" enterkeyhint="go">' +
    '<button type="submit" class="btn btn-primary">Join</button></form>' +
    '<p class="menu-error welcome-error" id="welcome-error" role="alert" hidden></p>' +
    '<p class="welcome-or">Starting a new diary? <button type="button" class="link-btn" data-act="add">' +
    "Add your first restaurant</button></p></div>";
}

function emptyMarkup() {
  if (!state.items.length && !cloud.diary) return welcomeMarkup();
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
    items = items.filter((item) => typesOf(item).includes(state.cuisine));
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

// Google's words for a place that say nothing about what it serves.
const PLAIN_TYPES = new Set(["restaurant", "food", "point of interest", "establishment",
  "meal takeaway", "meal delivery", "store"]);

/** "italian_restaurant" -> "Italian", "coffee_shop" -> "Coffee shop", "restaurant" -> "". */
function typeName(raw) {
  const words = String(raw || "").replace(/_/g, " ").replace(/\s+restaurant$/i, "")
    .replace(/\s+/g, " ").trim().toLowerCase();
  if (!words || PLAIN_TYPES.has(words)) return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// What a place is: every cuisine it lists ("Japanese", "Sushi"), otherwise what
// kind of place it is ("Cafe", "Bakery"). Both lists filter on it.
function typesOf(item) {
  const found = String(item.cuisine || "").split(/[;,]/).map(typeName).filter(Boolean);
  if (!found.length) {
    const kind = typeName(item.place_type);
    if (kind) found.push(kind);
  }
  return [...new Set(found)];
}

function refreshFilterOptions() {
  const cuisines = new Set();
  const cities = new Set();
  state.items.forEach((item) => {
    typesOf(item).forEach((type) => cuisines.add(type));
    if (item.city) cities.add(item.city);
  });
  // A choice whose last place was just deleted or edited away stops filtering.
  if (state.cuisine && !cuisines.has(state.cuisine)) state.cuisine = "";
  if (state.city && !cities.has(state.city)) state.city = "";

  const fill = (id, values, allLabel, selected) => {
    const select = $(id);
    const sorted = Array.from(values).sort((a, b) => a.localeCompare(b));
    select.innerHTML = '<option value="">' + allLabel + "</option>" +
      sorted.map((v) => '<option value="' + esc(v) + '"' +
        (v === selected ? " selected" : "") + ">" + esc(v) + "</option>").join("");
    if (selected && !sorted.includes(selected)) select.value = "";
  };

  fill("cuisine-filter", cuisines, "All types", state.cuisine);
  fill("city-filter", cities, "All cities", state.city);
}

/* ---------- map ---------- */

function popupMarkup(item, branch) {
  const bits = ['<strong>' + (item.favorite ? "★ " : "") + esc(item.name) + "</strong>"];
  const cuisine = prettyCuisine(item.cuisine);
  if (cuisine) bits.push(esc(cuisine));
  const parsed = parseOpeningHours((branch && branch.opening_hours) || hoursOf(item));
  const open = openNow(parsed, new Date());
  if (open !== null) {
    const change = nextChange(parsed, new Date());
    bits.push((open ? "Open now" : "Closed now") + (change ? " · " + esc(change) : ""));
  }
  if (item.rating) bits.push("★".repeat(item.rating));
  if (item.price) bits.push("₪".repeat(item.price));
  const where = branch ? branch.address || branch.city : item.address;
  if (where) bits.push(esc(where));
  if (branch) bits.push("One of " + branchesOf(item).length + " branches");
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
  $("share-label").textContent = sharing ? "Shared diary" : "Invite a friend";
  $("share-label-short").textContent = sharing ? "Shared" : "Invite";
  $("share-open").classList.toggle("is-sharing", sharing);
  $("sync-dot").hidden = !sharing;
  $("sync-dot").dataset.status = cloud.status;
  $("share-open").setAttribute("aria-label", sharing
    ? "Shared diary: " + (SYNC_LABELS[cloud.status] || "") : "Invite a friend");
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
      sendCopyCard() +
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
    "too. On that device, open the diary, tap <strong>Invite</strong>, choose <strong>Join with a code</strong> " +
    "and type it.</p>" +
    '<button type="button" class="btn btn-primary share-invite" id="send-invite">' + icon("share") +
    (touch ? "Send an invite" : "Copy an invite message") + "</button>" +
    sendCopyCard() +
    '<button type="button" class="link-btn share-leave' + (leaveArmed ? " is-armed" : "") + '" id="share-leave">' +
    icon("logout") + (leaveArmed ? "Tap again to stop — you can rejoin with the code"
      : "Stop sharing on this device") + "</button>";
}

// Sharing a diary means using one together; a copy is for a friend who keeps their own.
function sendCopyCard() {
  if (!state.items.length) return "";
  return '<div class="share-card share-copy"><h3>' + icon("send") + "Send a copy instead</h3>" +
    "<p>For a friend with a diary of their own: they get a link, pick the places they like and add " +
    "them to their list. Nothing is shared after that, and your photos stay with you.</p>" +
    '<button type="button" class="btn btn-ghost" id="send-copy-open">' + icon("send") +
    "Send a copy of your list</button></div>";
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
  const text = "Join my restaurant diary!\n1. Open " + SITE_URL + "\n2. Tap “Invite” → “Join with a code”\n" +
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

/* ---------- sending a copy ----------
   A restaurant, or a whole list, goes out as a link. Whoever opens it picks
   what to add to their own diary. Unlike sharing the diary, nothing stays in
   step afterwards, and photos never leave. */

// What of a restaurant travels: where it is and what it is.
const COPY_FIELDS = ["name", "local_name", "address", "city", "country", "lat", "lon", "cuisine",
  "place_type", "opening_hours", "phone", "website", "google_place_id", "google_rating",
  "google_rating_count", "google_maps_uri", "osm_id", "osm_type", "price"];

function copyOf(item, withTake) {
  const place = {};
  COPY_FIELDS.forEach((key) => {
    if (item[key]) place[key] = item[key];
  });
  if (item.chain && Array.isArray(item.branches) && item.branches.length) {
    place.chain = true;
    place.branches = item.branches.slice(0, 300);
  }
  const menu = item.menu && safeUrl(item.menu.url);
  if (menu) place.menu_url = menu;
  if (withTake) {
    // What the sender makes of it: shown to the friend, and kept as their note.
    place.take = {
      visited: item.status === "visited",
      rating: item.status === "visited" ? item.rating || 0 : 0,
      review: item.status === "visited" ? item.review || "" : "",
      dishes: item.status === "visited" && Array.isArray(item.dishes) ? item.dishes : [],
      note: item.status === "visited" ? "" : item.wish_note || "",
    };
  }
  return place;
}

const sending = { ids: null, choice: "", busy: false, link: "", error: "", title: "" };

function sendChoices() {
  const inTab = state.items.filter((item) => item.status === state.tab);
  const showing = visibleItems();
  const choices = [
    { value: "wishlist", label: "Want to go", items: state.items.filter((i) => i.status === "wishlist") },
    { value: "visited", label: "Been there", items: state.items.filter((i) => i.status === "visited") },
    { value: "all", label: "Everything", items: state.items },
  ];
  // Filtered down to, say, the sushi places: those can go on their own.
  if (showing.length && showing.length < inTab.length) {
    choices.unshift({ value: "showing", label: "Just what's showing now", items: showing });
  }
  return choices.filter((choice) => choice.items.length);
}

function openSend(ids) {
  sending.ids = ids;
  sending.link = "";
  sending.error = "";
  sending.busy = false;
  const choices = sendChoices();
  sending.choice = ids ? "" : (choices.find((c) => c.value === state.tab) || choices[0] || {}).value || "";
  renderSend();
  openLayer("send-modal", closeSend);
}

function closeSend() {
  closeLayer("send-modal");
}

function sendingItems() {
  if (sending.ids) return sending.ids.map((id) => store.get(id)).filter(Boolean);
  const choice = sendChoices().find((c) => c.value === sending.choice);
  return choice ? choice.items : [];
}

function renderSend() {
  const body = $("send-body");
  const touch = window.matchMedia("(pointer: coarse)").matches && navigator.share;
  if (sending.link) {
    body.innerHTML = '<div class="send-ready">' + icon("check") + "<div><strong>The link is ready</strong>" +
      "<p>Anyone who opens it can add " + esc(sending.title) + " to their own diary.</p></div></div>" +
      '<div class="send-link-row"><input class="send-link" id="send-link" readonly value="' +
      esc(sending.link) + '" aria-label="The link">' +
      '<button type="button" class="btn btn-ghost btn-sm" id="send-copy">' + icon("copy") + "Copy</button></div>" +
      (touch ? '<button type="button" class="btn btn-primary send-go" id="send-share">' + icon("send") +
        "Send it</button>" : "");
    return;
  }
  const items = sendingItems();
  let html = "";
  if (sending.ids) {
    const item = items[0];
    if (!item) {
      body.innerHTML = '<p class="menu-error">That restaurant is gone from the diary.</p>';
      return;
    }
    html += '<div class="send-place">' + '<div class="card-mark" aria-hidden="true">' +
      esc((item.name || "?").trim().charAt(0).toUpperCase()) + "</div><div><strong>" + esc(item.name) +
      "</strong><span>" + esc([typesOf(item)[0], item.city].filter(Boolean).join(" · ")) +
      "</span></div></div>";
  } else {
    html += '<fieldset class="send-options"><legend class="rec-label">What to send</legend>' +
      sendChoices().map((choice) => '<label class="send-option">' +
        '<input type="radio" name="send-choice" value="' + esc(choice.value) + '"' +
        (choice.value === sending.choice ? " checked" : "") + ">" +
        "<span>" + esc(choice.label) + "</span>" +
        '<span class="send-count">' + choice.items.length + "</span></label>").join("") + "</fieldset>";
  }
  const anyVisited = items.some((item) => item.status === "visited");
  html += '<label class="chain-option send-take"><input type="checkbox" id="send-take" checked>' +
    '<span class="chain-text"><strong>Include my ' + (anyVisited ? "ratings and notes" : "notes") + "</strong>" +
    '<span class="field-help">So they know why it’s worth going.</span></span></label>' +
    '<div class="field"><label class="field-label" for="send-from">Your name ' +
    '<span class="optional">(so they know who it’s from)</span></label>' +
    '<input type="text" id="send-from" maxlength="60" autocomplete="off" value="' +
    esc(readSetting("my-name", "")) + '"></div>' +
    (sending.error ? '<p class="menu-error" role="alert">' + esc(sending.error) + "</p>" : "") +
    '<button type="submit" class="btn btn-primary send-go" id="send-make"' + (sending.busy ? " disabled" : "") + ">" +
    (sending.busy ? spinnerMarkup() + "Making the link…" : icon("send") + (touch ? "Send the link" : "Copy the link")) +
    "</button>" +
    '<p class="hint send-note">Photos don’t go with it, and nothing stays linked to your diary.</p>';
  body.innerHTML = html;
}

async function makeSendLink() {
  const items = sendingItems();
  if (!items.length || sending.busy) return;
  const withTake = $("send-take").checked;
  const sender = $("send-from").value.trim();
  writeSetting("my-name", sender || null);
  sending.title = items.length === 1 ? items[0].name : items.length + " restaurants";
  sending.busy = true;
  sending.error = "";
  renderSend();
  try {
    sending.link = await createShareLink({
      kind: sending.ids ? "place" : "list",
      title: sending.title,
      sender,
      places: items.map((item) => copyOf(item, withTake)),
    });
  } catch (err) {
    sending.error = err.message;
  }
  sending.busy = false;
  renderSend();
  if (sending.link) await deliverLink();
}

function sendMessage() {
  return (sending.ids ? sending.title + " — worth a try! Add it to your restaurant diary:"
    : sending.title + " from my restaurant diary — pick the ones you like:") + "\n" + sending.link;
}

// The phone's own share sheet where there is one; otherwise, the clipboard.
async function deliverLink() {
  const touch = window.matchMedia("(pointer: coarse)").matches && navigator.share;
  if (touch) {
    try {
      await navigator.share({ title: sending.title, text: sendMessage() });
      return;
    } catch (err) {
      // Cancelled, or the phone wants a fresh tap: the "Send it" button is right there.
      return;
    }
  }
  toast(await copyText(sendMessage()) ? "Link copied — paste it in a message."
    : "Couldn't copy it on its own — use the Copy button.");
}

$("send-body").addEventListener("submit", (event) => {
  event.preventDefault();
  makeSendLink();
});
$("send-body").addEventListener("change", (event) => {
  if (event.target.name !== "send-choice") return;
  sending.choice = event.target.value;
  const take = $("send-take").checked;
  const from = $("send-from").value;
  renderSend();
  $("send-take").checked = take;
  $("send-from").value = from;
});
$("send-body").addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.id === "send-copy") {
    toast(await copyText(sending.link) ? "Link copied." : "Select the link and copy it.");
    if ($("send-link")) $("send-link").select();
  } else if (button.id === "send-share") {
    deliverLink();
  }
});
$("close-send").addEventListener("click", closeSend);

/* ---------- a copy someone sent ---------- */

const incoming = { id: "", loading: false, error: "", sender: "", places: [], picked: new Set() };

// A link can hold anything, so only what a restaurant is made of is kept, in the shapes the diary uses.
function cleanCopy(raw) {
  if (!raw || typeof raw !== "object") return null;
  const text = (value, max) => (typeof value === "string" ? value
    : typeof value === "number" && isFinite(value) ? String(value) : "").slice(0, max || 300);
  const number = (value) => (isFinite(Number(value)) ? Number(value) : 0);
  const coordinate = (value) => (isFinite(parseFloat(value)) ? String(parseFloat(value)) : "");
  const place = {
    name: text(raw.name, 200).trim(),
    local_name: text(raw.local_name, 200),
    address: text(raw.address),
    city: text(raw.city, 120),
    country: text(raw.country, 80),
    lat: coordinate(raw.lat),
    lon: coordinate(raw.lon),
    cuisine: text(raw.cuisine, 120),
    place_type: text(raw.place_type, 80),
    opening_hours: text(raw.opening_hours, 600),
    phone: text(raw.phone, 40),
    website: safeUrl(raw.website) || "",
    google_place_id: text(raw.google_place_id, 200),
    google_rating: Math.min(5, Math.max(0, number(raw.google_rating))),
    google_rating_count: Math.max(0, Math.round(number(raw.google_rating_count))),
    google_maps_uri: safeUrl(raw.google_maps_uri) || "",
    osm_id: raw.osm_id ? text(raw.osm_id, 30) : null,
    osm_type: raw.osm_type ? text(raw.osm_type, 10) : null,
    price: Math.min(5, Math.max(0, Math.round(number(raw.price)))),
  };
  if (!place.name) return null;
  if (raw.chain && Array.isArray(raw.branches)) {
    const branches = raw.branches.slice(0, 300).filter((b) => b && typeof b === "object").map((b) => ({
      name: text(b.name, 200), address: text(b.address), city: text(b.city, 120),
      lat: coordinate(b.lat), lon: coordinate(b.lon), opening_hours: text(b.opening_hours, 600),
      phone: text(b.phone, 40), osm_id: b.osm_id ? text(b.osm_id, 30) : null,
      osm_type: b.osm_type ? text(b.osm_type, 10) : null, google_place_id: text(b.google_place_id, 200),
    }));
    if (branches.length) {
      place.chain = true;
      place.branches = branches;
    }
  }
  const menu = safeUrl(raw.menu_url);
  if (menu) place.menu = { url: menu };
  const take = raw.take && typeof raw.take === "object" ? raw.take : null;
  if (take) {
    place.take = {
      visited: !!take.visited,
      rating: Math.min(5, Math.max(0, Math.round(number(take.rating)))),
      review: text(take.review, 2000).trim(),
      dishes: (Array.isArray(take.dishes) ? take.dishes : []).slice(0, 30).map((d) => text(d, 80).trim())
        .filter(Boolean),
      note: text(take.note, 1000).trim(),
    };
  }
  return place;
}

/** The sender's view of a place, as one line for the friend's note. */
function takeNote(take, sender) {
  if (!take) return "";
  const parts = [];
  if (take.rating) parts.push("★" + take.rating + "/5");
  if (take.review) parts.push("“" + take.review + "”");
  if (take.dishes.length) parts.push("Try: " + take.dishes.join(", "));
  if (take.note) parts.push(take.note);
  if (!parts.length) return take.visited ? "Recommended by " + (sender || "a friend") + "." : "";
  return "From " + (sender || "a friend") + ": " + parts.join(" · ");
}

async function openImport(id) {
  Object.assign(incoming, { id, loading: true, error: "", sender: "", places: [], picked: new Set() });
  renderImport();
  openLayer("import-modal", closeImport);
  try {
    const data = await readShareLink(id);
    incoming.sender = String(data.sender || "").slice(0, 60);
    incoming.places = data.places.map(cleanCopy).filter(Boolean);
    if (!incoming.places.length) throw new Error("This link holds no restaurants.");
    // Everything is ticked, except what's in this diary already.
    incoming.places.forEach((place, index) => {
      if (!findDuplicates(place).length) incoming.picked.add(index);
    });
  } catch (err) {
    incoming.error = err.message;
  }
  incoming.loading = false;
  renderImport();
}

function closeImport() {
  closeLayer("import-modal");
}

function takeMarkup(take) {
  if (!take) return "";
  const bits = [];
  if (take.visited) bits.push(take.rating ? starsStatic(take.rating) : "Has been");
  if (take.review) bits.push("<q>" + esc(take.review.length > 140 ? take.review.slice(0, 140) + "…" : take.review) + "</q>");
  if (take.dishes.length) bits.push("Try: " + esc(take.dishes.slice(0, 4).join(", ")));
  if (take.note) bits.push(esc(take.note.length > 140 ? take.note.slice(0, 140) + "…" : take.note));
  return bits.length ? '<span class="import-take">' + bits.join(" ") + "</span>" : "";
}

function renderImport() {
  const body = $("import-body");
  const foot = $("import-foot");
  foot.hidden = true;
  if (incoming.loading) {
    $("import-title").textContent = "Shared with you";
    body.innerHTML = '<p class="menu-status">' + spinnerMarkup() + "Opening what was sent…</p>";
    return;
  }
  if (incoming.error) {
    body.innerHTML = '<p class="menu-error" role="alert">' + esc(incoming.error) + "</p>";
    return;
  }
  const places = incoming.places;
  const single = places.length === 1;
  const who = incoming.sender ? esc(incoming.sender) : "A friend";
  $("import-title").textContent = single ? "A restaurant for you" : places.length + " restaurants for you";
  const addable = places.filter((place) => !findDuplicates(place).length).length;
  let html = '<p class="hint">' + who + " sent " + (single ? "this" : "these") + " from their restaurant diary. " +
    (!addable ? (single ? "It's in your diary already." : "They're all in your diary already.")
      : single ? "Add it to your wishlist?" : "Tick the ones to add to your wishlist.") + "</p>";
  // On an iPhone, the home-screen app keeps its own diary, apart from Safari's.
  if (!state.items.length && !cloud.diary) {
    html += '<p class="field-help import-elsewhere">Keep your diary in the app on your home screen? ' +
      'Copy this link and paste it into the app’s <strong>Add</strong> search instead. ' +
      '<button type="button" class="link-btn" id="import-copy-link">Copy the link</button></p>';
  }
  html += '<ul class="import-list">' + places.map((place, index) => {
    const saved = findDuplicates(place)[0];
    const meta = [typesOf(place)[0], place.city,
      place.chain && place.branches ? place.branches.length + " branches" : ""].filter(Boolean).join(" · ");
    return '<li><label class="import-row' + (saved ? " is-saved" : "") + '">' +
      '<input type="checkbox" data-index="' + index + '"' + (incoming.picked.has(index) ? " checked" : "") +
      (saved ? " disabled" : "") + ">" +
      '<span class="import-text"><strong>' + esc(place.name) + "</strong>" +
      (meta ? '<span class="import-meta">' + esc(meta) + "</span>" : "") +
      takeMarkup(place.take) +
      (saved ? '<span class="import-saved">' + icon("check") + "Already in " + esc(listName(saved)) + "</span>" : "") +
      "</span></label>" +
      (single && !saved ? '<div class="card-meta import-details">' + metaMarkup(place, true) + "</div>" : "") +
      "</li>";
  }).join("") + "</ul>";
  body.innerHTML = html;
  showImportFoot();
}

function showImportFoot() {
  const addable = incoming.places.filter((place) => !findDuplicates(place).length).length;
  const count = incoming.picked.size;
  $("import-foot").hidden = !addable;
  $("import-toggle").hidden = addable < 2;
  $("import-toggle").textContent = count === addable ? "Select none" : "Select all";
  $("import-go").disabled = !count;
  $("import-go").textContent = count <= 1 && incoming.places.length === 1 ? "Add to my wishlist"
    : "Add " + count + " to my wishlist";
}

function importPicked() {
  const picked = [...incoming.picked].sort((a, b) => a - b).map((i) => incoming.places[i]);
  if (!picked.length) return;
  picked.forEach((place) => {
    const { take, ...facts } = place;
    const item = {
      ...facts,
      id: newId(),
      status: "wishlist",
      source: place.google_place_id ? "google" : place.osm_id ? "osm" : "manual",
      added_at: nowIso(),
      wish_note: takeNote(take, incoming.sender),
      dishes: [],
      photos: [],
    };
    if (item.chain) item.branches_at = nowIso();
    saveItem(item);
  });
  closeImport();
  state.tab = "wishlist";
  syncTabs();
  render(true);
  toast(picked.length === 1 ? picked[0].name + " is on your wishlist."
    : picked.length + " restaurants added to your wishlist.");
}

$("import-body").addEventListener("change", (event) => {
  const box = event.target.closest("input[data-index]");
  if (!box) return;
  const index = Number(box.dataset.index);
  if (box.checked) incoming.picked.add(index);
  else incoming.picked.delete(index);
  showImportFoot();
});
$("import-body").addEventListener("click", async (event) => {
  if (!event.target.closest("#import-copy-link")) return;
  toast(await copyText(SITE_URL + "?list=" + incoming.id) ? "Link copied." : "Couldn't copy the link.");
});
$("import-toggle").addEventListener("click", () => {
  const addable = incoming.places.map((place, i) => (findDuplicates(place).length ? -1 : i)).filter((i) => i >= 0);
  const all = incoming.picked.size === addable.length;
  incoming.picked = new Set(all ? [] : addable);
  $("import-body").querySelectorAll("input[data-index]").forEach((box) => {
    box.checked = incoming.picked.has(Number(box.dataset.index));
  });
  showImportFoot();
});
$("import-go").addEventListener("click", importPicked);
$("close-import").addEventListener("click", closeImport);

/* ---------- dialogs and the Back button ----------
   Every open dialog takes a step in the browser history, so the phone's Back
   button or swipe closes the dialog instead of leaving the diary. */

const layers = [];
let ignorePops = 0;
let closingFromBack = false;

const closingLayers = new Map();

function openLayer(id, close, guard) {
  clearTimeout(closingLayers.get(id));
  closingLayers.delete(id);
  $(id).classList.remove("is-closing");
  $(id).hidden = false;
  document.body.classList.add("has-sheet");
  layers.push({ id, close, guard });
  try {
    history.pushState({ diaryLayer: id }, "");
  } catch (err) {
    /* history unavailable: the close buttons still work */
  }
}

// A dialog leaves the way it came, a little quicker than it arrived. One that
// was pulled down by hand is already off screen and just goes.
function hideLayer(id) {
  const el = $(id);
  const animate = el.classList.contains("modal-backdrop") && !el.dataset.dismissed && !el.hidden &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finish = () => {
    closingLayers.delete(id);
    el.classList.remove("is-closing");
    el.hidden = true;
    delete el.dataset.dismissed;
    const modal = el.querySelector(".modal");
    if (modal) {
      modal.style.transform = "";
      modal.style.transition = "";
    }
  };
  if (!animate) {
    finish();
    return;
  }
  el.classList.add("is-closing");
  clearTimeout(closingLayers.get(id));
  closingLayers.set(id, setTimeout(finish, 190));
}

function closeLayer(id) {
  hideLayer(id);
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

/* On a phone a dialog is a sheet from the bottom, and like any sheet it can be
   pulled down by its top to close: far enough, or with a quick flick. Pulled
   up, it gives a little and springs back. */
let sheetDrag = null;

document.addEventListener("pointerdown", (event) => {
  if (sheetDrag || window.innerWidth > 720 || event.button > 0) return;
  const head = event.target.closest(".modal-head");
  if (!head || event.target.closest("button, a, input, select, textarea, label")) return;
  const backdrop = head.closest(".modal-backdrop");
  const top = layers[layers.length - 1];
  if (!backdrop || !top || top.id !== backdrop.id) return;
  const modal = head.closest(".modal");
  sheetDrag = { head, modal, backdrop, layer: top, pointer: event.pointerId,
    startY: event.clientY, startedAt: performance.now(), dy: 0 };
  try {
    head.setPointerCapture(event.pointerId);
  } catch (err) {
    /* the drag still follows the pointer while it stays over the page */
  }
  modal.style.transition = "none";
});

document.addEventListener("pointermove", (event) => {
  if (!sheetDrag || event.pointerId !== sheetDrag.pointer) return;
  const raw = event.clientY - sheetDrag.startY;
  sheetDrag.dy = raw >= 0 ? raw : -Math.sqrt(-raw) * 2;
  sheetDrag.modal.style.transform = "translateY(" + sheetDrag.dy + "px)";
});

function endSheetDrag(event) {
  if (!sheetDrag || event.pointerId !== sheetDrag.pointer) return;
  const { modal, backdrop, layer, dy, startedAt } = sheetDrag;
  sheetDrag = null;
  const speed = Math.abs(dy) / Math.max(1, performance.now() - startedAt);
  const away = dy > 0 && (dy > modal.offsetHeight * 0.3 || (dy > 24 && speed > 0.11));
  if (away && (!layer.guard || layer.guard())) {
    modal.style.transition = "transform 200ms cubic-bezier(0.23, 1, 0.32, 1)";
    modal.style.transform = "translateY(100%)";
    backdrop.classList.add("is-closing");
    backdrop.dataset.dismissed = "1";
    setTimeout(() => {
      if (layers.includes(layer)) layer.close();
      else hideLayer(backdrop.id);
    }, 200);
    return;
  }
  modal.style.transition = "transform 280ms cubic-bezier(0.32, 0.72, 0, 1)";
  modal.style.transform = "";
}
document.addEventListener("pointerup", endSheetDrag);
document.addEventListener("pointercancel", endSheetDrag);

// Cards animate in when the list is loaded or the tab changes, not on every
// filter keystroke, where replaying the entrance just makes the page flicker.
function render(animate) {
  const rows = state.view === "rows";
  // Cards arrive with a short cascade the first time the diary shows, and never
  // again: tabs are switched far too often for an entrance each time.
  const entrance = animate && !state.entered;
  $("list").className = (rows ? "rows" : "grid") + (entrance ? "" : " calm");
  const wishlist = state.items.filter((i) => i.status === "wishlist");
  const visited = state.items.filter((i) => i.status === "visited");

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
  } else if (!items.length) {
    $("list").innerHTML = emptyMarkup();
  } else {
    $("list").innerHTML = rows
      ? '<ul class="rows-list">' + items.map(rowMarkup).join("") + "</ul>"
      : items.map(cardMarkup).join("");
    if (entrance && !rows) {
      $("list").querySelectorAll(".card").forEach((card, i) => card.style.setProperty("--i", Math.min(i, 8)));
    }
    state.entered = true;
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
    .replace(/['"\u05f4\u05f3`\u2019.,!?&()\-\u2013\u2014_/:]+/g, " ");
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

const STREET_WORDS = /\b(st|street|str|rd|road|ave|avenue|blvd|boulevard|sderot|rehov|derech|israel)\b/g;

/** The words and house numbers of an address, without the city it's in. */
function addressParts(text, cities) {
  const clean = (value) => String(value || "").toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[\u0591-\u05c7]/g, "")
    .replace(/['"\u05f3\u05f4`\u2019]|(?<=\p{L})-(?=\p{L})/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").replace(STREET_WORDS, " ");
  const cityWords = new Set(cities.flatMap((city) => clean(city).split(" ")).filter(Boolean));
  const tokens = clean(text).split(" ").filter(Boolean);
  return {
    numbers: tokens.filter((token) => /^\d+[a-z]?$/.test(token)),
    words: tokens.filter((token) => !/\d/.test(token) && !cityWords.has(token)),
  };
}

// The same street and house number, however each was written: "3 Ahad Ha'Am
// St., Tel Aviv" and "Ahad HaAm 3" are one address; "Dizengoff 100" and
// "Dizengoff 50" are two branches.
function sameAddress(a, b, cities) {
  const one = addressParts(a, cities);
  const two = addressParts(b, cities);
  if (one.numbers.length && two.numbers.length &&
      !one.numbers.some((number) => two.numbers.includes(number))) {
    return false;
  }
  const [shorter, longer] = one.words.length <= two.words.length
    ? [one.words, two.words] : [two.words, one.words];
  return shorter.length > 0 && shorter.every((word) => longer.includes(word));
}

function sameIds(a, b) {
  if (a.google_place_id && a.google_place_id === b.google_place_id) return true;
  return !!(a.osm_id && b.osm_id && String(a.osm_id) === String(b.osm_id) &&
    (a.osm_type || "") === (b.osm_type || ""));
}

// The same name is not enough — branches of a chain all share it. It's the
// same place only when the address matches too, or when the two pins sit on
// the same doorstep (one address in Hebrew and one in English, say).
function samePlace(place, other) {
  const address = place.address || place.full_address || "";
  const lat = parseFloat(place.lat);
  const lon = parseFloat(place.lon);
  const otherLat = parseFloat(other.lat);
  const otherLon = parseFloat(other.lon);
  const km = isFinite(lat) && isFinite(lon) && isFinite(otherLat) && isFinite(otherLon)
    ? haversineKm({ lat: lat, lon: lon }, { lat: otherLat, lon: otherLon }) : null;
  if (km !== null && km <= 0.05) return true;
  if (address && other.address) {
    // The same street name in two different towns isn't the same place.
    if (km !== null && km > 2) return false;
    return sameAddress(address, other.address, [place.city, other.city]);
  }
  return km !== null && km <= 0.15;
}

function findDuplicates(place) {
  const names = [place.name, place.local_name].map(normalizeName).filter(Boolean);
  return state.items.filter((item) => {
    // A chain is at each of its branches as much as at its own address.
    const spots = [item].concat(branchesOf(item));
    if (spots.some((spot) => sameIds(place, spot))) return true;
    // A Google suggestion has no location yet, so a name alone would flag every
    // branch of a chain; the full check runs once its details are loaded.
    if (place.needs_details) return false;
    const itemNames = [item.name, item.local_name].map(normalizeName).filter(Boolean);
    if (!names.some((a) => itemNames.some((b) => namesMatch(a, b)))) return false;
    return spots.some((spot) => samePlace(place, spot));
  });
}

/** Also true for a branch of a chain that's already saved. */
function alreadyInDiary(place) {
  if (findDuplicates(place).length) return true;
  const lat = parseFloat(place.lat);
  const lon = parseFloat(place.lon);
  if (!isFinite(lat) || !isFinite(lon)) return false;
  return state.items.some((item) => branchesOf(item).some((branch) => {
    const bLat = parseFloat(branch.lat);
    const bLon = parseFloat(branch.lon);
    return isFinite(bLat) && isFinite(bLon) &&
      haversineKm({ lat: lat, lon: lon }, { lat: bLat, lon: bLon }) <= 0.15;
  }));
}

/** The save button says what saving will do. */
function showBranchChoice() {
  if (!state.chainWith || !$("dup-warning").hidden) return;
  $("save-place").textContent = $("branch-check").checked ? "Add as a branch" : "Save restaurant";
}

function listName(item) {
  return item.status === "visited" ? "your visits" : "your wishlist";
}

/* ---------- one chain, one entry ----------
   Two places by the same name at different addresses are most likely branches
   of one chain. The diary offers to keep them as a single entry, both when the
   second one is added and for pairs that are already saved apart. */

const nameParts = new Map();
function partsOf(name) {
  if (!nameParts.has(name)) nameParts.set(name, chainNameParts(name));
  return nameParts.get(name);
}

function chainNames(place) {
  return [place.name, place.local_name].filter(Boolean)
    .flatMap((name) => partsOf(name).map((part) => part.key));
}

/** What the joined entry is called: the part of the name both listings share. */
function chainTitle(item, other) {
  const theirs = new Set(chainNames(other));
  const shared = partsOf(item.name || "").find((part) => theirs.has(part.key));
  return shared ? shared.text : item.name;
}

/** Other entries that look like branches of the same chain as `place`. */
function chainMates(place, exceptId) {
  const keys = chainNames(place);
  if (!keys.length) return [];
  return state.items.filter((item) => item.id !== exceptId &&
    chainNames(item).some((key) => keys.includes(key)));
}

function branchFrom(place) {
  return {
    name: place.name || "", address: place.address || "", city: place.city || "",
    lat: place.lat || "", lon: place.lon || "", opening_hours: place.opening_hours || "",
    phone: place.phone || "", osm_id: place.osm_id || null, osm_type: place.osm_type || null,
    google_place_id: place.google_place_id || "",
  };
}

/** The branches an entry stands for: its own list, or itself if it isn't a chain yet. */
function branchesFor(item) {
  return item.chain && Array.isArray(item.branches) && item.branches.length
    ? item.branches.slice() : [branchFrom(item)];
}

/** What `into` takes on from `other` when the two become one entry. */
function mergedChanges(into, other) {
  const branches = branchesFor(into);
  branchesFor(other).forEach((branch) => {
    if (!branches.some((known) => sameIds(branch, known) || samePlace(branch, known))) branches.push(branch);
  });
  const changes = { chain: true, branches, branches_at: into.branches_at || nowIso() };
  // "Pizza X - Neapolitan, Dizengoff" and "Pizza X - Rishon" become "Pizza X";
  // each branch keeps its own full name.
  const title = chainTitle(into, other);
  if (title && title !== into.name) changes.name = title;
  // Nothing either one says is lost: been to one branch is been to the chain.
  if (other.status === "visited" && into.status !== "visited") {
    changes.status = "visited";
    changes.visited_at = other.visited_at || nowIso();
  }
  const join = (a, b) => [a, b].map((text) => (text || "").trim()).filter(Boolean)
    .filter((text, i, all) => all.indexOf(text) === i).join("\n\n");
  if (other.review) changes.review = join(into.review, other.review);
  if (other.wish_note) changes.wish_note = join(into.wish_note, other.wish_note);
  if ((other.dishes || []).length) changes.dishes = [...new Set((into.dishes || []).concat(other.dishes))];
  if (other.favorite && !into.favorite) changes.favorite = true;
  ["rating", "price", "website", "phone", "cuisine", "source_url", "google_maps_uri", "menu"].forEach((key) => {
    if (!into[key] && other[key]) changes[key] = other[key];
  });
  return changes;
}

/** Makes an entry and the others by its name one chain. */
function mergeChain(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  const group = [item].concat(chainMates(item, id));
  if (group.length < 2) return;
  // Photos belong to the entry they were added to, so that one is the one kept.
  const withPhotos = group.filter((i) => (i.photos || []).length);
  if (withPhotos.length > 1) {
    toast("Both " + item.name + " entries have photos, so they can't be joined yet — " +
      "remove the photos from one of them first.");
    return;
  }
  const keep = withPhotos[0] || group.find((i) => i.chain) || group.find((i) => i.status === "visited") || item;
  const others = group.filter((i) => i !== keep);
  if (!window.confirm("Make " + chainTitle(keep, others[0]) + " one entry with all " + group.length + " branches? " +
      "Notes, reviews and ratings from each are kept on it.")) {
    return;
  }
  let merged = keep;
  let changes = {};
  others.forEach((other) => {
    const more = mergedChanges(merged, other);
    changes = { ...changes, ...more };
    merged = { ...merged, ...more };
  });
  updateItem(keep.id, changes);
  others.forEach((other) => deleteItem(other.id));
  // Show the joined entry where it now lives (a visit to one branch counts).
  state.tab = merged.status;
  syncTabs();
  render();
  toast(merged.name + " is one entry now, with " + merged.branches.length + " branches.");
}

/** "These just share a name": stop offering to join them. */
function keepApart(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  [item].concat(chainMates(item, id)).forEach((i) => updateItem(i.id, { chain_apart: true }));
  render();
}

function chainHintMarkup(item) {
  if (item.chain_apart) return "";
  const mates = chainMates(item, item.id).filter((mate) => !mate.chain_apart);
  if (!mates.length) return "";
  const where = mates.map((mate) => esc(mate.address || mate.city || "another address") +
    (mate.status !== item.status ? " (" + (mate.status === "visited" ? "been there" : "want to go") + ")" : ""));
  return '<div class="meta-row chain-hint">' + icon("pin") + "<span>Also in your diary at " +
    where.join(", ") + ". " +
    '<button type="button" class="link-btn" data-act="merge" data-id="' + esc(item.id) +
    '">Make it one chain</button> · ' +
    '<button type="button" class="link-btn" data-act="apart" data-id="' + esc(item.id) +
    '">Not the same place</button></span></div>';
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
  if (state.view === "map") setView(startingView());
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

// Each pill that wraps a dropdown shows what's chosen inside it.
function syncChipValues() {
  document.querySelectorAll(".chip-value").forEach((label) => {
    const select = $(label.dataset.for);
    if (!select) return;
    const option = select.options[select.selectedIndex];
    label.textContent = option ? option.textContent : "";
  });
}

function updateFilterBar() {
  syncChipValues();
  $("cuisine-wrap").classList.toggle("is-on", !!state.cuisine);
  $("city-wrap").classList.toggle("is-on", !!state.city);

  // "Open now" and "Near me" are always in view; the chip counts what's folded behind it.
  const folded = [!!state.cuisine, !!state.city].filter(Boolean).length;
  $("filters-count").textContent = folded;
  $("filters-count").hidden = !folded;
  const active = folded + [state.openNow, !!state.origin].filter(Boolean).length;
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
  showSuggestLabel();
  suggestionBox("");
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
  state.sharedLink = "";
  state.suggested = null;
  showSharedSource("");
  suggestionBox("");
  // Every visit starts from "any type, anywhere"; the last spot and distance
  // are kept for when they're chosen again.
  state.suggest.type = "";
  state.suggest.where = "country";
  $("suggest-type").value = "";
  showSuggestArea();
  clearDraftPhotos();
}

// The card and the search are two ways in: while a name is being typed, the
// results get the room.
function showRecommend() {
  $("recommend").hidden = !!$("place-search").value.trim() || !$("share-source").hidden;
}

function setSearchNotice(text) {
  $("search-notice").textContent = text;
  $("search-notice").hidden = !text;
}

/* ---------- recommend one ----------
   For the evenings with no idea where to go: a well-known place that isn't in
   the diary yet. It can be narrowed to a kind of food and to an area — near you,
   or around any spot you pick on the map. */

// Google answers one question with about twenty places, so the question changes
// as they run out. Every place already offered is remembered, so the same names
// don't come round again.
const SUGGEST_OPENERS = ["popular", "best", "famous", "highly rated", "well known", "top rated"];
const SUGGEST_CUISINES = ["italian", "sushi", "seafood", "vegetarian", "steak", "middle eastern",
  "burger", "asian", "french", "breakfast", "bakery", "pizza", "mexican", "indian", "tapas",
  "hummus", "fish", "vegan", "dessert", "grill"];

// What "kind of place" can be asked for. `included` is Google's own type, for
// the kinds that aren't restaurants.
const PLACE_KINDS = [
  { value: "", label: "Any type", phrase: "a restaurant" },
  { value: "italian", label: "Italian", phrase: "an Italian restaurant" },
  { value: "pizza", label: "Pizza", phrase: "a pizza place", noun: "pizza places" },
  { value: "sushi", label: "Sushi", phrase: "a sushi place" },
  { value: "asian", label: "Asian", phrase: "an Asian restaurant" },
  { value: "middle eastern", label: "Middle Eastern", phrase: "a Middle Eastern restaurant" },
  { value: "hummus", label: "Hummus", phrase: "a hummus place", noun: "hummus places" },
  { value: "seafood", label: "Seafood", phrase: "a seafood restaurant" },
  { value: "steak", label: "Steak & grill", phrase: "a steak & grill place", noun: "steakhouses and grills" },
  { value: "burger", label: "Burgers", phrase: "a burger place", noun: "burger places" },
  { value: "vegan", label: "Vegan & vegetarian", phrase: "a vegan or vegetarian place",
    noun: "vegan and vegetarian restaurants" },
  { value: "breakfast", label: "Breakfast & brunch", phrase: "a breakfast place", noun: "breakfast and brunch places" },
  { value: "french", label: "French", phrase: "a French restaurant" },
  { value: "mexican", label: "Mexican", phrase: "a Mexican restaurant" },
  { value: "indian", label: "Indian", phrase: "an Indian restaurant" },
  { value: "thai", label: "Thai", phrase: "a Thai restaurant" },
  { value: "dessert", label: "Dessert", phrase: "a dessert place", noun: "dessert places" },
  { value: "cafe", label: "Café", phrase: "a café", noun: "cafes", included: "cafe" },
  { value: "bakery", label: "Bakery", phrase: "a bakery", noun: "bakeries", included: "bakery" },
  { value: "bar", label: "Bar", phrase: "a bar", noun: "bars", included: "bar" },
];

const pools = new Map(); // one list of places per set of filters

function suggestCountry() {
  const code = state.searchCountry || HOME_COUNTRY;
  return { code, name: countryName(code) };
}

function suggestKind() {
  return PLACE_KINDS.find((kind) => kind.value === state.suggest.type) || PLACE_KINDS[0];
}

/** The area to search in, or null for the whole country. */
function suggestArea() {
  const point = state.suggest.point;
  if (state.suggest.where === "country" || !point) return null;
  return { lat: point.lat, lon: point.lon, radius: state.suggest.radius };
}

function suggestQuery(angle) {
  const kind = suggestKind();
  const tail = suggestArea() ? "" : " in " + suggestCountry().name;
  const opener = SUGGEST_OPENERS[angle % SUGGEST_OPENERS.length];
  if (kind.value) return opener + " " + (kind.noun || kind.value + " restaurants") + tail;
  if (angle < SUGGEST_OPENERS.length) return opener + " restaurants" + tail;
  const cuisine = SUGGEST_CUISINES[(angle - SUGGEST_OPENERS.length) % SUGGEST_CUISINES.length];
  return "best " + cuisine + " restaurants" + tail;
}

/** Each set of filters keeps its own list and its own memory of what's been shown. */
function suggestKey() {
  const area = suggestArea();
  return [suggestCountry().code, state.suggest.type || "any",
    area ? area.lat.toFixed(2) + "," + area.lon.toFixed(2) + "@" + area.radius : "all"].join("|");
}

function saveSuggestFilters() {
  writeSetting("suggest-filters", state.suggest);
}

/* ---------- the filter panel ---------- */

function buildKindOptions() {
  $("suggest-type").innerHTML = PLACE_KINDS
    .map((kind) => '<option value="' + esc(kind.value) + '">' + esc(kind.label) + "</option>").join("");
  $("suggest-type").value = state.suggest.type;
}

function showSuggestLabel() {
  const what = suggestKind().phrase;
  const point = state.suggest.point;
  let where = " in " + suggestCountry().name;
  if (state.suggest.where === "me" && point) where = " near me";
  else if (state.suggest.where === "spot" && point) where = " near " + point.label;
  else if (state.suggest.where !== "country") where = "";
  $("suggest-label").textContent = "Recommend me " + what + where;
  syncChipValues();
}

const RADII = [1, 2, 5, 10, 25, 50];

/** Moves a switch's highlight to the chosen option. */
function setSegment(group, attribute, value) {
  const options = [...group.querySelectorAll("[" + attribute + "]")];
  const index = Math.max(0, options.findIndex((option) => option.getAttribute(attribute) === String(value)));
  options.forEach((option, i) => {
    option.setAttribute("aria-checked", i === index ? "true" : "false");
    option.tabIndex = i === index ? 0 : -1;
  });
  group.style.setProperty("--index", index);
}

function showSuggestArea() {
  const mode = state.suggest.where;
  if (!RADII.includes(state.suggest.radius)) state.suggest.radius = 5;
  setSegment($("where-seg"), "data-where", mode);
  setSegment($("radius-seg"), "data-radius", state.suggest.radius);
  $("suggest-area").hidden = mode === "country";
  $("spot-search").hidden = mode !== "spot";
  $("spot-map").hidden = mode !== "spot";
  $("radius-label").textContent = mode === "me" ? "How far from you" : "How far from the spot";
  const point = state.suggest.point;
  $("spot-label").textContent = point && mode === "spot" ? "Looking around " + point.label
    : mode === "me" && point ? "Looking around where you are now" : "";
  showSuggestLabel();
}

function setSuggestPoint(lat, lon, label) {
  state.suggest.point = { lat: Number(lat), lon: Number(lon), label: label || "the spot you picked" };
  saveSuggestFilters();
  suggestionBox("");
  showSuggestArea();
  if (spotMap) {
    const here = [state.suggest.point.lat, state.suggest.point.lon];
    if (spotPin) spotPin.setLatLng(here);
    else spotPin = window.L.marker(here).addTo(spotMap);
    spotMap.setView(here, Math.max(spotMap.getZoom(), 13), { animate: false });
  }
}

let spotMap = null;
let spotPin = null;
let spotMapLoading = null;

function ensureSpotMap() {
  if (spotMap) {
    setTimeout(() => spotMap.invalidateSize({ animate: false }), 60);
    return Promise.resolve();
  }
  // Choosing "Pick a spot" and finding an address both ask for the map; the
  // second ask waits for the first instead of building a map of its own.
  if (!spotMapLoading) {
    spotMapLoading = buildSpotMap().finally(() => { spotMapLoading = null; });
  }
  return spotMapLoading;
}

async function buildSpotMap() {
  try {
    await loadLeaflet();
  } catch (err) {
    $("spot-label").textContent = err.message;
    return;
  }
  const point = state.suggest.point || state.origin;
  const centre = point ? [point.lat, point.lon] : [32.08, 34.78];
  spotMap = window.L.map($("spot-map"), { scrollWheelZoom: false, attributionControl: false })
    .setView(centre, point ? 13 : 8);
  window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(spotMap);
  if (state.suggest.point) {
    spotPin = window.L.marker([state.suggest.point.lat, state.suggest.point.lon]).addTo(spotMap);
  }
  spotMap.on("click", async (event) => {
    const { lat, lng } = event.latlng;
    setSuggestPoint(lat, lng, "the spot you picked");
    $("spot-label").textContent = "Looking around the spot you picked…";
    try {
      const label = await reverseGeocode(lat, lng);
      if (label && state.suggest.point && state.suggest.point.lat === lat) {
        setSuggestPoint(lat, lng, label);
      }
    } catch (err) {
      /* the point works even without a name for it */
    }
  });
  setTimeout(() => spotMap.invalidateSize({ animate: false }), 60);
}

function whereIsHere() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("This browser can't share your location."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lon: position.coords.longitude }),
      (error) => reject(new Error(error.code === error.PERMISSION_DENIED
        ? "Location permission denied — allow it, or pick a spot on the map instead."
        : "Could not get your location.")),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  });
}

async function setSuggestWhere(mode) {
  state.suggest.where = mode;
  if (mode === "country") {
    saveSuggestFilters();
    suggestionBox("");
    showSuggestArea();
    return;
  }
  if (mode === "spot") {
    saveSuggestFilters();
    showSuggestArea();
    ensureSpotMap();
    return;
  }
  // Near me: ask the phone where that is.
  $("spot-label").textContent = "Finding your location…";
  showSuggestArea();
  try {
    const here = state.origin || await whereIsHere();
    setSuggestPoint(here.lat, here.lon, "where you are now");
  } catch (err) {
    state.suggest.where = "country";
    showSuggestArea();
    toast(err.message);
  }
}

/* ---------- asking Google ---------- */

function suggestionBox(html) {
  const box = $("suggestion");
  const swapping = !box.hidden && !!box.innerHTML && !!html;
  box.innerHTML = html;
  box.hidden = !html;
  // A new answer where the last one was: a quick blur-in reads as "this
  // changed", where a hard swap reads as a flicker.
  if (swapping && box.animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    box.animate([{ opacity: 0.35, filter: "blur(3px)" }, { opacity: 1, filter: "blur(0)" }],
      { duration: 220, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
  }
}

// What this device has already been offered for these filters, so tomorrow's
// suggestions carry on rather than start over.
function suggestMemory(key) {
  const saved = readSetting("suggest-" + key, null);
  return {
    angle: (saved && Number(saved.angle)) || 0,
    seen: new Set((saved && saved.seen) || []),
  };
}

function rememberSuggestions(key, memory) {
  writeSetting("suggest-" + key, { angle: memory.angle, seen: [...memory.seen].slice(-300) });
}

/** The next place nobody has been offered yet, and that isn't in the diary. */
function nextSuggestion(key, memory) {
  const pool = pools.get(key) || [];
  for (const place of pool) {
    const id = place.google_place_id || place.name;
    if (memory.seen.has(id) || alreadyInDiary(place)) continue;
    memory.seen.add(id);
    rememberSuggestions(key, memory);
    return place;
  }
  return null;
}

function addToPool(key, places) {
  const pool = pools.get(key) || [];
  const known = new Set(pool.map((place) => place.google_place_id));
  places.forEach((place) => {
    if (!known.has(place.google_place_id)) pool.push(place);
  });
  // Shuffled, so the answer isn't Google's order every evening, but the places
  // people rate well (and in numbers) come round before the rest.
  const praised = (place) => place.google_rating >= 4.2 && place.google_rating_count >= 100;
  const shuffled = pool.sort(() => Math.random() - 0.5);
  pools.set(key, shuffled.filter(praised).concat(shuffled.filter((place) => !praised(place))));
}

function suggestWhereText() {
  const area = suggestArea();
  if (!area) return "in " + suggestCountry().name;
  const point = state.suggest.point;
  return "within " + state.suggest.radius + " km of " +
    (state.suggest.where === "me" ? "you" : point.label);
}

function showSuggestion(place) {
  state.suggested = place;
  const kind = typeName(place.place_type) || "Restaurant";
  // How far from the spot searched around, or from you when searching anywhere.
  const from = suggestArea() || state.origin;
  const km = from ? haversineKm(
    { lat: from.lat, lon: from.lon },
    { lat: parseFloat(place.lat), lon: parseFloat(place.lon) },
  ) : null;
  const maps = safeUrl(place.google_maps_uri);
  // The same facts a search result shows once it's picked.
  suggestionBox('<div class="suggestion-head">' + icon("sparkle") +
    "<span>Well known " + esc(suggestWhereText()) + "</span></div>" +
    "<h3>" + esc(place.name) + "</h3>" +
    '<p class="suggestion-where">' + esc(kind) + (place.price ? " · " + priceStatic(place.price) : "") +
    (km !== null ? " · " + esc(formatDistance(km)) : "") + "</p>" +
    '<div class="card-meta">' + metaMarkup(place, true) +
    (maps ? '<div class="meta-row">' + icon("external") + '<span><a href="' + esc(maps) +
      '" target="_blank" rel="noopener noreferrer">See it on Google Maps</a></span></div>' : "") +
    "</div>" +
    '<div class="suggestion-actions">' +
    '<button type="button" class="btn btn-primary btn-sm" data-suggest="take">' + icon("plus") +
    "Add this one</button>" +
    '<button type="button" class="btn btn-ghost btn-sm" data-suggest="next">' + icon("refresh") +
    "Another one</button></div>");
}

async function recommend() {
  if (!googleStatus().configured) {
    suggestionBox('<p class="menu-message">Recommendations come from Google Maps. Connect it in ' +
      "Settings (the gear at the top) and this will work.</p>");
    return;
  }
  if (state.suggest.where !== "country" && !state.suggest.point) {
    suggestionBox('<p class="menu-message">Pick the spot to search around first.</p>');
    return;
  }

  const key = suggestKey();
  const memory = suggestMemory(key);
  const ready = nextSuggestion(key, memory);
  if (ready) {
    showSuggestion(ready);
    return;
  }

  suggestionBox('<p class="menu-status">' + spinnerMarkup() + "Looking for a good place " +
    esc(suggestWhereText()) + "…</p>");
  const button = $("suggest-btn");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    // Ask a different way until something new comes back (or it's clear this
    // corner has been mined out for now).
    for (let tries = 0; tries < 3; tries += 1) {
      const query = suggestQuery(memory.angle);
      memory.angle += 1;
      rememberSuggestions(key, memory);
      addToPool(key, await suggestPlaces(suggestCountry().code, query, {
        area: suggestArea(), includedType: suggestKind().included,
      }));
      applyGoogleStatus();
      const place = nextSuggestion(key, memory);
      if (place) {
        showSuggestion(place);
        return;
      }
    }
    memory.seen = new Set();
    memory.angle = 0;
    rememberSuggestions(key, memory);
    suggestionBox('<p class="menu-message">That is everything Google suggested ' +
      esc(suggestWhereText()) + " so far — they're either in your diary already or you've just " +
      "seen them. Tap again to start the round afresh, or widen the search.</p>");
  } catch (err) {
    suggestionBox('<p class="menu-error">' + esc(err.message) +
      (/unknown request kind|violates check constraint|invalid usage/i.test(err.message)
        ? " Run supabase/schema.sql once more so the diary counts recommendations too." : "") + "</p>");
    applyGoogleStatus();
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

/* ---------- a reel shared from Instagram ----------
   Instagram won't tell anyone who isn't logged in what a reel says, but the
   link does name the account that posted it. When that account is the
   restaurant's own, its name is enough to look the place up; when it's a food
   account, the search is simply left open and ready. */

function showSharedSource(html) {
  $("share-source").innerHTML = html;
  $("share-source").hidden = !html;
  $("add-hint").hidden = !!html;
  showRecommend();
}

function sharedBox(who, inner) {
  showSharedSource(icon("share") + "<div><strong>Saved from " + esc(who) + "</strong>" + inner + "</div>");
}

function searchFor(name) {
  $("place-search").value = name;
  showRecommend();
  runSearch(name);
}

async function startFromShare(link) {
  openAdd();
  state.sharedLink = link;
  const site = hostOf(link).endsWith("instagram.com") ? "Instagram" : hostOf(link);
  sharedBox(site, '<p class="menu-status">' + spinnerMarkup() + "Reading the link…</p>");

  let info = null;
  try {
    info = await readSharedLink(link);
  } catch (err) {
    sharedBox(site, "<p>Couldn't read the link (" + esc(err.message) + "). Type the restaurant's name " +
      "below — the link is kept with whatever you save.</p>");
    return;
  }

  state.sharedLink = info.url || link;
  const who = info.handle ? "@" + info.handle : site;
  const headline = (info.caption || "").split("\n")[0].trim();
  const quote = headline ? '<p class="share-caption">“' + esc(headline.slice(0, 140)) + "”</p>" : "";
  // Restaurants tagged in the reel first; otherwise the account that posted it.
  const tagged = (info.places || []).filter((place) => place.name || place.handle);

  if (tagged.length > 1) {
    sharedBox(who, quote + "<p>Which one?</p><div class=\"share-picks\">" + tagged.map((place) =>
      '<button type="button" class="chip" data-search="' + esc(place.name || place.handle) + '">' +
      esc(place.name || "@" + place.handle) + "</button>").join("") + "</div>");
    return;
  }

  const name = tagged.length ? (tagged[0].name || tagged[0].handle) : (info.name || "").trim();
  if (name) {
    sharedBox(who, quote + "<p>Looking for <strong>" + esc(name) + "</strong> — tap it below to save it, " +
      "or type another name if the reel was about somewhere else.</p>");
    searchFor(name);
    return;
  }
  sharedBox(who, quote + "<p>Instagram doesn't say which place this is about, so type its name below. " +
    "The link is kept with whatever you save.</p>");
}

/** A link shared into the diary, from the share sheet or a pasted address. */
function sharedFromAddress() {
  const params = new URLSearchParams(location.search);
  const raw = [params.get("url"), params.get("text"), params.get("title")].filter(Boolean).join(" ");
  if (!raw) return "";
  // Address bars are for the diary, not for the last thing shared into it.
  history.replaceState({}, "", location.pathname);
  const found = raw.match(/https?:\/\/[^\s]+/);
  return found ? found[0] : "";
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

  // Another branch of a place already saved: offer to keep them as one entry.
  const duplicates = findDuplicates(place);
  const mates = manual ? [] : chainMates(place, null).filter((mate) => !duplicates.includes(mate));
  state.chainWith = mates.find((mate) => mate.chain) || mates[0] || null;
  $("branch-option").hidden = !state.chainWith;
  if (state.chainWith) {
    const mate = state.chainWith;
    const count = branchesFor(mate).length + 1;
    $("branch-check").checked = !mate.chain_apart;
    $("branch-title").textContent = "Add as another branch of " + chainTitle(mate, place);
    $("branch-help").textContent = mate.name + " is already in " + listName(mate) +
      (mate.chain ? " with " + branchesFor(mate).length + " branches"
        : " (" + (mate.address || mate.city || "another address") + ")") +
      ". This keeps one entry with " + count + " branches, and Near me uses the closest.";
    showBranchChoice();
  }

  // Chains: ask the built-in Israeli list whether this name is in many places.
  state.branches = [];
  $("chain-option").hidden = true;
  $("chain-check").checked = false;
  if (!manual && place.name && !state.chainWith) {
    const country = place.country_code || state.searchCountry || HOME_COUNTRY;
    findBranches(place.name, country).then((branches) => {
      if (state.selectedPlace !== place || branches.length < 3) return;
      state.branches = branches;
      $("chain-title").textContent = "Save as one chain (" + branches.length + " places)";
      $("chain-help").textContent = "Keeps a single " + place.name + " in the diary and remembers " +
        "where every branch is, so Near me points at the closest one.";
      $("chain-option").hidden = false;
    }).catch(() => { /* no list for this country */ });
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
    place_type: place.place_type || "",
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
    source_url: state.sharedLink || "",
    source: place.google_place_id ? "google" : place.osm_id ? "osm" : "manual",
    added_at: nowIso(),
    dishes: [],
    photos: [],
  };

  if (!item.name) { toast("Give the restaurant a name first."); return; }

  const mate = state.chainWith && $("branch-check").checked ? store.get(state.chainWith.id) : null;
  if (mate) {
    fillPersonal(item, status);
    await saveAsBranch(mate, item);
    return;
  }

  if ($("chain-check").checked && state.branches.length) {
    item.chain = true;
    item.branches = state.branches;
    item.branches_at = nowIso();
  }

  fillPersonal(item, status);

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

/** What was written in the add dialog: a review for a visit, a note for the wishlist. */
function fillPersonal(item, status) {
  if (status === "visited") {
    item.rating = state.draftRating;
    item.review = $("review").value.trim();
    item.dishes = $("dishes").value.split(",").map((d) => d.trim()).filter(Boolean);
    item.visited_at = nowIso();
  } else {
    item.wish_note = $("wish-note").value.trim();
  }
}

/** The new place joins an entry already saved, as one more of its branches. */
async function saveAsBranch(mate, item) {
  const changes = mergedChanges(mate, item);
  updateItem(mate.id, changes);

  const button = $("save-place");
  const buttonText = button.textContent;
  let upload = null;
  if (item.status === "visited" && state.pendingPhotos.length) {
    button.disabled = true;
    upload = await addPhotos(mate.id, state.pendingPhotos.map((p) => p.file), (n, total) => {
      button.textContent = "Saving photo " + n + " of " + total + "…";
    });
    button.textContent = buttonText;
    button.disabled = false;
  }

  closeAdd();
  state.tab = changes.status || mate.status;
  syncTabs();
  if (upload && upload.failures.length) reportUpload(upload);
  else toast((changes.name || mate.name) + " now has " + changes.branches.length + " branches in one entry.");
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

/* ---------- editing a restaurant's details ----------
   Everything the search filled in can be corrected by hand: places move, change
   their hours, or were never found properly in the first place. */

const DETAIL_FIELDS = {
  "d-name": "name", "d-local": "local_name", "d-address": "address", "d-city": "city",
  "d-cuisine": "cuisine", "d-hours": "opening_hours", "d-phone": "phone", "d-website": "website",
  "d-note": "wish_note", "d-source": "source_url",
};

let detailsId = null;
let detailsSnapshot = "";

function detailsStatus() {
  const checked = document.querySelector('input[name="d-status"]:checked');
  return checked && checked.value === "visited" ? "visited" : "wishlist";
}

function detailsValues() {
  return JSON.stringify([
    ...Object.keys(DETAIL_FIELDS).map((id) => $(id).value.trim()), state.detailsPrice, detailsStatus(),
    $("d-chain").checked, state.detailsBranches.length,
  ]);
}

function showChainHelp() {
  const count = state.detailsBranches.length;
  $("d-chain-help").textContent = count
    ? count + " branch" + (count === 1 ? "" : "es") + " known. Near me and the map use the closest one."
    : "None known yet. “Find its branches” looks them up — free in Israel, one Google " +
      "search elsewhere.";
  $("d-chain").disabled = !count;
}

async function findBranchesFor(name, item) {
  const country = state.searchCountry || HOME_COUNTRY;
  const local = await findBranches(name, country);
  if (local.length) return local;
  if (!googleStatus().configured) return [];
  // Outside Israel there's no built-in list, so this is one Google search.
  const places = await findBranchesOnline(name, country, item.city || item.country || "");
  const wanted = chainKey(name);
  return places.filter((place) => chainKey(place.name) === wanted).map((place) => ({
    name: place.name,
    address: place.address || "",
    city: place.city || "",
    lat: place.lat,
    lon: place.lon,
    opening_hours: "",
    phone: "",
    google_place_id: place.google_place_id || "",
  }));
}

// Opening hours are written the way the map data writes them, so the box says
// plainly whether what's typed can be read back.
function showHoursPreview() {
  const help = $("d-hours-help");
  const raw = $("d-hours").value.trim();
  help.classList.remove("is-bad", "is-good");
  if (!raw) {
    help.textContent = "Days are Mo Tu We Th Fr Sa Su; separate rules with a semicolon. " +
      "Leave empty if you don't know them.";
    return;
  }
  const parsed = parseOpeningHours(raw);
  const today = todayHours(parsed, new Date());
  if (today === null) {
    help.textContent = "This can't be read as opening hours, so the diary won't know when it's open. " +
      "Example: Mo-Fr 09:00-17:00; Sa 10:00-14:00";
    help.classList.add("is-bad");
    return;
  }
  const nowOpen = openNow(parsed, new Date());
  help.textContent = "Today: " + today + (nowOpen === null ? "" : nowOpen ? " — open now" : " — closed now");
  help.classList.add("is-good");
}

function openDetails(id) {
  const item = store.get(id);
  if (!item) return;
  detailsId = id;
  $("details-for").innerHTML = "<strong>" + esc(item.name) + "</strong>";
  Object.entries(DETAIL_FIELDS).forEach(([field, key]) => { $(field).value = item[key] || ""; });
  const status = item.status === "visited" ? "visited" : "wishlist";
  document.querySelector('input[name="d-status"][value="' + status + '"]').checked = true;
  $("d-note-field").hidden = status === "visited";
  state.detailsPrice = item.price || 0;
  buildShekels("d-price", "detailsPrice");
  state.detailsBranches = branchesOf(item).slice();
  $("d-chain").checked = !!item.chain;
  showChainHelp();
  $("d-error").hidden = true;
  showHoursPreview();
  detailsSnapshot = detailsValues();

  openLayer("details-modal", closeDetails, () =>
    detailsValues() === detailsSnapshot || window.confirm("Leave without saving your changes?"));
  setTimeout(() => $("d-name").focus(), 60);
}

function closeDetails() {
  closeLayer("details-modal");
  detailsId = null;
}

$("remove-details").addEventListener("click", () => {
  const id = detailsId;
  if (!id) return;
  removeItem(id);
  if (!store.get(id)) closeDetails();
});

function detailsError(message, focusId) {
  $("d-error").textContent = message;
  $("d-error").hidden = false;
  $(focusId).focus();
}

function saveDetails() {
  const item = detailsId && store.get(detailsId);
  if (!item) {
    closeDetails();
    return;
  }
  const name = $("d-name").value.trim();
  if (!name) {
    detailsError("A restaurant needs a name.", "d-name");
    return;
  }
  let website = $("d-website").value.trim();
  if (website && !/^https?:\/\//i.test(website)) website = "https://" + website;
  if (website && !safeUrl(website)) {
    detailsError("That website address doesn't look right.", "d-website");
    return;
  }

  let source = $("d-source").value.trim();
  if (source && !/^https?:\/\//i.test(source)) source = "https://" + source;
  if (source && !safeUrl(source)) {
    detailsError("That link doesn't look right.", "d-source");
    return;
  }

  const chain = $("d-chain").checked && state.detailsBranches.length > 0;
  const status = detailsStatus();
  const changes = {
    chain,
    branches: chain ? state.detailsBranches : undefined,
    branches_at: chain ? (item.branches_at || nowIso()) : undefined,
    source_url: source,
    name,
    local_name: $("d-local").value.trim(),
    address: $("d-address").value.trim(),
    city: $("d-city").value.trim(),
    cuisine: $("d-cuisine").value.trim(),
    opening_hours: $("d-hours").value.trim(),
    phone: $("d-phone").value.trim(),
    website,
    wish_note: $("d-note").value.trim(),
    price: state.detailsPrice,
    status,
  };
  if (status === "visited" && !item.visited_at) changes.visited_at = nowIso();
  // A saved menu belongs to the website it was found on.
  if (item.menu && (item.website || "") !== website) changes.menu = undefined;

  updateItem(item.id, changes);
  closeDetails();
  if (item.status !== status) {
    state.tab = status;
    syncTabs();
    toast(name + (status === "visited" ? " moved to your visits." : " moved to your wishlist."));
    return;
  }
  render();
  toast("Saved.");
}

/* ---------- a chain's branches ---------- */

function openBranches(id) {
  const item = store.get(id);
  if (!item) return;
  const now = new Date();
  const list = branchesOf(item).map((branch) => ({
    branch,
    km: state.origin ? haversineKm(state.origin, {
      lat: parseFloat(branch.lat), lon: parseFloat(branch.lon),
    }) : null,
  }));
  if (state.origin) list.sort((a, b) => a.km - b.km);

  $("branches-title").textContent = item.name;
  $("branches-body").innerHTML = "<p class=\"hint\">" + list.length + " branch" +
    (list.length === 1 ? "" : "es") + (item.branches_at
      ? ", found " + esc(new Date(item.branches_at).toLocaleDateString()) : "") + ".</p>" +
    '<ul class="branch-list">' + list.map(({ branch, km }) => {
      const open = openNow(parseOpeningHours(branch.opening_hours), now);
      const bits = [];
      if (km !== null) bits.push(esc(formatDistance(km)));
      if (open !== null) bits.push(open ? "open now" : "closed now");
      if (branch.phone) bits.push(esc(branch.phone));
      return "<li><span><strong>" + esc(branch.address || branch.city || item.name) + "</strong>" +
        (bits.length ? '<span class="branch-meta">' + bits.join(" · ") + "</span>" : "") + "</span>" +
        '<a class="btn-icon" href="https://www.google.com/maps/search/?api=1&query=' +
        encodeURIComponent(branch.lat + "," + branch.lon) + '" target="_blank" ' +
        'rel="noopener noreferrer" title="Show on the map" aria-label="Show this branch on the map">' +
        icon("external") + "</a></li>";
    }).join("") + "</ul>";
  openLayer("branches-modal", closeBranches);
}

function closeBranches() {
  closeLayer("branches-modal");
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

// Each device keeps the view it was last left in: the simple list suits a phone,
// cards suit a wide screen.
function setView(view) {
  state.view = view;
  if (view !== "map") writeSetting("view", view);
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
  if (state.view !== "map" || ids !== lastVisibleIds) render();
  lastVisibleIds = ids;
}, 60000);
$("save-place").addEventListener("click", savePlace);
$("branch-check").addEventListener("change", showBranchChoice);

$("place-search").addEventListener("input", (event) => {
  const query = event.target.value.trim();
  const copyId = shareLinkId(query);
  if (copyId && /^https?:\/\//i.test(query)) {
    event.target.value = "";
    closeAdd();
    openImport(copyId);
    return;
  }
  showRecommend();
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
  } else if (button.id === "send-copy-open") {
    closeShare();
    openSend(null);
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

$("suggest-btn").addEventListener("click", () => recommend());
// Both are forms only to keep the browser's address saving out of them; Enter
// is handled by the fields themselves.
["search-form", "recommend"].forEach((id) => {
  $(id).addEventListener("submit", (event) => event.preventDefault());
});
$("suggest-type").addEventListener("change", (event) => {
  state.suggest.type = event.target.value;
  saveSuggestFilters();
  suggestionBox("");
  showSuggestLabel();
});
$("radius-seg").addEventListener("click", (event) => {
  const option = event.target.closest("[data-radius]");
  if (!option) return;
  state.suggest.radius = Number(option.dataset.radius);
  saveSuggestFilters();
  suggestionBox("");
  showSuggestArea();
});
$("where-seg").addEventListener("click", (event) => {
  const option = event.target.closest("[data-where]");
  if (option && option.dataset.where !== state.suggest.where) setSuggestWhere(option.dataset.where);
});
// Arrow keys move along a switch, as they do in any radio group.
["where-seg", "radius-seg"].forEach((id) => {
  $(id).addEventListener("keydown", (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const options = [...$(id).querySelectorAll("button")];
    const now = options.findIndex((option) => option.getAttribute("aria-checked") === "true");
    const next = options[(now + step + options.length) % options.length];
    next.click();
    next.focus();
  });
});
$("spot-find").addEventListener("click", () => findSpot());
$("spot-query").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  findSpot();
});

async function findSpot() {
  const query = $("spot-query").value.trim();
  if (!query) {
    $("spot-query").focus();
    return;
  }
  const button = $("spot-find");
  button.disabled = true;
  $("spot-label").textContent = "Looking that address up…";
  try {
    const found = await geocode(query, state.searchCountry || "");
    setSuggestPoint(found.lat, found.lon, found.label);
    ensureSpotMap();
  } catch (err) {
    $("spot-label").textContent = err.message;
  } finally {
    button.disabled = false;
  }
}
$("suggestion").addEventListener("click", (event) => {
  const button = event.target.closest("[data-suggest]");
  if (!button) return;
  if (button.dataset.suggest === "next") {
    recommend();
    return;
  }
  const place = state.suggested;
  if (place) showConfirm(place);
});

$("share-source").addEventListener("click", (event) => {
  const pick = event.target.closest("[data-search]");
  if (!pick) return;
  $("share-source").querySelectorAll("[data-search]").forEach((chip) => {
    chip.classList.toggle("is-on", chip === pick);
  });
  searchFor(pick.dataset.search);
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

/* editing the details */
$("close-details").addEventListener("click", closeDetails);
$("cancel-details").addEventListener("click", closeDetails);
$("details-form").addEventListener("submit", (event) => {
  event.preventDefault();
  saveDetails();
});
$("d-hours").addEventListener("input", showHoursPreview);
$("close-branches").addEventListener("click", closeBranches);
$("d-find-branches").addEventListener("click", async () => {
  const item = detailsId && store.get(detailsId);
  if (!item) return;
  const button = $("d-find-branches");
  const original = button.innerHTML;
  button.disabled = true;
  button.textContent = "Looking…";
  try {
    const found = await findBranchesFor($("d-name").value.trim() || item.name, item);
    state.detailsBranches = found;
    if (found.length > 1) $("d-chain").checked = true;
    applyGoogleStatus();
    showChainHelp();
    if (!found.length) toast("No other branches found under that name.");
  } catch (err) {
    toast("Couldn't look for branches: " + err.message);
  } finally {
    button.innerHTML = original;
    button.disabled = false;
  }
});
document.querySelectorAll('input[name="d-status"]').forEach((radio) => {
  radio.addEventListener("change", () => { $("d-note-field").hidden = detailsStatus() === "visited"; });
});

function cardAction(action, id, trigger) {
  if (action === "add") openAdd();
  else if (action === "visit" || action === "edit") openReview(id);
  else if (action === "delete") removeItem(id);
  else if (action === "menu") openMenu(id);
  else if (action === "details") openDetails(id);
  else if (action === "send") openSend([id]);
  else if (action === "more") toggleCard(id);
  else if (action === "actions") toggleCardMenu(id, trigger);
}

$("list").addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-act]");
  if (!trigger) return;
  const action = trigger.dataset.act;
  if (["add", "visit", "edit", "delete", "menu", "details", "send", "more", "actions"].includes(action)) {
    cardAction(action, trigger.dataset.id, trigger);
  } else if (action === "favorite") toggleFavorite(trigger.dataset.id);
  else if (action === "photo") openLightbox(trigger.dataset.id, Number(trigger.dataset.index));
  else if (action === "branches") openBranches(trigger.dataset.id);
  else if (action === "merge") mergeChain(trigger.dataset.id);
  else if (action === "apart") keepApart(trigger.dataset.id);
  else if (action === "expand") toggleRow(trigger.dataset.id);
});

/* ---------- a card's "more" menu ----------
   One menu element, placed beside the button that opened it and growing out
   of that corner. Arrow keys move through it; Escape, a tap elsewhere or a
   scroll put it away. */

let cardMenu = null; // { id, trigger }

function menuItem(action, id, iconName, label, extra) {
  return '<button type="button" role="menuitem" class="pop-item' + (extra ? " " + extra : "") +
    '" data-act="' + action + '" data-id="' + esc(id) + '" tabindex="-1">' + icon(iconName) +
    "<span>" + esc(label) + "</span></button>";
}

function toggleCardMenu(id, trigger) {
  if (cardMenu && cardMenu.id === id) {
    closeCardMenu(true);
    return;
  }
  openCardMenu(id, trigger);
}

function openCardMenu(id, trigger) {
  const item = store.get(id);
  if (!item) return;
  closeCardMenu(false, true);
  const menu = $("card-menu");
  const maps = mapsLink(item);
  const menuLabel = item.menu && item.menu.url ? "See the menu" : item.website ? "Find the menu" : "Add a menu link";
  menu.innerHTML =
    menuItem("send", id, "send", "Send to a friend") +
    menuItem("details", id, "edit", "Edit details") +
    menuItem("menu", id, "book", menuLabel) +
    (maps ? '<a role="menuitem" class="pop-item" tabindex="-1" href="' + esc(maps.url) +
      '" target="_blank" rel="noopener noreferrer">' + icon("external") + "<span>Open in " +
      esc(maps.where) + "</span></a>" : "") +
    '<div class="pop-sep" role="separator"></div>' +
    menuItem("delete", id, "trash", "Remove…", "is-danger");
  menu.setAttribute("aria-label", "More for " + item.name);
  menu.classList.remove("is-closing");
  menu.hidden = false;

  const box = trigger.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const below = box.bottom + 6 + height <= window.innerHeight - 8;
  menu.style.top = (below ? box.bottom + 6 : Math.max(8, box.top - 6 - height)) + "px";
  menu.style.left = Math.min(Math.max(8, box.right - width), window.innerWidth - width - 8) + "px";
  menu.style.transformOrigin = (below ? "top" : "bottom") + " right";

  trigger.setAttribute("aria-expanded", "true");
  cardMenu = { id, trigger };
  const first = menu.querySelector(".pop-item");
  if (first) first.focus({ preventScroll: true });
}

function closeCardMenu(returnFocus, instantly) {
  if (!cardMenu) return;
  const { trigger } = cardMenu;
  cardMenu = null;
  if (trigger.isConnected) {
    trigger.setAttribute("aria-expanded", "false");
    if (returnFocus) trigger.focus({ preventScroll: true });
  }
  const menu = $("card-menu");
  if (instantly || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    menu.hidden = true;
    return;
  }
  menu.classList.add("is-closing");
  setTimeout(() => {
    if (!cardMenu) {
      menu.hidden = true;
      menu.classList.remove("is-closing");
    }
  }, 130);
}

$("card-menu").addEventListener("click", (event) => {
  const link = event.target.closest("a.pop-item");
  const trigger = event.target.closest("button[data-act]");
  if (!link && !trigger) return;
  closeCardMenu(false);
  if (trigger) cardAction(trigger.dataset.act, trigger.dataset.id, trigger);
});
$("card-menu").addEventListener("keydown", (event) => {
  const items = [...$("card-menu").querySelectorAll(".pop-item")];
  const now = items.indexOf(document.activeElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(now + step + items.length) % items.length].focus();
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    items[event.key === "Home" ? 0 : items.length - 1].focus();
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeCardMenu(true);
  } else if (event.key === "Tab") {
    closeCardMenu(false);
  }
});
document.addEventListener("pointerdown", (event) => {
  if (!cardMenu) return;
  if (event.target.closest("#card-menu") || event.target.closest(".more-btn") === cardMenu.trigger) return;
  closeCardMenu(false);
}, true);
window.addEventListener("scroll", () => closeCardMenu(false), { passive: true });
window.addEventListener("resize", () => closeCardMenu(false));

/* joining straight from the empty first screen */
$("list").addEventListener("submit", async (event) => {
  if (event.target.id !== "welcome-join") return;
  event.preventDefault();
  const input = $("welcome-code");
  const code = input.value.trim();
  if (code.length < 4) {
    input.focus();
    return;
  }
  const button = event.target.querySelector("button");
  button.disabled = true;
  button.innerHTML = spinnerMarkup() + "Joining…";
  try {
    await joinDiary(code, { googleKey: readSetting("google-key", "") });
    applyGoogleStatus();
    render(true);
    toast("You're in. The shared diary is on this device now.");
  } catch (err) {
    button.disabled = false;
    button.textContent = "Join";
    $("welcome-error").textContent = err.message;
    $("welcome-error").hidden = false;
  }
});
$("list").addEventListener("input", (event) => {
  if (event.target.id === "welcome-code") {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  }
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
  const key = (r) => JSON.stringify([String(r.name || "").toLowerCase(), String(r.address || "").toLowerCase()]);
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
buildKindOptions();
showSuggestArea();
applyGoogleStatus();
renderShareButton();
setView(state.view);
render(true);
startCloud().catch((err) => console.warn("Sharing unavailable:", err));

const copyInAddress = shareLinkId(location.search);
if (copyInAddress) {
  history.replaceState({}, "", location.pathname);
  openImport(copyInAddress);
} else {
  const sharedLink = sharedFromAddress();
  if (sharedLink && shareLinkId(sharedLink)) openImport(shareLinkId(sharedLink));
  else if (sharedLink) startFromShare(sharedLink);
}

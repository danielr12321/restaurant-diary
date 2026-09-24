/* The free restaurant search, used without a Google key or once Google's monthly
   limit is reached.

   Nominatim's index misses a lot of Israel ("OCD Restaurant", "Pastell" and
   "HaSalon" exist in OpenStreetMap but can't be found through its search), so
   every eating place OpenStreetMap knows in Israel ships with the site
   (data/il-places.json, built by scripts/build_places.py) and is searched right
   here. Nominatim adds worldwide results behind it. */

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const HOME_COUNTRY = "il";

// OSM place types that are somewhere you eat or drink.
const FOOD_TYPES = new Set(["restaurant", "cafe", "fast_food", "bar", "pub", "biergarten",
  "food_court", "ice_cream", "bakery", "deli", "bistro"]);

let places = null;
let loading = null;

/** The Israeli index, fetched the first time it's needed. */
function loadIndex() {
  if (places) return Promise.resolve(places);
  if (!loading) {
    loading = fetch("data/il-places.json")
      .then((response) => {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then((data) => {
        const fields = data.fields;
        places = data.rows.map((row) => {
          const place = {};
          fields.forEach((field, i) => { place[field] = row[i] === undefined ? "" : row[i]; });
          place.country = "Israel";
          place.country_code = HOME_COUNTRY;
          place.full_address = place.address || place.name;
          place.is_food = true;
          return place;
        });
        return places;
      })
      .catch((err) => {
        loading = null;
        throw err;
      });
  }
  return loading;
}

/* ---------- chains ---------- */

// Words that differ between two branches of the same chain, or between the two
// ways a place writes its own name ("Landwer" and "Cafe Landwer").
const GENERIC_WORDS = /\b(restaurant|ristorante|cafe|caffe|coffee|bar|bistro|pizza|the|and)\b/g;
const GENERIC_HEBREW = /(^|\s)(מסעדת|מסעדה|קפה|בית קפה|פיצה)(?=\s|$)/g;

/** The name two branches of one chain share, or "" if there isn't one. */
export function chainKey(name) {
  const base = String(name || "").toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[֑-ׇ]/g, "")
    .replace(/['"״׳`’.,!?&()\-–—_/:]+/g, " ");
  const stripped = base.replace(GENERIC_WORDS, " ").replace(GENERIC_HEBREW, " ");
  return stripped.replace(/\s+/g, " ").trim() || base.replace(/\s+/g, " ").trim();
}

function branchOf(place) {
  return {
    name: place.name,
    address: place.address || "",
    city: place.city || "",
    lat: place.lat,
    lon: place.lon,
    opening_hours: place.opening_hours || "",
    phone: place.phone || "",
    osm_id: place.osm_id,
    osm_type: place.osm_type,
  };
}

/**
 * Every place in Israel that goes by this name — the branches of a chain.
 * Free and instant: it reads the list of Israeli places that ships with the
 * site, so no request leaves the device.
 */
export async function findBranches(name, country) {
  if (country && country !== HOME_COUNTRY) return [];
  const wanted = chainKey(name);
  if (wanted.length < 3) return [];
  let all;
  try {
    all = await loadIndex();
  } catch (err) {
    return [];
  }
  const found = [];
  const seen = new Set();
  all.forEach((place) => {
    const matches = [place.name, place.local_name, place.name_he]
      .filter(Boolean).some((one) => chainKey(one) === wanted);
    if (!matches) return;
    const key = osmKey(place);
    if (seen.has(key)) return;
    seen.add(key);
    found.push(branchOf(place));
  });
  return mergeNeighbours(found);
}

/**
 * One café mapped twice is still one branch: entries within about 60 m of each
 * other are merged, keeping whichever knows the most about the place.
 */
function mergeNeighbours(branches) {
  const kept = [];
  const known = (branch) => (branch.address ? 2 : 0) + (branch.city ? 1 : 0) +
    (branch.opening_hours ? 2 : 0) + (branch.phone ? 1 : 0);
  branches.forEach((branch) => {
    const lat = parseFloat(branch.lat);
    const lon = parseFloat(branch.lon);
    if (!isFinite(lat) || !isFinite(lon)) return;
    const near = kept.find((other) => {
      const dLat = (parseFloat(other.lat) - lat) * 111.3;
      const dLon = (parseFloat(other.lon) - lon) * 111.3 * Math.cos(lat * Math.PI / 180);
      return Math.sqrt(dLat * dLat + dLon * dLon) < 0.06;
    });
    if (!near) {
      kept.push(branch);
      return;
    }
    if (known(branch) > known(near)) kept[kept.indexOf(near)] = branch;
  });
  return kept;
}

/* ---------- matching ---------- */

/**
 * Rank matches from exact name down to a single strong word.
 * The loose tail matters for transliterations: someone types "Tzfon Abraxas" but
 * OSM calls it "North Abraxas", so one distinctive word is enough to surface it.
 */
function searchIndex(all, query, limit) {
  const term = (query || "").trim().toLowerCase();
  if (term.length < 2) return [];
  const words = term.split(/\s+/).filter((w) => w.length >= 2);
  const scored = [];

  all.forEach((place) => {
    const name = (place.name || "").toLowerCase();
    const local = (place.local_name || "").toLowerCase();
    const hebrew = (place.name_he || "").toLowerCase();
    const city = (place.city || "").toLowerCase();
    const names = [name, local, hebrew].filter(Boolean).join(" ");
    if (!names) return;

    let score;
    if (term === name || term === local || term === hebrew) {
      score = 0;
    } else if (name.startsWith(term) || local.startsWith(term) || hebrew.startsWith(term)) {
      score = 1;
    } else if (names.includes(term)) {
      score = 2;
    } else {
      const nameHits = words.filter((w) => names.includes(w)).length;
      if (!nameHits) return;
      const cityHits = words.filter((w) => city.includes(w)).length;
      const covered = nameHits + cityHits >= words.length;
      // People type the restaurant first and the city after, so a match on the
      // leading word beats one that only echoes the city.
      const leads = names.includes(words[0]);
      if (leads && covered) score = 3;
      else if (leads) score = 4;
      else if (covered) score = 5;
      else if (words.some((w) => w.length >= 4 && names.includes(w))) score = 6;
      else return;
    }
    scored.push([score, name.length, place]);
  });

  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let matches = scored.map((row) => row[2]);
  // Nothing matched the restaurant name itself (only e.g. "tel aviv"): the name
  // was probably misspelled, so near-miss spellings of it go first.
  if (!scored.length || scored[0][0] > 4) {
    const fuzzy = fuzzySearch(all, words, limit);
    const taken = new Set(fuzzy.map(osmKey));
    matches = fuzzy.concat(matches.filter((p) => !taken.has(osmKey(p))));
  }
  return matches.slice(0, limit);
}

function osmKey(place) {
  return (place.osm_type || "") + "/" + (place.osm_id || "");
}

// Similarity as Python's difflib computes it (Ratcliff/Obershelp), so "chiccetti"
// still finds "Cicchetti" and "machnyuda" finds "Machneyuda".
function matchingChars(a, b) {
  if (!a.length || !b.length) return 0;
  let best = 0;
  let atA = 0;
  let atB = 0;
  const lengths = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = lengths[j];
      if (a[i - 1] === b[j - 1]) {
        lengths[j] = diagonal + 1;
        if (lengths[j] > best) {
          best = lengths[j];
          atA = i - best;
          atB = j - best;
        }
      } else {
        lengths[j] = 0;
      }
      diagonal = above;
    }
  }
  if (!best) return 0;
  return best + matchingChars(a.slice(0, atA), b.slice(0, atB)) +
    matchingChars(a.slice(atA + best), b.slice(atB + best));
}

function similarity(a, b) {
  return (2 * matchingChars(a, b)) / (a.length + b.length);
}

let wordIndex = null;

function fuzzySearch(all, words, limit) {
  if (!wordIndex) {
    wordIndex = new Map();
    all.forEach((place) => {
      [place.name, place.local_name].filter(Boolean).join(" ").toLowerCase()
        .split(/[\s\-'’.,&/]+/)
        .forEach((word) => {
          if (word.length < 4) return;
          if (!wordIndex.has(word)) wordIndex.set(word, []);
          wordIndex.get(word).push(place);
        });
    });
  }
  const found = [];
  const seen = new Set();
  words.filter((w) => w.length >= 4).forEach((word) => {
    const close = [];
    wordIndex.forEach((_, candidate) => {
      // Cheap length check first, as difflib does.
      if ((2 * Math.min(word.length, candidate.length)) / (word.length + candidate.length) < 0.78) return;
      const score = similarity(word, candidate);
      if (score >= 0.78) close.push([score, candidate]);
    });
    close.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? 1 : -1));
    close.slice(0, 4).forEach(([, candidate]) => {
      wordIndex.get(candidate).forEach((place) => {
        if (!seen.has(osmKey(place))) {
          seen.add(osmKey(place));
          found.push(place);
        }
      });
    });
  });
  return found.slice(0, limit);
}

/* ---------- Nominatim ---------- */

// OSM's usage policy: at most one request a second.
let lastCall = 0;

function formatAddress(addr) {
  const street = [addr.house_number, addr.road].filter(Boolean).join(" ");
  const locality = addr.city || addr.town || addr.village || addr.municipality || addr.suburb;
  return [...new Set([street, addr.neighbourhood, locality].filter(Boolean))].join(", ");
}

function normalizePlace(item) {
  const tags = item.extratags || {};
  const names = item.namedetails || {};
  const addr = item.address || {};
  const display = item.display_name || "";
  // OSM stores the local-language name in "name" (Hebrew, Japanese, ...), so
  // prefer an explicit English name and keep the local one as a subtitle.
  const localName = names.name || "";
  const name = names["name:en"] || names.int_name || localName || item.name || display.split(",")[0].trim();
  const type = item.type || "";
  return {
    name,
    local_name: localName && localName !== name ? localName : "",
    address: formatAddress(addr) || display.split(",")[0].trim(),
    full_address: display,
    city: addr.city || addr.town || addr.village || addr.municipality || "",
    country: addr.country || "",
    country_code: (addr.country_code || "").toLowerCase(),
    lat: item.lat,
    lon: item.lon,
    cuisine: tags.cuisine || "",
    opening_hours: tags.opening_hours || "",
    phone: tags.phone || tags["contact:phone"] || "",
    website: tags.website || tags["contact:website"] || "",
    place_type: type,
    osm_id: item.osm_id,
    osm_type: item.osm_type,
    is_food: FOOD_TYPES.has(type),
  };
}

async function nominatim(query, country) {
  const wait = lastCall + 1100 - Date.now();
  lastCall = Date.now() + Math.max(0, wait);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  const params = new URLSearchParams({
    q: query, format: "jsonv2", addressdetails: "1", extratags: "1", namedetails: "1",
    limit: "12", "accept-language": "en",
  });
  if (country) params.set("countrycodes", country);
  const response = await fetch(NOMINATIM_URL + "?" + params, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error("OpenStreetMap answered with an error (" + response.status + ").");
  return (await response.json()).map(normalizePlace);
}

/**
 * Map whatever OSM recorded onto a 1-5 scale, or 0 when it says nothing. There's
 * no standard price field in OSM, so coverage is thin and the values mixed.
 */
function priceFromTag(raw) {
  if (!raw) return 0;
  const text = String(raw).trim().toLowerCase();
  const symbols = (text.match(/[$₪€]/g) || []).length;
  if (symbols) return Math.max(1, Math.min(5, symbols));
  const words = [["very expensive", 5], ["cheap", 1], ["budget", 1], ["inexpensive", 1], ["low", 1],
    ["moderate", 3], ["medium", 3], ["mid", 3], ["average", 3], ["expensive", 4], ["high", 4],
    ["pricey", 4], ["luxury", 5], ["fine_dining", 5]];
  for (const [word, value] of words) {
    if (text.includes(word)) return value;
  }
  const digits = text.match(/\d+/);
  return digits ? Math.max(1, Math.min(5, Number(digits[0]))) : 0;
}

/* ---------- search ---------- */

const cache = new Map();

/** The Israeli index first, then Nominatim for everywhere else; only places to eat. */
export async function searchFreePlaces(query, country) {
  const key = country + "|" + query.trim().toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < 300000) return cached.places;

  let local = [];
  if (!country || country === HOME_COUNTRY) {
    try {
      local = searchIndex(await loadIndex(), query, 12);
    } catch (err) {
      local = []; // offline or not deployed: Nominatim alone still answers
    }
  }

  let remote = [];
  try {
    remote = await nominatim(query, country);
  } catch (err) {
    if (!local.length) throw new Error("Could not reach OpenStreetMap. Check your internet connection.");
  }

  const seen = new Set(local.map(osmKey));
  const found = local.concat(remote.filter((place) => !seen.has(osmKey(place))))
    // Streets, shops and towns that happen to share the name are dropped, then
    // the home country goes first, keeping relevance order within each group.
    .filter((place) => place.is_food)
    .map((place) => ({ ...place, price: priceFromTag(place.price_raw) }));
  found.sort((a, b) => (a.country_code === HOME_COUNTRY ? 0 : 1) - (b.country_code === HOME_COUNTRY ? 0 : 1));

  cache.set(key, { at: Date.now(), places: found });
  return found;
}

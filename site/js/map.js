/* The map view: a Google map with a key (Google's terms don't allow its place
   data on another map), otherwise Leaflet + OpenStreetMap.

   The map is made once per visit and then only updated. Pins are added, moved
   or removed as the list changes, and the view is re-fitted only when the set of
   places shown changes (a filter, the tab, Near me), never because the page
   redrew for some other reason: a favourite, a sync from the other phone, the
   once-a-minute refresh. Each Google map load is counted against the monthly
   limit; once it's reached the map pauses rather than calling Google. */

import { reserve, refund, LimitReached } from "./google.js";

const HOME = { lat: 32.08, lng: 34.78 };
const LEAFLET = "https://unpkg.com/leaflet@1.9.4/dist/";

export function createMapView({ canvas, message, popupHtml }) {
  const view = {
    engine: null, // null | "google" | "leaflet" | "paused" | "error"
    note: "",
    starting: null,
    keyInUse: "",
    gmap: null,
    info: null,
    leaflet: null,
    markers: new Map(), // restaurant id -> { item, sig, marker }
    extras: [],
    extrasKey: "",
    fitKey: "",
    last: null,
  };
  let scriptPromise = null;
  let leafletPromise = null;

  function showMessage(text) {
    canvas.hidden = true;
    message.hidden = false;
    message.textContent = text;
  }

  function showCanvas() {
    message.hidden = true;
    canvas.hidden = false;
  }

  /* ---------- loading ---------- */

  // Loading the script is free; only creating the map is billed. So it can start
  // as soon as someone reaches for the Map button, which makes the map appear sooner.
  function loadGoogleScript(key) {
    if (window.google && google.maps && google.maps.importLibrary) return Promise.resolve();
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise((resolve, reject) => {
      window.__diaryMapsReady = resolve;
      const script = document.createElement("script");
      script.src = "https://maps.googleapis.com/maps/api/js?" + new URLSearchParams({
        key, v: "weekly", loading: "async", callback: "__diaryMapsReady", language: "en", region: "IL",
      });
      script.async = true;
      script.onerror = () => {
        scriptPromise = null;
        script.remove();
        reject(new Error("Google Maps couldn't load. Check your internet connection, then try again."));
      };
      document.head.appendChild(script);
    });
    return scriptPromise;
  }

  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = LEAFLET + "leaflet.css";
      document.head.appendChild(css);
      const script = document.createElement("script");
      script.src = LEAFLET + "leaflet.js";
      script.onload = resolve;
      script.onerror = () => {
        leafletPromise = null;
        script.remove();
        reject(new Error("The map couldn't load. Check your internet connection, then try again."));
      };
      document.head.appendChild(script);
    });
    return leafletPromise;
  }

  // Google calls this when it rejects the key.
  window.gm_authFailure = () => {
    view.engine = "error";
    view.note = "Google rejected the map key. Check it in Settings (and that \"Maps JavaScript API\" is " +
      "turned on and allows this website), then reload the page.";
    if (view.last) showMessage(view.note);
  };

  function startGoogle(key) {
    showMessage("Loading Google map…");
    if (view.starting) return;
    view.starting = (async () => {
      // The script and the monthly check run side by side.
      const [loaded, counted] = await Promise.allSettled([
        loadGoogleScript(key).then(() => Promise.all([
          google.maps.importLibrary("maps"), google.maps.importLibrary("marker"),
        ])),
        reserve("map_load"),
      ]);
      if (counted.status === "rejected") {
        // At the limit the map stays paused; anything else (no connection) is worth another try.
        view.engine = counted.reason instanceof LimitReached ? "paused" : null;
        view.note = counted.reason.message + " The list view still works.";
        showMessage(view.note);
        return;
      }
      if (loaded.status === "rejected") {
        refund("map_load").catch(() => {});
        view.engine = null; // worth another try once the connection is back
        view.note = loaded.reason.message;
        showMessage(view.note);
        return;
      }
      showCanvas();
      view.gmap = new google.maps.Map(canvas, {
        center: HOME, zoom: 11, mapId: "DEMO_MAP_ID", clickableIcons: false,
        streetViewControl: false, mapTypeControl: false, fullscreenControl: false,
        // The map fills the screen on phones, so one finger pans it.
        gestureHandling: "greedy",
      });
      view.info = new google.maps.InfoWindow();
      view.keyInUse = key;
      if (view.engine !== "error") view.engine = "google";
    })().catch((err) => {
      view.engine = "error";
      view.note = err.message;
    }).finally(() => {
      view.starting = null;
      if (view.engine && view.last) show(view.last.items, view.last.ctx);
    });
  }

  function startLeaflet() {
    showMessage("Loading map…");
    if (view.starting) return;
    view.starting = loadLeaflet().then(() => {
      showCanvas();
      view.leaflet = window.L.map(canvas, { scrollWheelZoom: true });
      window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors", maxZoom: 19,
      }).addTo(view.leaflet);
      view.engine = "leaflet";
    }).catch((err) => {
      view.note = err.message;
      showMessage(err.message);
    }).finally(() => {
      view.starting = null;
      if (view.engine && view.last) show(view.last.items, view.last.ctx);
    });
  }

  /* ---------- pins ---------- */

  function signature(item, lat, lng) {
    return lat + "," + lng + "|" + (item.name || "") + "|" + (item.favorite ? 1 : 0);
  }

  function googlePin(item) {
    if (!item.favorite) return undefined;
    const pin = new google.maps.marker.PinElement({
      background: "#F59E0B", borderColor: "#B45309", glyphColor: "#FFFFFF",
    });
    return pin.element || pin;
  }

  function leafletIcon(item) {
    return window.L.divIcon({
      className: "map-pin" + (item.favorite ? " is-favorite" : ""),
      html: "<span></span>", iconSize: [26, 34], iconAnchor: [13, 32], popupAnchor: [0, -28],
    });
  }

  function addMarker(entry, lat, lng) {
    if (view.engine === "google") {
      const marker = new google.maps.marker.AdvancedMarkerElement({
        map: view.gmap, position: { lat, lng }, title: entry.item.name, content: googlePin(entry.item),
      });
      marker.addListener("click", () => {
        view.info.setContent(popupHtml(entry.item));
        view.info.open({ anchor: marker, map: view.gmap });
      });
      entry.marker = marker;
    } else {
      entry.marker = window.L.marker([lat, lng], { icon: leafletIcon(entry.item), title: entry.item.name })
        .addTo(view.leaflet)
        .bindPopup(() => popupHtml(entry.item));
    }
  }

  function removeOverlay(overlay) {
    if (view.engine === "google") {
      if (overlay.setMap) overlay.setMap(null);
      else overlay.map = null;
    } else {
      overlay.remove();
    }
  }

  function syncMarkers(items) {
    const seen = new Set();
    const points = [];
    items.forEach((item) => {
      const lat = parseFloat(item.lat);
      const lng = parseFloat(item.lon);
      if (!isFinite(lat) || !isFinite(lng)) return;
      seen.add(item.id);
      points.push({ lat, lng });
      const sig = signature(item, lat, lng);
      const existing = view.markers.get(item.id);
      if (existing) {
        existing.item = item; // popups always show the latest notes
        if (existing.sig === sig) return;
        removeOverlay(existing.marker);
      }
      const entry = existing || { item, sig, marker: null };
      entry.sig = sig;
      addMarker(entry, lat, lng);
      view.markers.set(item.id, entry);
    });
    view.markers.forEach((entry, id) => {
      if (!seen.has(id)) {
        removeOverlay(entry.marker);
        view.markers.delete(id);
      }
    });
    return { ids: seen, points };
  }

  function syncExtras(ctx) {
    const origin = ctx.origin;
    const key = origin ? origin.lat.toFixed(5) + "," + origin.lon.toFixed(5) + "|" + ctx.radius : "";
    if (key === view.extrasKey) return;
    view.extrasKey = key;
    view.extras.forEach(removeOverlay);
    view.extras = [];
    if (!origin) return;
    const here = { lat: origin.lat, lng: origin.lon };
    if (view.engine === "google") {
      if (ctx.radius > 0) {
        view.extras.push(new google.maps.Circle({
          map: view.gmap, center: here, radius: ctx.radius * 1000, clickable: false,
          strokeColor: "#A16207", strokeWeight: 1.5, fillColor: "#A16207", fillOpacity: 0.06,
        }));
      }
      const dot = document.createElement("div");
      dot.className = "you-dot";
      view.extras.push(new google.maps.marker.AdvancedMarkerElement({
        map: view.gmap, position: here, content: dot, title: "You are here", zIndex: 1000,
      }));
    } else {
      if (ctx.radius > 0) {
        view.extras.push(window.L.circle([here.lat, here.lng], {
          radius: ctx.radius * 1000, color: "#A16207", weight: 1.5,
          fillColor: "#A16207", fillOpacity: 0.06, interactive: false,
        }).addTo(view.leaflet));
      }
      view.extras.push(window.L.circleMarker([here.lat, here.lng], {
        radius: 8, color: "#FFFFFF", weight: 3, fillColor: "#DC2626", fillOpacity: 1,
      }).addTo(view.leaflet).bindTooltip("You are here", { direction: "top", offset: [0, -8] }));
    }
  }

  function boundsAround(origin, km) {
    const dLat = km / 110.574;
    const dLon = km / (111.32 * Math.cos(origin.lat * Math.PI / 180));
    return { south: origin.lat - dLat, west: origin.lon - dLon, north: origin.lat + dLat, east: origin.lon + dLon };
  }

  function fit(points, ctx) {
    const origin = ctx.origin;
    if (view.engine === "google") {
      const gmap = view.gmap;
      if (origin) {
        // With a location, the view belongs to the person, not to wherever the saved places are.
        if (ctx.radius > 0) gmap.fitBounds(boundsAround(origin, ctx.radius), 16);
        else {
          gmap.setCenter({ lat: origin.lat, lng: origin.lon });
          gmap.setZoom(14);
        }
      } else if (points.length) {
        const bounds = new google.maps.LatLngBounds();
        points.forEach((p) => bounds.extend(p));
        gmap.fitBounds(bounds, 40);
        google.maps.event.addListenerOnce(gmap, "idle", () => {
          if (gmap.getZoom() > 15) gmap.setZoom(15);
        });
      } else {
        gmap.setCenter(HOME);
        gmap.setZoom(11);
      }
      return;
    }
    const map = view.leaflet;
    if (origin) {
      if (ctx.radius > 0) {
        const box = boundsAround(origin, ctx.radius);
        map.fitBounds([[box.south, box.west], [box.north, box.east]], { padding: [16, 16], animate: false });
      } else {
        map.setView([origin.lat, origin.lon], 14, { animate: false });
      }
    } else if (points.length) {
      map.fitBounds(points.map((p) => [p.lat, p.lng]), { padding: [40, 40], maxZoom: 15, animate: false });
    } else {
      map.setView([HOME.lat, HOME.lng], 11, { animate: false });
    }
  }

  function draw(items, ctx) {
    showCanvas();
    // The container may have just been un-hidden; Leaflet has to re-measure it.
    if (view.engine === "leaflet") view.leaflet.invalidateSize({ animate: false });
    const { ids, points } = syncMarkers(items);
    syncExtras(ctx);
    const fitKey = [ctx.scope, [...ids].sort().join(","), view.extrasKey].join("|");
    if (fitKey !== view.fitKey) {
      view.fitKey = fitKey;
      fit(points, ctx);
    }
  }

  /* ---------- public ---------- */

  /** Show `items`; ctx = { key, origin, radius, scope } (scope: which list is shown). */
  function show(items, ctx) {
    view.last = { items, ctx };
    if (view.engine === "google" || view.engine === "leaflet") {
      if (view.engine === "google" && ctx.key !== view.keyInUse) {
        return showMessage(ctx.key
          ? "The Google key changed. Reload the page to use the new one."
          : "Google Maps was disconnected. Reload the page to switch to the free map.");
      }
      return draw(items, ctx);
    }
    if (view.engine === "paused" || view.engine === "error") return showMessage(view.note);
    if (ctx.key) return startGoogle(ctx.key);
    return startLeaflet();
  }

  return {
    show,
    /** Start fetching the map code before the Map button is even pressed. */
    preload(key) {
      if (view.engine) return;
      if (key) loadGoogleScript(key).catch(() => {});
      else loadLeaflet().catch(() => {});
    },
  };
}

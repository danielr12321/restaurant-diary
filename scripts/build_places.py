"""Build site/data/il-places.json: every eating place OpenStreetMap knows in Israel.

Nominatim's search misses a lot of Israel ("OCD Restaurant", "Pastell" and
"HaSalon" exist in OpenStreetMap but can't be found through it), so the whole
set ships with the site and the page searches it directly.

    python scripts/build_places.py              download fresh from Overpass (a few minutes)
    python scripts/build_places.py FILE.json    convert an index saved by the old local app

The output is compact (one array per place) to keep the download small.
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUTPUT = os.path.join(HERE, "..", "site", "data", "il-places.json")

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "RestaurantDiary/1.0 (personal app)"
HOME_BBOX = (29.45, 34.23, 33.34, 35.90)
AMENITIES = "restaurant|cafe|fast_food|bar|pub|ice_cream|bakery|deli|food_court"
QUERY = '[out:json][timeout:180];nwr["amenity"~"^(%s)$"](%s);out center tags;'
# One country-wide request times out on the public server, so the box is fetched as a grid.
GRID_ROWS, GRID_COLS, ATTEMPTS = 6, 3, 4
# OSM has no standard price field; these turn up, checked in order.
PRICE_TAGS = ("price_range", "price:level", "price_level", "cost")

FIELDS = ["name", "local_name", "name_he", "address", "city", "lat", "lon", "cuisine",
          "opening_hours", "phone", "website", "price_raw", "place_type", "osm_id", "osm_type"]


def tiles():
    south, west, north, east = HOME_BBOX
    d_lat, d_lon = (north - south) / GRID_ROWS, (east - west) / GRID_COLS
    for row in range(GRID_ROWS):
        for col in range(GRID_COLS):
            yield "%.4f,%.4f,%.4f,%.4f" % (south + row * d_lat, west + col * d_lon,
                                           south + (row + 1) * d_lat, west + (col + 1) * d_lon)


def download():
    elements = []
    boxes = list(tiles())
    for index, bbox in enumerate(boxes, 1):
        for attempt in range(1, ATTEMPTS + 1):
            try:
                request = urllib.request.Request(
                    OVERPASS_URL, headers={"User-Agent": USER_AGENT},
                    data=urllib.parse.urlencode({"data": QUERY % (AMENITIES, bbox)}).encode())
                with urllib.request.urlopen(request, timeout=240) as response:
                    found = json.loads(response.read().decode("utf-8")).get("elements", [])
                elements.extend(found)
                print("  tile %d/%d: %d places" % (index, len(boxes), len(found)))
                break
            except Exception as exc:  # noqa: BLE001 - the public server 429s/504s; retry
                if attempt == ATTEMPTS:
                    print("  tile %d/%d failed: %s" % (index, len(boxes), exc))
                else:
                    time.sleep(15 * attempt)
        time.sleep(2)
    return [p for p in (normalize(e) for e in elements) if p]


def normalize(element):
    tags = element.get("tags") or {}
    local_name = tags.get("name") or ""
    name = tags.get("name:en") or tags.get("int_name") or local_name
    center = element.get("center") or {}
    lat, lon = element.get("lat", center.get("lat")), element.get("lon", center.get("lon"))
    if not name or lat is None or lon is None:
        return None
    street = " ".join(p for p in (tags.get("addr:housenumber"), tags.get("addr:street")) if p)
    city = tags.get("addr:city") or ""
    return {
        "name": name,
        "local_name": local_name if local_name != name else "",
        "name_he": tags.get("name:he") or "",
        "address": ", ".join(p for p in (street, city) if p),
        "city": city,
        "lat": str(lat), "lon": str(lon),
        "cuisine": tags.get("cuisine") or "",
        "opening_hours": tags.get("opening_hours") or "",
        "phone": tags.get("phone") or tags.get("contact:phone") or "",
        "website": tags.get("website") or tags.get("contact:website") or "",
        "price_raw": next((tags[t] for t in PRICE_TAGS if tags.get(t)), ""),
        "place_type": tags.get("amenity") or "",
        "osm_id": element.get("id"),
        "osm_type": element.get("type"),
    }


def write(places):
    rows = []
    for place in places:
        row = [place.get(field) if place.get(field) is not None else "" for field in FIELDS]
        while row and row[-1] == "":  # trailing blanks cost bytes and mean the same
            row.pop()
        rows.append(row)
    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    with open(OUTPUT, "w", encoding="utf-8") as fh:
        json.dump({"built_at": int(time.time()), "fields": FIELDS, "rows": rows}, fh,
                  ensure_ascii=False, separators=(",", ":"))
    print("wrote %d places, %d KB -> %s" % (len(rows), os.path.getsize(OUTPUT) // 1024,
                                            os.path.normpath(OUTPUT)))


if __name__ == "__main__":
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding="utf-8") as fh:
            write(json.load(fh)["places"])
    else:
        write(download())

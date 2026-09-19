# Restaurant Diary

Places I want to try, and places I've loved: a wishlist and a visited list with
ratings, dishes worth ordering, photos, menus and a map. Add a restaurant by
typing its name; the address, opening hours, price and cuisine are filled in.

It runs in any browser, on a computer or a phone (where it can be added to the
home screen and opens like an app), and two people can share one diary live.

- **Site:** <https://danielr12321.github.io/restaurant-diary/> (GitHub Pages)
- **Shared data:** a free [Supabase](https://supabase.com) project (its own project, `bipvhmspflfxzdvbrogi`)
- **Stack:** plain HTML, CSS and JavaScript modules; no build step

## Sharing with a friend

Nobody signs in. One person taps **Share → Share this diary** and gets a code;
everyone else (a friend, or your own phone) opens the site, taps **Share → Join
with a code** and types it. Changes are saved on the device first, so the diary
works offline, and are sent as soon as there's a connection. Per restaurant, the
newest edit wins.

## One-time setup

### Supabase

1. **SQL Editor → New query**: paste `supabase/schema.sql` and run it. It's safe to run again.
2. **Authentication → Sign In / Providers**: "Allow anonymous sign-ins" must be on.
3. **Edge Functions → Deploy a new function → Via Editor**: name it `find-menu`, replace the sample code with
   `supabase/functions/find-menu/index.ts`, and deploy. This is the menu finder: a web page can't read other
   websites itself.

### Google Maps (optional)

Paste an API key in the diary's **Settings**. While shared, the key is stored in
the diary, so every member's device uses it. In the Google Cloud console:

- APIs: **Maps JavaScript API** and **Places API (New)**
- Application restriction: websites, `https://danielr12321.github.io/restaurant-diary/*`

The diary counts every Google request and stops at 90% of Google's free monthly
allowance, so it can't cost money. While shared, the counts are shared too.
Without a key, or past the limit, search uses OpenStreetMap (with every eating
place in Israel built in, `site/data/il-places.json`) and the map is Leaflet.

### GitHub Pages

The repository's **Settings → Pages → Source** must be **GitHub Actions**.
`.github/workflows/publish.yml` publishes the `site` folder on every push to `main`.

## Everyday

- **Publish changes:** `scripts\publish.bat` (commits and pushes; live in about a minute). Phones pick up the new
  version by themselves the next time the diary opens.
- **Try changes first:** `python scripts/serve.py`, then open <http://localhost:8790>. To test the menu finder
  locally, run `node scripts/dev-menu.mjs` and follow the note at the top of that file.
- **Refresh the Israeli restaurant list:** `python scripts/build_places.py` (downloads from OpenStreetMap).
- **App icons:** `python scripts/make_icons.py`.

## Where things live

- `site/index.html`, `site/styles.css`: the page; phones get a bottom bar and sheets from the bottom
- `site/js/app.js`: everything on screen
- `site/js/store.js`: restaurants and photos kept on the device, and the queue of changes to send
- `site/js/cloud.js`: the shared diary: share, join, sync, live updates, photos, Google usage
- `site/js/google.js`: Google search and details, with the monthly limit
- `site/js/osm.js`: the free search
- `site/js/map.js`: the map, built once per visit and only updated after that
- `site/sw.js`: works offline and installs new versions
- `supabase/schema.sql`: tables, access rules, the Google usage counter, the photo bucket
- `supabase/functions/find-menu/index.ts`: the menu finder
- `scripts/move-diary-online.mjs`: one-time move of the old local diary into a shared diary

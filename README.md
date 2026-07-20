# cta-tracker

Kiosk-style live map + arrival board for CTA "L" trains **and buses**. Pick a
station (or a bus route + stop), see the next arrivals with live countdowns, and
watch the vehicles glide along the map in real time. Built to run cheap on a
small host and display on an old iPad taped to the wall.

Toggle 🚆 / 🚌 in the header switches between train and bus mode; the choice is
remembered.

## Setup

1. Get a free CTA **Train Tracker** key: https://www.transitchicago.com/developers/traintrackerapply/
   and a free CTA **Bus Tracker** key: https://www.transitchicago.com/developers/bustracker/
   (bus mode is optional — trains work without a bus key).
2. Put them in the environment (or a `.env` file in the project root):

   ```
   CTA_API_KEY=your_train_key_here
   CTA_BUS_KEY=your_bus_key_here
   ```

   On Render, add both as environment variables in the dashboard (Settings →
   Environment) — `render.yaml` marks them `sync: false` so they stay out of git.

3. Install and run with [uv](https://docs.astral.sh/uv/):

   ```
   uv sync
   uv run uvicorn main:app --host 0.0.0.0 --port 8000
   ```

Open `http://<host>:8000` and pick your station. The choice is saved in
localStorage, so the iPad reopens to the same station.

## How it works

- `main.py` — FastAPI server. Proxies the CTA Train Tracker arrivals API
  (`lapi.transitchicago.com/api/1.0/ttarrivals.aspx`) so the API key never
  reaches the browser. Responses are cached 25s per station, so even an
  always-on kiosk uses ~2,900 CTA calls/day against the 50,000/day limit.
- `stations.json` — all 144 L stations (map_id, name, lines), generated from
  the [City of Chicago L stops dataset](https://data.cityofchicago.org/Transportation/CTA-System-Information-List-of-L-Stops/8pix-ypme).
- `static/index.html` — single-file UI, ES5 JavaScript + XMLHttpRequest so it
  works on old iPad Safari. No external assets, dark theme, big type.

Countdown minutes come from the CTA prediction itself (`arrT - prdt`), so a
wrong clock on the server or iPad doesn't skew the numbers.

## iPad kiosk tips

- Add to Home Screen in Safari — runs fullscreen (apple-mobile-web-app meta
  tags are set).
- Settings → Display → Auto-Lock → Never, and keep it plugged in.
- Use Guided Access (Settings → Accessibility) to lock it to the page.

## Hosting

Any tiny host works — one process, ~50 MB RAM, no database. It needs to run the
Python server (GitHub Pages can't — it's static-only, and the CTA API blocks
direct browser calls via CORS).

### Deploy to Render (free, auto-deploys from GitHub)

`render.yaml` in the repo is a Render Blueprint, so setup is mostly clicks:

1. Push this repo to GitHub (already wired to `origin`):
   ```
   git add -A && git commit -m "Add Render deploy config" && git push
   ```
2. At [dashboard.render.com](https://dashboard.render.com) → **New → Blueprint**,
   connect the repo. Render reads `render.yaml` and creates the web service.
3. When prompted, paste your `CTA_API_KEY` (it's marked `sync: false`, so it
   lives only in Render, never in git). Click **Apply**.
4. First build takes ~2 min; you get a public `https://cta-tracker-xxx.onrender.com`
   URL. Open it on the iPad, Add to Home Screen, done.

Every `git push` afterward auto-redeploys. The free tier idles a service after
15 min of no traffic (~50 s cold start next visit) — but the kiosk polls every
10 s, so while it's on the wall it never sleeps.

Other hosts (Fly.io, Railway, a Raspberry Pi on the LAN) work the same way: set
`CTA_API_KEY` as a secret/env var and run the uvicorn command above.

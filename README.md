# cta-tracker

Kiosk-style arrival board for CTA "L" trains. Pick a station, see the next
trains with live countdowns. Built to run cheap on a small host and display
on an old iPad taped to the wall.

## Setup

1. Get a free CTA Train Tracker API key: https://www.transitchicago.com/developers/traintrackerapply/
2. Put it in the environment (or a `.env` file in the project root):

   ```
   CTA_API_KEY=your_key_here
   ```

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

Any tiny host works — one process, ~50 MB RAM, no database. E.g. Fly.io,
Railway, or a Raspberry Pi on the LAN. Set `CTA_API_KEY` as a secret and run
the uvicorn command above.

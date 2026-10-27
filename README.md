# cta-tracker

Kiosk-style live map + arrival board for CTA "L" trains **and buses**. Pick a
station (or a bus route + stop), see the next arrivals with live countdowns, and
watch the vehicles glide along the map in real time. Built to run cheap on a
small host and display on an old iPad taped to the wall.

Toggle 🚆 / 🚌 in the header switches between train and bus mode; the choice is
remembered.

## Setup

Live at **https://cta-tracker.cullen77401.workers.dev** (Cloudflare Workers,
free tier). Open it on the iPad and pick your station; the choice is saved in
localStorage, so the iPad reopens to the same station.

1. Get a free CTA **Train Tracker** key: https://www.transitchicago.com/developers/traintrackerapply/
   and a free CTA **Bus Tracker** key: https://www.transitchicago.com/developers/bustracker/
   (bus mode is optional — trains work without a bus key).
2. Store them as Worker secrets (never in git), then deploy. No npm install needed:

   ```
   npx wrangler login
   npx wrangler secret put CTA_API_KEY
   npx wrangler secret put CTA_BUS_KEY
   npx wrangler deploy
   ```

Redeploy after any change with `npx wrangler deploy`.

Local dev: put `CTA_API_KEY=...` / `CTA_BUS_KEY=...` (or `CTA_DEMO=1` for fake
arrivals) in `.dev.vars`, then `npx wrangler dev` and open http://localhost:8787.

## How it works

- `worker/index.js` — Cloudflare Worker. Proxies the CTA Train Tracker and
  Bus Tracker APIs so the keys never reach the browser (the CTA API also blocks
  direct browser calls via CORS). Live responses are cached ~10s per isolate,
  keeping an always-on kiosk well under CTA's 50,000 calls/day.
- `wrangler.jsonc` — serves `static/` as assets and routes `/api/*` to the Worker.
- `stations.json` — all 144 L stations (map_id, name, lines), generated from
  the [City of Chicago L stops dataset](https://data.cityofchicago.org/Transportation/CTA-System-Information-List-of-L-Stops/8pix-ypme).
- `lines.json` / `bus_stops.json` — L track geometry and every bus stop (for
  nearest-stop lookup; BusTime has no all-stops query).
- `static/index.html` — single-file UI, ES5 JavaScript + XMLHttpRequest so it
  works on old iPad Safari. The map is one `<canvas>`: tracks and stations are
  cached in an offscreen bitmap, and only trains are redrawn each frame.

Countdown minutes come from the CTA prediction itself (`arrT - prdt`), so a
wrong clock on the server or iPad doesn't skew the numbers.

## iPad kiosk tips

- Add to Home Screen in Safari — runs fullscreen (apple-mobile-web-app meta
  tags are set).
- Settings → Display → Auto-Lock → Never, and keep it plugged in.
- Use Guided Access (Settings → Accessibility) to lock it to the page.

## Cost

One always-on kiosk makes ~14k Worker requests/day (arrivals every 10s,
positions every 15s), well inside the free tier's 100k/day; static assets don't
count. Workers never cold-start or sleep.

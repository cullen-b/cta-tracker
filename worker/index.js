// CTA train + bus arrival board — Cloudflare Worker backend.
// Proxies the CTA Train Tracker + Bus Tracker APIs so the keys stay server-side; static/ is served as Workers assets.
import STATIONS from "../stations.json";
import LINES from "../lines.json";
import BUS_STOPS_JSON from "../bus_stops.json"; // bundled as raw text (see wrangler.jsonc rules)

const CTA_URL = "https://lapi.transitchicago.com/api/1.0/ttarrivals.aspx";
const CTA_POS_URL = "https://lapi.transitchicago.com/api/1.0/ttpositions.aspx";
const CACHE_TTL_MS = 9000; // kiosk polls every 10s; per-isolate cache keeps CTA calls well under 50k/day
const ROUTE_NAMES = { red: "Red", blue: "Blue", brn: "Brn", g: "G", org: "Org", p: "P", pink: "Pink", y: "Y" };

const STATION_COORDS = new Map(STATIONS.map((s) => [s.map_id, [s.lat, s.lon]]));

// --- track geometry: used to reject trains reported way off their own line ---
const REF_COS = Math.cos((41.88 * Math.PI) / 180); // Chicago latitude
const kmXY = (lat, lon) => [lon * 111.32 * REF_COS, lat * 110.574];

const ROUTE_EDGES = {};
for (const [code, segs] of Object.entries(LINES.routes)) {
  const edges = [];
  for (const seg of segs) {
    const pts = seg.map(([lat, lon]) => kmXY(lat, lon));
    for (let i = 0; i < pts.length - 1; i++) edges.push([pts[i], pts[i + 1]]);
  }
  ROUTE_EDGES[code] = edges;
}

function kmToRoute(route, lat, lon) {
  const edges = ROUTE_EDGES[route];
  if (!edges) return 0;
  const [px, py] = kmXY(lat, lon);
  let best = 1e9;
  for (const [a, b] of edges) {
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const apx = px - a[0], apy = py - a[1];
    const ab2 = abx * abx + aby * aby;
    const t = ab2 === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2));
    const dx = apx - t * abx, dy = apy - t * aby;
    best = Math.min(best, dx * dx + dy * dy);
  }
  return Math.sqrt(best);
}

// station order along each line (for the picker UI): nearest-neighbour chain
// starting from the terminus farthest from the network centroid
function buildLineOrder() {
  const clat = STATIONS.reduce((n, s) => n + s.lat, 0) / STATIONS.length;
  const clon = STATIONS.reduce((n, s) => n + s.lon, 0) / STATIONS.length;
  const d2 = (a, b) => (a.lat - b.lat) ** 2 + (a.lon - b.lon) ** 2;
  const order = {};
  const codes = [...new Set(STATIONS.flatMap((s) => s.lines))].sort();
  for (const code of codes) {
    const sts = STATIONS.filter((s) => s.lines.includes(code));
    const start = sts.reduce((m, s) => (d2(s, { lat: clat, lon: clon }) > d2(m, { lat: clat, lon: clon }) ? s : m));
    const chain = [start];
    const rest = new Map(sts.filter((s) => s.map_id !== start.map_id).map((s) => [s.map_id, s]));
    while (rest.size) {
      const last = chain[chain.length - 1];
      let nxt = null;
      for (const s of rest.values()) if (!nxt || d2(s, last) < d2(nxt, last)) nxt = s;
      chain.push(nxt);
      rest.delete(nxt.map_id);
    }
    order[code] = chain.map((s) => s.map_id);
  }
  return order;
}

const LINE_ORDER = buildLineOrder();

const DEMO_ARRIVALS = [
  { route: "Red", dest: "Howard", platform: "Service toward Howard", dir: "1", run: "801", min: 2, time: "11:17", approaching: true, delayed: false, scheduled: false },
  { route: "Red", dest: "95th/Dan Ryan", platform: "Service toward 95th", dir: "5", run: "923", min: 4, time: "11:19", approaching: false, delayed: false, scheduled: false },
  { route: "Brn", dest: "Kimball", platform: "Service toward Kimball", dir: "1", run: "415", min: 7, time: "11:22", approaching: false, delayed: false, scheduled: false },
  { route: "Red", dest: "Howard", platform: "Service toward Howard", dir: "1", run: "804", min: 11, time: "11:26", approaching: false, delayed: true, scheduled: false },
  { route: "Brn", dest: "Loop", platform: "Service toward Loop", dir: "5", run: "421", min: 15, time: "11:30", approaching: false, delayed: false, scheduled: true },
];
const DEMO_OFFSETS = [[0.004, 0.001], [-0.012, -0.003], [0.021, 0.005], [-0.03, -0.006], [0.042, 0.01]];

class HttpError extends Error {
  constructor(status, detail) { super(detail); this.status = status; }
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function checkCta(payload) {
  const ctatt = payload.ctatt || {};
  if (![undefined, null, "0", 0].includes(ctatt.errCd)) throw new HttpError(502, ctatt.errNm || "CTA API error");
  return ctatt;
}

const asList = (x) => (!x ? [] : Array.isArray(x) ? x : [x]); // CTA emits a bare object when there's only one

// CTA timestamps are Chicago local time; only their difference matters, so parse both as UTC
const parseCtaTime = (s) => (s ? Date.parse(s + "Z") : NaN);

function parseArrivals(payload) {
  const arrivals = [];
  for (const eta of asList(checkCta(payload).eta)) {
    const arr = parseCtaTime(eta.arrT), prd = parseCtaTime(eta.prdt);
    if (Number.isNaN(arr) || Number.isNaN(prd)) continue;
    const at = new Date(arr);
    let lat = eta.lat ? parseFloat(eta.lat) : null;
    let lon = eta.lon ? parseFloat(eta.lon) : null;
    let heading = eta.heading ? parseInt(eta.heading, 10) : null;
    // CTA sometimes reports a position nowhere near the train's own line;
    // drop the bogus coordinates but keep the (still valid) prediction
    if (lat !== null && kmToRoute(eta.rt || "", lat, lon) > 0.8) lat = lon = heading = null;
    arrivals.push({
      route: eta.rt || "",
      dest: eta.destNm || "",
      platform: eta.stpDe || "",
      dir: eta.trDr || "",
      run: eta.rn || "",
      min: Math.max(0, Math.round((arr - prd) / 60000)),
      time: `${at.getUTCHours() % 12 || 12}:${String(at.getUTCMinutes()).padStart(2, "0")}`,
      lat, lon, heading,
      approaching: eta.isApp === "1",
      delayed: eta.isDly === "1",
      scheduled: eta.isSch === "1",
    });
  }
  return arrivals.sort((a, b) => a.min - b.min);
}

function parsePositions(payload) {
  const trains = [];
  for (const r of asList(checkCta(payload).route)) {
    const code = ROUTE_NAMES[String(r["@name"] || "").toLowerCase()];
    if (!code) continue;
    for (const tr of asList(r.train)) {
      const lat = parseFloat(tr.lat), lon = parseFloat(tr.lon);
      if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
      if (kmToRoute(code, lat, lon) > 0.8) continue; // same bogus-position filter as arrivals
      trains.push({
        route: code, run: tr.rn || "", dest: tr.destNm || "", lat, lon,
        heading: tr.heading ? parseInt(tr.heading, 10) : null,
      });
    }
  }
  return trains;
}

// per-isolate memo: { at, data }; serves stale on transient CTA failure
const cache = new Map();

async function cachedCta(key, url, parse, wrap) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return json({ ...wrap(hit.data), cached: true });
  let data;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    data = parse(await resp.json());
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (hit) return json({ ...wrap(hit.data), cached: true, stale: true });
    throw new HttpError(502, `CTA unreachable: ${err.message}`);
  }
  cache.set(key, { at: Date.now(), data });
  return json({ ...wrap(data), cached: false });
}

function arrivals(url, env) {
  const mapid = url.searchParams.get("mapid") || "";
  if (!/^4\d{4}$/.test(mapid)) throw new HttpError(422, "mapid must look like 4xxxx");
  if (!STATION_COORDS.has(mapid)) throw new HttpError(404, "unknown station");
  if (env.CTA_DEMO === "1") {
    const [slat, slon] = STATION_COORDS.get(mapid);
    const demo = DEMO_ARRIVALS.map((a, i) => {
      const [dlat, dlon] = DEMO_OFFSETS[i];
      return { ...a, lat: +(slat + dlat).toFixed(6), lon: +(slon + dlon).toFixed(6), heading: dlat > 0 ? 180 : 0 };
    });
    return json({ arrivals: demo, cached: false, demo: true });
  }
  if (!env.CTA_API_KEY) throw new HttpError(503, "CTA_API_KEY not set — apply at transitchicago.com/developers/traintrackerapply/");
  const q = new URLSearchParams({ key: env.CTA_API_KEY, mapid, max: "8", outputType: "JSON" });
  return cachedCta("arr:" + mapid, `${CTA_URL}?${q}`, parseArrivals, (d) => ({ arrivals: d }));
}

function positions(env) {
  if (env.CTA_DEMO === "1") return json({ trains: [] });
  if (!env.CTA_API_KEY) throw new HttpError(503, "CTA_API_KEY not set");
  const q = new URLSearchParams({ key: env.CTA_API_KEY, rt: Object.keys(ROUTE_NAMES).join(","), outputType: "JSON" });
  return cachedCta("pos", `${CTA_POS_URL}?${q}`, parsePositions, (d) => ({ trains: d }));
}

const HOUR = { "cache-control": "max-age=3600" };

// =====================================================================
// Bus mode — CTA Bus Tracker (BusTime) API, a completely separate system
// =====================================================================
const CTA_BUS_URL = "https://www.ctabustracker.com/bustime/api/v2";
const BUS_TTL_STATIC_MS = 3600 * 1000; // routes/directions/stops/patterns rarely change
const BUS_TTL_LIVE_MS = 12 * 1000;     // predictions/vehicles
const busCache = new Map();
const RT = /^[A-Za-z0-9]{1,6}$/;

function param(url, name, re, maxLen = 60) {
  const v = url.searchParams.get(name);
  if (v === null || v.length > maxLen || (re && !re.test(v))) throw new HttpError(422, `invalid ${name}`);
  return v;
}

// cached GET against BusTime; returns the inner container list (stale on transient failure)
async function busGet(env, path, params, ttl, container) {
  if (!env.CTA_BUS_KEY) throw new HttpError(503, "CTA_BUS_KEY not set — apply at ctabustracker.com");
  const ck = path + "?" + Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  const hit = busCache.get(ck);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  let data;
  try {
    const q = new URLSearchParams({ key: env.CTA_BUS_KEY, format: "json", ...params });
    const resp = await fetch(`${CTA_BUS_URL}/${path}?${q}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = (await resp.json())["bustime-response"] || {};
    if ("error" in body && !(container in body)) {
      throw new HttpError(502, (body.error && body.error[0] && body.error[0].msg) || "bus API error");
    }
    data = body[container] || [];
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (hit) return hit.data;
    throw new HttpError(502, `Bus API unreachable: ${err.message}`);
  }
  busCache.set(ck, { at: Date.now(), data });
  return data;
}

const busMin = (prdctdn) => { const n = parseInt(prdctdn, 10); return /^-?\d+$/.test(String(prdctdn).trim()) ? Math.max(0, n) : 0; }; // "DUE" -> 0
const busTime = (prdtm) => { // "20261027 13:05" -> "1:05"
  const m = /^\d{8} (\d{2}):(\d{2})$/.exec(prdtm || "");
  return m ? `${+m[1] % 12 || 12}:${m[2]}` : "";
};

async function busRoute(url, env) {
  switch (url.pathname) {
    case "/api/bus/allstops":
      return new Response(BUS_STOPS_JSON, { headers: { "content-type": "application/json", "cache-control": "max-age=86400" } });
    case "/api/bus/routes": {
      const rows = await busGet(env, "getroutes", {}, BUS_TTL_STATIC_MS, "routes");
      return json({ routes: rows.map((r) => ({ rt: r.rt, name: r.rtnm || "", color: r.rtclr || "#888" })) }, 200, HOUR);
    }
    case "/api/bus/directions": {
      const rows = await busGet(env, "getdirections", { rt: param(url, "rt", RT) }, BUS_TTL_STATIC_MS, "directions");
      return json({ directions: rows.map((d) => d.dir) }, 200, HOUR);
    }
    case "/api/bus/stops": {
      const params = { rt: param(url, "rt", RT), dir: param(url, "dir", null, 20) };
      const rows = await busGet(env, "getstops", params, BUS_TTL_STATIC_MS, "stops");
      return json({ stops: rows.map((s) => ({ stpid: String(s.stpid), name: s.stpnm || "", lat: s.lat ?? null, lon: s.lon ?? null })) }, 200, HOUR);
    }
    case "/api/bus/patterns": {
      const rows = await busGet(env, "getpatterns", { rt: param(url, "rt", RT) }, BUS_TTL_STATIC_MS, "ptr");
      const patterns = rows.map((p) => ({
        pid: p.pid, dir: p.rtdir || "", length: p.ln || 0,
        pts: (p.pt || []).map((pt) => [pt.lat, pt.lon, pt.pdist || 0]),
      }));
      return json({ patterns }, 200, HOUR);
    }
    case "/api/bus/predictions": {
      const stpid = param(url, "stpid", /^\d{1,7}(,\d{1,7})*$/, 400);
      const rows = asList(await busGet(env, "getpredictions", { stpid }, BUS_TTL_LIVE_MS, "prd"));
      const predictions = rows.map((p) => ({
        route: p.rt || "", dest: p.des || "", dir: p.rtdir || "",
        min: busMin(p.prdctdn), time: busTime(p.prdtm),
        approaching: String(p.prdctdn).toUpperCase() === "DUE",
        delayed: Boolean(p.dly), vid: p.vid || "",
      })).sort((a, b) => a.min - b.min);
      return json({ predictions });
    }
    case "/api/bus/vehicles": {
      const rt = param(url, "rt", /^[A-Za-z0-9,]{1,60}$/);
      const buses = [];
      for (const v of asList(await busGet(env, "getvehicles", { rt }, BUS_TTL_LIVE_MS, "vehicle"))) {
        const lat = parseFloat(v.lat), lon = parseFloat(v.lon);
        if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
        buses.push({
          vid: String(v.vid ?? ""), route: v.rt || "", dest: v.des || "", lat, lon,
          heading: /^\d+$/.test(String(v.hdg ?? "")) ? parseInt(v.hdg, 10) : null,
          pid: v.pid ?? null,
          pdist: v.pdist === undefined || v.pdist === null || v.pdist === "" ? null : parseFloat(v.pdist),
          delayed: Boolean(v.dly),
        });
      }
      return json({ buses });
    }
    default:
      return json({ detail: "Not Found" }, 404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/api/arrivals": return await arrivals(url, env);
        case "/api/positions": return await positions(env);
        case "/api/stations": return json({ stations: STATIONS, line_order: LINE_ORDER }, 200, HOUR);
        case "/api/lines": return json(LINES, 200, HOUR);
        default:
          if (url.pathname.startsWith("/api/bus/")) return await busRoute(url, env); return json({ detail: "Not Found" }, 404);
      }
    } catch (err) {
      if (err instanceof HttpError) return json({ detail: err.message }, err.status);
      throw err;
    }
  },
};

"""CTA train arrival board.

Proxies the CTA Train Tracker API so the API key stays server-side, with a
short cache so an always-on kiosk stays well under the 50k calls/day limit.

Run:  CTA_API_KEY=xxx uv run uvicorn main:app --host 0.0.0.0 --port 8000
"""

import json
import math
import os
import time
from datetime import datetime
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse

ROOT = Path(__file__).parent
CTA_URL = "https://lapi.transitchicago.com/api/1.0/ttarrivals.aspx"
CTA_POS_URL = "https://lapi.transitchicago.com/api/1.0/ttpositions.aspx"
CACHE_TTL = 9  # seconds; kiosk polls every 10s (~17k CTA calls/day for 2 feeds, limit is 50k)
ROUTE_NAMES = {"red": "Red", "blue": "Blue", "brn": "Brn", "g": "G",
               "org": "Org", "p": "P", "pink": "Pink", "y": "Y"}

STATIONS = json.loads((ROOT / "stations.json").read_text())
STATION_IDS = {s["map_id"] for s in STATIONS}
STATION_COORDS = {s["map_id"]: (s["lat"], s["lon"]) for s in STATIONS}

# --- track geometry: used to reject trains reported way off their own line ---
_REF_COS = math.cos(math.radians(41.88))  # Chicago latitude


def _km_xy(lat: float, lon: float) -> tuple[float, float]:
    return (lon * 111.32 * _REF_COS, lat * 110.574)


def _build_route_edges() -> dict[str, list]:
    routes = json.loads((ROOT / "lines.json").read_text())["routes"]
    edges: dict[str, list] = {}
    for code, segs in routes.items():
        e = []
        for seg in segs:
            pts = [_km_xy(lat, lon) for lat, lon in seg]
            for i in range(len(pts) - 1):
                e.append((pts[i], pts[i + 1]))
        edges[code] = e
    return edges


ROUTE_EDGES = _build_route_edges()


def _km_to_route(route: str, lat: float, lon: float) -> float:
    edges = ROUTE_EDGES.get(route)
    if not edges:
        return 0.0
    p = _km_xy(lat, lon)
    best = 1e9
    for a, b in edges:
        abx, aby = b[0] - a[0], b[1] - a[1]
        apx, apy = p[0] - a[0], p[1] - a[1]
        ab2 = abx * abx + aby * aby
        t = 0.0 if ab2 == 0 else max(0.0, min(1.0, (apx * abx + apy * aby) / ab2))
        dx, dy = apx - t * abx, apy - t * aby
        d = dx * dx + dy * dy
        if d < best:
            best = d
    return math.sqrt(best)


# --- station order along each line (for the picker UI): nearest-neighbour
# chain starting from the terminus farthest from the network centroid ---
def _build_line_order() -> dict[str, list]:
    clat = sum(s["lat"] for s in STATIONS) / len(STATIONS)
    clon = sum(s["lon"] for s in STATIONS) / len(STATIONS)
    order: dict[str, list] = {}
    codes = sorted({c for s in STATIONS for c in s["lines"]})
    for code in codes:
        sts = [s for s in STATIONS if code in s["lines"]]
        start = max(sts, key=lambda s: (s["lat"] - clat) ** 2 + (s["lon"] - clon) ** 2)
        chain = [start]
        rest = {s["map_id"]: s for s in sts if s["map_id"] != start["map_id"]}
        while rest:
            last = chain[-1]
            nxt = min(rest.values(),
                      key=lambda s: (s["lat"] - last["lat"]) ** 2 + (s["lon"] - last["lon"]) ** 2)
            chain.append(nxt)
            del rest[nxt["map_id"]]
        order[code] = [s["map_id"] for s in chain]
    return order


LINE_ORDER = _build_line_order()


def _load_key() -> str:
    key = os.environ.get("CTA_API_KEY", "")
    env_file = ROOT / ".env"
    if not key and env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("CTA_API_KEY="):
                key = line.split("=", 1)[1].strip().strip('"')
    return key


API_KEY = _load_key()
DEMO = os.environ.get("CTA_DEMO") == "1"  # fake arrivals while waiting on an API key

DEMO_ARRIVALS = [
    {"route": "Red", "dest": "Howard", "platform": "Service toward Howard", "dir": "1", "run": "801", "min": 2, "time": "11:17", "approaching": True, "delayed": False, "scheduled": False},
    {"route": "Red", "dest": "95th/Dan Ryan", "platform": "Service toward 95th", "dir": "5", "run": "923", "min": 4, "time": "11:19", "approaching": False, "delayed": False, "scheduled": False},
    {"route": "Brn", "dest": "Kimball", "platform": "Service toward Kimball", "dir": "1", "run": "415", "min": 7, "time": "11:22", "approaching": False, "delayed": False, "scheduled": False},
    {"route": "Red", "dest": "Howard", "platform": "Service toward Howard", "dir": "1", "run": "804", "min": 11, "time": "11:26", "approaching": False, "delayed": True, "scheduled": False},
    {"route": "Brn", "dest": "Loop", "platform": "Service toward Loop", "dir": "5", "run": "421", "min": 15, "time": "11:30", "approaching": False, "delayed": False, "scheduled": True},
]

app = FastAPI(title="cta-tracker")
app.add_middleware(GZipMiddleware, minimum_size=500)  # shrink JSON on slow links
client = httpx.AsyncClient(timeout=10)
_cache: dict[str, tuple[float, list]] = {}

CTA_TIME = "%Y-%m-%dT%H:%M:%S"


def _parse_arrivals(payload: dict) -> list:
    ctatt = payload.get("ctatt", {})
    if ctatt.get("errCd") not in ("0", 0, None):
        raise HTTPException(502, ctatt.get("errNm") or "CTA API error")
    etas = ctatt.get("eta") or []
    if isinstance(etas, dict):  # CTA emits a bare object when only one arrival
        etas = [etas]
    arrivals = []
    for eta in etas:
        try:
            arr = datetime.strptime(eta["arrT"], CTA_TIME)
            prd = datetime.strptime(eta["prdt"], CTA_TIME)
        except (KeyError, ValueError):
            continue
        minutes = max(0, round((arr - prd).total_seconds() / 60))
        lat = float(eta["lat"]) if eta.get("lat") else None
        lon = float(eta["lon"]) if eta.get("lon") else None
        heading = int(eta["heading"]) if eta.get("heading") else None
        # CTA sometimes reports a position nowhere near the train's own line;
        # drop the bogus coordinates but keep the (still valid) prediction
        if lat is not None and _km_to_route(eta.get("rt", ""), lat, lon) > 0.8:
            lat = lon = heading = None
        arrivals.append(
            {
                "route": eta.get("rt", ""),
                "dest": eta.get("destNm", ""),
                "platform": eta.get("stpDe", ""),
                "dir": eta.get("trDr", ""),
                "run": eta.get("rn", ""),
                "min": minutes,
                "time": arr.strftime("%I:%M").lstrip("0"),
                "lat": lat,
                "lon": lon,
                "heading": heading,
                "approaching": eta.get("isApp") == "1",
                "delayed": eta.get("isDly") == "1",
                "scheduled": eta.get("isSch") == "1",
            }
        )
    arrivals.sort(key=lambda a: a["min"])
    return arrivals


@app.get("/")
async def index():
    return FileResponse(ROOT / "static" / "index.html")


LINES = json.loads((ROOT / "lines.json").read_text())


@app.get("/api/stations")
async def stations():
    return JSONResponse({"stations": STATIONS, "line_order": LINE_ORDER},
                        headers={"Cache-Control": "max-age=3600"})


@app.get("/api/lines")
async def lines():
    return JSONResponse(LINES, headers={"Cache-Control": "max-age=3600"})


@app.get("/api/arrivals")
async def arrivals(mapid: str = Query(pattern=r"^4\d{4}$")):
    if mapid not in STATION_IDS:
        raise HTTPException(404, "unknown station")
    if DEMO:
        slat, slon = STATION_COORDS[mapid]
        demo = []
        offsets = [(0.004, 0.001), (-0.012, -0.003), (0.021, 0.005), (-0.030, -0.006), (0.042, 0.010)]
        for a, (dlat, dlon) in zip(DEMO_ARRIVALS, offsets):
            a = dict(a)
            a["lat"], a["lon"] = round(slat + dlat, 6), round(slon + dlon, 6)
            a["heading"] = 180 if dlat > 0 else 0
            demo.append(a)
        return {"arrivals": demo, "cached": False, "demo": True}
    if not API_KEY:
        raise HTTPException(503, "CTA_API_KEY not set — apply at transitchicago.com/developers/traintrackerapply/")

    now = time.monotonic()
    cached = _cache.get(mapid)
    if cached and now - cached[0] < CACHE_TTL:
        return {"arrivals": cached[1], "cached": True}

    try:
        resp = await client.get(
            CTA_URL,
            params={"key": API_KEY, "mapid": mapid, "max": 8, "outputType": "JSON"},
        )
        resp.raise_for_status()
        result = _parse_arrivals(resp.json())
    except httpx.HTTPError as exc:
        if cached:  # serve stale on transient CTA failure
            return {"arrivals": cached[1], "cached": True, "stale": True}
        raise HTTPException(502, f"CTA unreachable: {exc}") from exc

    _cache[mapid] = (now, result)
    return {"arrivals": result, "cached": False}


_pos_cache: list = [0.0, None]  # [monotonic, trains]


def _parse_positions(payload: dict) -> list:
    ctatt = payload.get("ctatt", {})
    if ctatt.get("errCd") not in ("0", 0, None):
        raise HTTPException(502, ctatt.get("errNm") or "CTA API error")
    routes = ctatt.get("route") or []
    if isinstance(routes, dict):
        routes = [routes]
    trains = []
    for r in routes:
        code = ROUTE_NAMES.get(str(r.get("@name", "")).lower())
        if not code:
            continue
        cars = r.get("train") or []
        if isinstance(cars, dict):
            cars = [cars]
        for tr in cars:
            try:
                lat, lon = float(tr["lat"]), float(tr["lon"])
            except (KeyError, TypeError, ValueError):
                continue
            if _km_to_route(code, lat, lon) > 0.8:
                continue  # same bogus-position filter as arrivals
            trains.append(
                {
                    "route": code,
                    "run": tr.get("rn", ""),
                    "dest": tr.get("destNm", ""),
                    "lat": lat,
                    "lon": lon,
                    "heading": int(tr["heading"]) if tr.get("heading") else None,
                }
            )
    return trains


@app.get("/api/positions")
async def positions():
    """Every live train system-wide (CTA locations feed), for the ambient map."""
    if DEMO:
        return {"trains": []}
    if not API_KEY:
        raise HTTPException(503, "CTA_API_KEY not set")

    now = time.monotonic()
    if _pos_cache[1] is not None and now - _pos_cache[0] < CACHE_TTL:
        return {"trains": _pos_cache[1], "cached": True}

    try:
        resp = await client.get(
            CTA_POS_URL,
            params={"key": API_KEY, "rt": ",".join(ROUTE_NAMES), "outputType": "JSON"},
        )
        resp.raise_for_status()
        result = _parse_positions(resp.json())
    except httpx.HTTPError as exc:
        if _pos_cache[1] is not None:
            return {"trains": _pos_cache[1], "cached": True, "stale": True}
        raise HTTPException(502, f"CTA unreachable: {exc}") from exc

    _pos_cache[0] = now
    _pos_cache[1] = result
    return {"trains": result, "cached": False}

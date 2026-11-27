#!/usr/bin/env python3
"""
HA SolarPayBack — FastAPI Backend
Serves the frontend static files and provides REST API for:
- Settings, monthly data, tariffs, grid events (SQLite)
- HA API proxy (entity states, history, statistics) using Supervisor token
"""

import os
import sqlite3
import json
import uuid
import asyncio
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
import aiohttp
import asyncio


# =============================================================================
# Configuration
# =============================================================================

DB_PATH = os.environ.get("DB_PATH", "/data/ha-solarpayback.db")
SUPERVISOR_TOKEN_PATH = os.environ.get("SUPERVISOR_TOKEN_PATH", "/var/run/secrets/hassio-token")
SUPERVISOR_API = os.environ.get("SUPERVISOR_API", "http://supervisor")

# HA REST API base (internal, via supervisor)
HA_API_BASE = f"{SUPERVISOR_API}/core/api"

# Default Agile export rate entity (Octopus Energy integration).
DEFAULT_EXPORT_RATE_ENTITY = "sensor.octopus_energy_electricity_24l3504052_1170002575590_export_current_rate"
# How often the export-rate logger captures the live Agile rate (seconds).
# Agile reprices every half hour, so we log every 30 min as well.
EXPORT_RATE_INTERVAL_SECS = 30 * 60


# =============================================================================
# Database Layer
# =============================================================================

def get_db():
    """Get a database connection with row factory."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Initialize database schema."""
    conn = get_db()
    try:
        # Settings table
        conn.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            )
        """)

        # Monthly data table
        conn.execute("""
            CREATE TABLE IF NOT EXISTS monthly_data (
                month TEXT PRIMARY KEY,
                year INTEGER NOT NULL,
                generated REAL DEFAULT 0,
                exported REAL DEFAULT 0,
                grid_import REAL DEFAULT 0,
                bat_charge REAL DEFAULT 0,
                bat_discharge REAL DEFAULT 0,
                load REAL DEFAULT 0,
                grid_events REAL DEFAULT 0,
                export_income REAL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            )
        """)

        # Tariff history table
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tariff_history (
                id TEXT PRIMARY KEY,
                month TEXT NOT NULL,
                day REAL NOT NULL,
                night REAL NOT NULL DEFAULT 0,
                export REAL NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tariff_month ON tariff_history(month)")

        # Export rate log (raw captures; backup / future-proofing source of truth).
        # Stores every rate read (Agile live, manual, or sync) with its timestamp so
        # past export income can be reconstructed from real rates, not a monthly average.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS export_rate_log (
                id TEXT PRIMARY KEY,
                ts TEXT NOT NULL,
                month TEXT NOT NULL,
                rate_p REAL NOT NULL,
                source TEXT NOT NULL DEFAULT 'agile',
                notes TEXT DEFAULT ''
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_export_rate_month ON export_rate_log(month)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_export_rate_ts ON export_rate_log(ts)")

        # Export slot log: per-half-hour export kWh + the rate applied to that slot.
        # slot = half-hour bucket start (ISO), month for quick lookup. The export kWh
        # is the delta of the cumulative feedin across that half hour; rate_p is the
        # Agile rate logged for that slot (or the monthly blend for sparsely-logged gaps).
        conn.execute("""
            CREATE TABLE IF NOT EXISTS export_slot_log (
                slot TEXT PRIMARY KEY,
                month TEXT NOT NULL,
                export_kwh REAL DEFAULT 0,
                rate_p REAL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_export_slot_month ON export_slot_log(month)")

        # Grid events table
        conn.execute("""
            CREATE TABLE IF NOT EXISTS grid_events (
                id TEXT PRIMARY KEY,
                date TEXT NOT NULL,
                amount REAL NOT NULL,
                notes TEXT DEFAULT '',
                created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_grid_date ON grid_events(date)")

        # Migration: add export_income column to a pre-existing monthly_data table
        # (CREATE TABLE IF NOT EXISTS won't add columns). Idempotent + safe.
        cols = [r[1] for r in conn.execute("PRAGMA table_info(monthly_data)").fetchall()]
        if "export_income" not in cols:
            conn.execute("ALTER TABLE monthly_data ADD COLUMN export_income REAL DEFAULT 0")

        conn.commit()
    finally:
        conn.close()


def now_ts() -> int:
    return int(datetime.now(timezone.utc).timestamp())


def local_tz():
    """Return the add-on's local timezone, resolving it robustly.

    HA injects a TZ env var into add-on containers (e.g. 'Europe/London'), but the
    slim image may not ship `tzdata`, so ZoneInfo("Europe/London") can raise
    ZoneInfoNotFoundError at runtime. Prefer the TZ var and fall back to UTC when
    the timezone database is unavailable, so background tasks never crash.
    """
    name = os.environ.get("TZ") or "UTC"
    try:
        return ZoneInfo(name)
    except Exception:
        # tzdata missing / unknown name -> UTC (never crash a background task).
        return timezone.utc


# =============================================================================
# HA Client (server-side, uses Supervisor token)
# =============================================================================

class HAClient:
    """Client for calling Home Assistant REST API using Supervisor token."""

    def __init__(self):
        self.token = None
        self.session = None
        self._load_token()

    def _load_token(self):
            # Modern Home Assistant injects the token as an environment variable
            # SUPERVISOR_TOKEN (not a file). Read that first, then fall back to a file.
            token = os.environ.get("SUPERVISOR_TOKEN")
            if token:
                self.token = token.strip()
                print(f"HA Client: Loaded supervisor token from env (length: {len(self.token)})")
                return
            try:
                with open(SUPERVISOR_TOKEN_PATH, "r") as f:
                    self.token = f.read().strip()
                print(f"HA Client: Loaded supervisor token from file (length: {len(self.token)})")
            except FileNotFoundError:
                print(f"HA Client: WARNING - Supervisor token not found at {SUPERVISOR_TOKEN_PATH}")
                self.token = None
            except Exception as e:
                print(f"HA Client: ERROR loading token: {e}")
                self.token = None

    async def _get_session(self) -> aiohttp.ClientSession:
        if self.session is None or self.session.closed:
            self.session = aiohttp.ClientSession(
                headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"}
                if self.token else {"Content-Type": "application/json"}
            )
        return self.session

    async def close(self):
        if self.session and not self.session.closed:
            await self.session.close()

    async def request(self, method: str, path: str, **kwargs) -> Any:
        """Make authenticated request to HA API."""
        if not self.token:
            raise HTTPException(status_code=503, detail="HA not available: no supervisor token")

        session = await self._get_session()
        url = f"{HA_API_BASE}{path}"

        try:
            async with session.request(method, url, **kwargs) as resp:
                if resp.status >= 400:
                    text = await resp.text()
                    raise HTTPException(status_code=resp.status, detail=f"HA API error: {text}")
                if resp.status == 204:
                    return None
                return await resp.json()
        except aiohttp.ClientError as e:
            raise HTTPException(status_code=502, detail=f"HA connection error: {e}")

    # Convenience methods
    async def get_state(self, entity_id: str) -> dict:
        return await self.request("GET", f"/states/{entity_id}")

    async def get_states(self) -> list:
        return await self.request("GET", "/states")

    async def get_history(self, entity_ids: List[str], start_time: str, end_time: str, period: Optional[str] = None) -> dict:
        params = {
            "filter_entity_id": ",".join(entity_ids),
            "end_time": end_time,
        }
        if start_time:
            params["start_time"] = start_time
        if period:
            params["period"] = period
        # Pass params via aiohttp so they are URL-encoded — ISO timestamps carry a '+'
        # timezone separator (…T14:21:17+00:00) which must not be decoded as a space.
        return await self.request("GET", "/history/period", params=params)

    async def get_statistics(self, entity_ids: List[str], start_time: str, end_time: str) -> dict:
        params = {
            "statistic_ids": entity_ids,
            "start_time": start_time,
            "end_time": end_time,
        }
        return await self.request("GET", "/statistics", params=params)


ha_client = HAClient()


# =============================================================================
# Pydantic Models
# =============================================================================

class SettingsModel(BaseModel):
    systemCost: Optional[str] = None
    installDate: Optional[str] = None
    mcsAnnual: Optional[str] = None
    capacity: Optional[str] = None
    exportStartDate: Optional[str] = None
    priceRise: Optional[str] = None
    wear: Optional[str] = None
    haUrl: Optional[str] = None
    haToken: Optional[str] = None
    entityMap: Optional[Dict[str, str]] = None
    exportRateSource: Optional[str] = None      # 'agile' | 'fixed'
    exportRateEntity: Optional[str] = None      # live export rate entity id (Agile)
    exportRateP: Optional[str] = None           # latest captured rate in p/kWh


class MonthlyDataModel(BaseModel):
    month: str
    generated: float = 0
    exported: float = 0
    gridImport: float = 0
    batCharge: float = 0
    batDischarge: float = 0
    load: float = 0
    gridEvents: float = 0
    exportIncome: float = 0


class TariffModel(BaseModel):
    id: Optional[str] = None
    month: str
    day: float
    night: float = 0
    export: float = 0


class GridEventModel(BaseModel):
    id: Optional[str] = None
    date: str
    amount: float
    notes: str = ""


# =============================================================================
# FastAPI App Lifecycle
# =============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    init_db()
    print("Database initialized")

    # Daily overnight HA sync (background task).
    sync_task = asyncio.create_task(daily_sync_loop())
    print("Daily HA sync task started")

    # Export-rate logger (captures Agile rate every 30 min when Agile is selected).
    rate_task = asyncio.create_task(export_rate_log_loop())
    print("Export rate logger task started")

    # Current-month refresher (updates today's figures every 30 min).
    month_task = asyncio.create_task(monthly_refresh_loop())
    print("Current-month refresh task started")

    # One-off slot/income repair shortly after boot (Agile source only).
    async def _initial_export_repair():
        try:
            await asyncio.sleep(5)
            await repair_current_month_export()
        except Exception as e:
            print(f"Initial export-income repair: ERROR {e}")

    init_repair_task = asyncio.create_task(_initial_export_repair())

    yield

    # Shutdown
    sync_task.cancel()
    rate_task.cancel()
    month_task.cancel()
    init_repair_task.cancel()
    try:
        await sync_task
        await rate_task
        await month_task
        await init_repair_task
    except asyncio.CancelledError:
        pass
    await ha_client.close()
    print("HA client closed")


app = FastAPI(title="HA SolarPayBack API", version="1.0.0", lifespan=lifespan)

# CORS for ingress (browser calls same origin, but allow for dev)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =============================================================================
# Health Check
# =============================================================================

@app.get("/health")
async def health():
    return {"status": "ok", "db": DB_PATH, "ha_token": bool(ha_client.token)}


# =============================================================================
# Settings API
# =============================================================================

@app.get("/api/settings")
async def get_settings():
    conn = get_db()
    try:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        return {row["key"]: row["value"] for row in rows}
    finally:
        conn.close()


@app.put("/api/settings")
async def put_settings(settings: SettingsModel):
    conn = get_db()
    try:
        ts = now_ts()
        for key, value in settings.model_dump(exclude_none=True).items():
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
                (key, str(value), ts)
            )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# =============================================================================
# Monthly Data API
# =============================================================================

@app.get("/api/monthly-data")
async def get_monthly_data(month: Optional[str] = None):
    conn = get_db()
    try:
        if month:
            row = conn.execute(
                "SELECT * FROM monthly_data WHERE month = ?", (month,)
            ).fetchone()
            if not row:
                # Return an empty shell for a month that isn't stored yet rather
                # than 404 — the frontend uses this during sync to boot-strap a
                # month that has never been saved.
                return {"month": month, "year": int(month.split("-")[0]), "generated": 0, "exported": 0,
                        "grid_import": 0, "bat_charge": 0, "bat_discharge": 0, "load": 0, "grid_events": 0, "export_income": 0}
            return dict(row)
        else:
            rows = conn.execute("SELECT * FROM monthly_data ORDER BY month").fetchall()
            return [dict(row) for row in rows]
    finally:
        conn.close()


@app.post("/api/monthly-data")
async def post_monthly_data(data: MonthlyDataModel):
    conn = get_db()
    try:
        ts = now_ts()
        conn.execute("""
            INSERT OR REPLACE INTO monthly_data
            (month, year, generated, exported, grid_import, bat_charge, bat_discharge, load, grid_events, export_income, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            data.month,
            int(data.month.split("-")[0]),
            data.generated,
            data.exported,
            data.gridImport,
            data.batCharge,
            data.batDischarge,
            data.load,
            data.gridEvents,
            data.exportIncome,
            ts
        ))
        conn.commit()
        return {"ok": True, "month": data.month}
    finally:
        conn.close()


@app.delete("/api/monthly-data")
async def delete_monthly_data(month: str):
    conn = get_db()
    try:
        conn.execute("DELETE FROM monthly_data WHERE month = ?", (month,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# =============================================================================
# Tariff History API
# =============================================================================

@app.get("/api/tariffs")
async def get_tariffs():
    conn = get_db()
    try:
        rows = conn.execute("SELECT * FROM tariff_history ORDER BY month").fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


@app.post("/api/tariffs")
async def post_tariff(tariff: TariffModel):
    conn = get_db()
    try:
        tid = tariff.id or str(uuid.uuid4())
        ts = now_ts()
        conn.execute("""
            INSERT INTO tariff_history (id, month, day, night, export, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (tid, tariff.month, tariff.day, tariff.night, tariff.export, ts))
        conn.commit()
        return {"ok": True, "id": tid}
    finally:
        conn.close()


@app.delete("/api/tariffs/{tid}")
async def delete_tariff(tid: str):
    conn = get_db()
    try:
        conn.execute("DELETE FROM tariff_history WHERE id = ?", (tid,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# =============================================================================
# Grid Events API
# =============================================================================

@app.get("/api/grid-events")
async def get_grid_events(month: Optional[str] = None):
    conn = get_db()
    try:
        if month:
            rows = conn.execute(
                "SELECT * FROM grid_events WHERE date LIKE ? ORDER BY date", (f"{month}%",)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM grid_events ORDER BY date").fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


@app.post("/api/grid-events")
async def post_grid_event(event: GridEventModel):
    conn = get_db()
    try:
        eid = event.id or str(uuid.uuid4())
        ts = now_ts()
        conn.execute("""
            INSERT INTO grid_events (id, date, amount, notes, created_at)
            VALUES (?, ?, ?, ?, ?)
        """, (eid, event.date, event.amount, event.notes, ts))
        conn.commit()
        return {"ok": True, "id": eid}
    finally:
        conn.close()


@app.delete("/api/grid-events/{eid}")
async def delete_grid_event(eid: str):
    conn = get_db()
    try:
        conn.execute("DELETE FROM grid_events WHERE id = ?", (eid,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# =============================================================================
# Export Rate (Agile) — live capture, log, and source selection
# =============================================================================

def _get_settings_map() -> dict:
    conn = get_db()
    try:
        return {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings").fetchall()}
    finally:
        conn.close()


def _active_export_rate_entity(settings: dict) -> str:
    return (settings.get("exportRateEntity") or "").strip() or DEFAULT_EXPORT_RATE_ENTITY


async def _capture_export_rate_now(source: str = "agile") -> dict:
    """Read the live export rate from HA, log it, and persist the latest p value.

    Returns the captured rate in p/kWh (or None if the entity is unavailable).
    The rate entity states a £/kWh value (e.g. 0.1853); the app works in p/kWh
    (18.53), so we multiply by 100. (async — awaits the HA REST call directly;
    previously this was run inside a thread without awaiting, which produced a
    coroutine-vs-dict crash and a 500.)
    """
    settings = _get_settings_map()
    # Only attempt a live read when Agile is the selected source (or when forced).
    if settings.get("exportRateSource", "fixed") != "agile" and source.startswith("agile"):
        return {"ok": False, "source": settings.get("exportRateSource", "fixed"), "rateP": None, "note": "Agile not selected"}

    entity = _active_export_rate_entity(settings)
    try:
        state = await ha_client.request("GET", f"/states/{entity}")
    except HTTPException as e:
        return {"ok": False, "rateP": None, "error": f"HA unavailable: {e.detail}"}
    except Exception as e:
        return {"ok": False, "rateP": None, "error": str(e)}

    raw = state.get("state")
    try:
        rate_gbp = float(raw)
    except (TypeError, ValueError):
        return {"ok": False, "rateP": None, "error": f"Entity {entity} not a number: {raw!r}"}

    rate_p = round(rate_gbp * 100.0, 4)
    log_id = str(uuid.uuid4())
    ts = datetime.now(timezone.utc).isoformat()
    month = ts[:7]

    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO export_rate_log (id, ts, month, rate_p, source, notes) VALUES (?, ?, ?, ?, ?, ?)",
            (log_id, ts, month, rate_p, source, entity),
        )
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('exportRateP', ?, ?)",
            (str(rate_p), now_ts()),
        )
        conn.commit()
    finally:
        conn.close()

    print(f"Export rate: captured {rate_p}p/kWh ({source}) from {entity}")
    return {"ok": True, "rateP": rate_p, "ts": ts, "month": month, "entity": entity}


@app.get("/api/export-rates")
async def get_export_rates(month: Optional[str] = None, latest_only: bool = False):
    """Return the raw export-rate log (backup / reconstruction source of truth)."""
    conn = get_db()
    try:
        if latest_only:
            row = conn.execute(
                "SELECT * FROM export_rate_log ORDER BY ts DESC LIMIT 1"
            ).fetchone()
            return dict(row) if row else None
        if month:
            rows = conn.execute(
                "SELECT * FROM export_rate_log WHERE month = ? ORDER BY ts", (month,)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM export_rate_log ORDER BY ts").fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


@app.get("/api/export-rates/current")
async def get_export_rate_current():
    """Return the live rate for the selected source (Agile: from HA; Fixed: manual tariff)."""
    settings = _get_settings_map()
    source = settings.get("exportRateSource", "fixed")
    if source == "agile":
        captured = await _capture_export_rate_now("agile")
        return captured
    # Fixed: return the latest manual export tariff value (p/kWh).
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT export FROM tariff_history ORDER BY month DESC LIMIT 1"
        ).fetchone()
        manual_p = row["export"] if row else 0
    finally:
        conn.close()
    return {"ok": True, "source": "fixed", "rateP": manual_p}


@app.post("/api/export-rates/capture")
async def capture_export_rate(source: str = "agile"):
    """Force a manual capture/log of the current Agile rate."""
    captured = await _capture_export_rate_now(source)
    return captured


@app.post("/api/export-rates/repair")
async def export_rate_repair(month: Optional[str] = None):
    """Rebuild a month's per-half-hour export slots + export income from HA history.

    Defaults to the in-flight (current) month. Prices each slot with the Agile rate
    logged for it (monthly blend for gaps, £0 before the export contract start), stores
    the slots, and writes the month's export_income onto monthly_data.
    """
    if month:
        return await rebuild_month_export_slots(month)
    return await repair_current_month_export()


async def export_rate_log_loop():
    """Background task: capture+log the live Agile export rate every 30 minutes.

    Agile reprices half-hourly, so we log at the same cadence. Only runs when
    the export rate source is 'agile'. Logging is cheap (one row every 30 min).
    """
    while True:
        await asyncio.sleep(EXPORT_RATE_INTERVAL_SECS)
        settings = _get_settings_map()
        if settings.get("exportRateSource", "fixed") == "agile":
            try:
                await _capture_export_rate_now("agile")
            except Exception as e:
                print(f"Export rate logger: ERROR {e}")


# =============================================================================
# Slot-based export income
# =============================================================================

#: Lifetime cumulative export meter (same sensor as monthly exported).
SLOT_FEEDIN_ENTITY = "sensor.garage_foxess_feedin"


def _monthly_avg_rate_p(month: str) -> float:
    """Average Agile rate (p/kWh) across a month's logged captures; 0 if none."""
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT rate_p FROM export_rate_log WHERE month = ?", (month,)
        ).fetchall()
    finally:
        conn.close()
    if not rows:
        return 0.0
    return round(sum(r["rate_p"] for r in rows) / len(rows), 4)


def _rate_for_slot(month: str, slot_dt, export_start_dt) -> float:
    """Rate (p/kWh) for a half-hour slot: newest logged at/before it, else monthly blend.

    Slots strictly before the export contract start are priced at 0 (not paid). Gaps
    before the log began use the month's blended average (option b).
    """
    if export_start_dt and slot_dt < export_start_dt:
        return 0.0
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT rate_p FROM export_rate_log WHERE month = ? AND ts <= ? ORDER BY ts DESC LIMIT 1",
            (month, slot_dt.isoformat()),
        ).fetchone()
    finally:
        conn.close()
    if row:
        return float(row["rate_p"])
    return _monthly_avg_rate_p(month)


def _slot_bucket_start(dt) -> str:
    """Floor a datetime to the start of its 30-minute slot, as an ISO string."""
    minute = (dt.minute // 30) * 30
    return dt.replace(minute=minute, second=0, microsecond=0).isoformat()


def _feedin_delta_slots(values: list, window_start: datetime, window_end: datetime) -> dict:
    """Map 30-minute slot-start -> export kWh, from feedin cumulative history.

    feedin is lifetime-cumulative (total_increasing), so the delta between the first
    and last cumulative reading inside each half-hour window is the export kWh that
    landed in that window. Slots with no change are left out (kWh ~ 0).
    """
    pts = []
    for p in values:
        state = p.get("state")
        lc = p.get("last_changed")
        if state is None or not lc:
            continue
        try:
            v = float(state)
        except (ValueError, TypeError):
            continue
        try:
            dt = datetime.fromisoformat(lc.replace("Z", "+00:00")).astimezone(timezone.utc)
        except ValueError:
            continue
        pts.append((dt, v))
    pts.sort(key=lambda x: x[0])
    if not pts:
        return {}
    # Anchor: assume the meter held the first known value at window start.
    pts.insert(0, (window_start, pts[0][1]))

    result = {}
    cur = window_start
    slot_step = timedelta(minutes=30)
    idx = 0
    while cur < window_end:
        next_cur = cur + slot_step
        while idx < len(pts) and pts[idx][0] < cur:
            idx += 1
        first_val = None
        last_val = None
        j = idx
        while j < len(pts) and pts[j][0] < next_cur:
            if first_val is None:
                first_val = pts[j][1]
            last_val = pts[j][1]
            j += 1
        if first_val is not None and last_val is not None and last_val > first_val:
            result[_slot_bucket_start(cur)] = round(last_val - first_val, 4)
        cur = next_cur
    return result


async def rebuild_month_export_slots(month: str, end_time: Optional[str] = None) -> dict:
    """Repair/top-up the in-flight month's per-half-hour export slots from HA history.

    Derives per-slot export kWh from the feedin cumulative history, prices each slot
    with the Agile rate logged for it (monthly blend for gaps, £0 before the export
    contract start), stores rows in export_slot_log, then writes the month's
    export_income onto monthly_data.
    """
    settings = _get_settings_map()
    export_start_dt = None
    est = settings.get("exportStartDate", "")
    if est:
        try:
            export_start_dt = datetime.fromisoformat(est).astimezone(timezone.utc)
        except ValueError:
            export_start_dt = None

    now = datetime.now(timezone.utc)
    month_start = datetime(int(month[:4]), int(month[5:7]), 1, tzinfo=timezone.utc)
    if end_time:
        try:
            end_dt = datetime.fromisoformat(end_time)
            if end_dt.tzinfo is None:
                end_dt = end_dt.replace(tzinfo=timezone.utc)
        except ValueError:
            end_dt = now
    else:
        end_dt = now
    if end_dt > now:
        end_dt = now

    history = await ha_client.get_history(
        [SLOT_FEEDIN_ENTITY], month_start.isoformat(), end_dt.isoformat(), None
    )
    feedin_list = history[0] if history else []
    slots = _feedin_delta_slots(feedin_list, month_start, end_dt)

    stored = 0
    total_income = 0.0
    conn = get_db()
    try:
        for slot_key, kwh in slots.items():
            slot_dt = datetime.fromisoformat(slot_key)
            rate_p = _rate_for_slot(month, slot_dt, export_start_dt)
            income = round(kwh * rate_p / 100.0, 2) if rate_p and kwh else 0.0
            total_income += income
            conn.execute(
                "INSERT OR REPLACE INTO export_slot_log (slot, month, export_kwh, rate_p, updated_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (slot_key, month, kwh, rate_p, now_ts()),
            )
            stored += 1
        conn.execute(
            "UPDATE monthly_data SET export_income = ? WHERE month = ?",
            (round(total_income, 2), month),
        )
        conn.commit()
    finally:
        conn.close()

    print(f"Export income: rebuilt {stored} slot(s) for {month}, total £{round(total_income, 2)}")
    return {"month": month, "slots": stored, "exportIncome": round(total_income, 2)}


async def repair_current_month_export() -> dict:
    """Rebuild the in-flight month's export slots when the Agile source is selected."""
    settings = _get_settings_map()
    if settings.get("exportRateSource", "fixed") != "agile":
        return {"ok": False, "note": "not agile source"}
    now_local = datetime.now(local_tz())
    month = now_local.strftime("%Y-%m")
    return await rebuild_month_export_slots(month)


# =============================================================================
# HA Proxy API
# =============================================================================

@app.get("/api/ha/state")
async def ha_state(entity_id: str):
    """Proxy HA /api/states/<entity_id>"""
    return await ha_client.get_state(entity_id)


@app.get("/api/ha/states")
async def ha_states():
    """Proxy HA /api/states (all entities)"""
    return await ha_client.get_states()


@app.get("/api/ha/history")
async def ha_history(
    entity_id: str,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    period: Optional[str] = None
):
    """
    Proxy HA /api/history/period
    Query params: entity_id (comma-separated), start_time, end_time, period (e.g., "day")
    """
    entity_ids = [e.strip() for e in entity_id.split(",")]
    end = end_time or datetime.now(timezone.utc).isoformat()
    start = start_time or (datetime.now(timezone.utc).replace(year=datetime.now().year - 1)).isoformat()
    return await ha_client.get_history(entity_ids, start, end, period)


@app.get("/api/ha/stats")
async def ha_stats(
    entity_id: str,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None
):
    """
    Proxy HA /api/statistics (long-term statistics)
    Query params: entity_id (comma-separated), start_time, end_time
    """
    entity_ids = [e.strip() for e in entity_id.split(",")]
    end = end_time or datetime.now(timezone.utc).isoformat()
    start = start_time or (datetime.now(timezone.utc).replace(year=datetime.now().year - 1)).isoformat()
    return await ha_client.get_statistics(entity_ids, start, end)


@app.get("/api/ha/entities/foxess")
async def ha_foxess_entities():
    """Auto-detect Fox ESS entities from HA."""
    states = await ha_client.get_states()
    entities = {}
    for s in states:
        eid = s.get("entity_id", "")
        if eid.startswith("sensor.garage_foxess_") or eid.startswith("sensor.predbat_fox_"):
            entities[eid] = s.get("attributes", {}).get("friendly_name", eid)
    return entities


# =============================================================================
# HA Monthly Aggregation Endpoint (server-side daily-max)
# =============================================================================

# Fox ESS energy sensor IDs (lifetime cumulative / total_increasing).
ENERGY_ENTITY_IDS = [
    "sensor.garage_foxess_energy_generated",
    "sensor.garage_foxess_feedin",
    "sensor.garage_foxess_grid_consumption",
    "sensor.garage_foxess_bat_charge",
    "sensor.garage_foxess_bat_discharge",
    "sensor.garage_foxess_load",
]

#: Month field names (DB) -> monthly-sums map keys produced by compute_monthly_sums.
MONTH_FIELD_MAP = {
    "generated": "sensor.garage_foxess_energy_generated",
    "exported": "sensor.garage_foxess_feedin",
    "grid_import": "sensor.garage_foxess_grid_consumption",
    "bat_charge": "sensor.garage_foxess_bat_charge",
    "bat_discharge": "sensor.garage_foxess_bat_discharge",
    "load": "sensor.garage_foxess_load",
}

def _daily_max_to_monthly(values: list) -> dict:
    """Compute daily-max -> monthly sums for one entity's history returns.

    Fox ESS sensors are total_increasing (lifetime cumulative). The daily max of
    the raw history per day gives that day's total; summing daily maxes per month
    gives the monthly total.
    """
    daily_max = {}
    for point in values:
        state = point.get("state")
        if state is None:
            continue
        try:
            val = float(state)
        except (ValueError, TypeError):
            continue
        last_changed = point.get("last_changed")
        if not last_changed:
            continue
        dt = datetime.fromisoformat(last_changed.replace("Z", "+00:00"))
        day_key = dt.strftime("%Y-%m-%d")
        if day_key not in daily_max or val > daily_max[day_key]:
            daily_max[day_key] = val
    month_map = {}
    for day_key, max_val in daily_max.items():
        month_key = day_key[:7]
        month_map[month_key] = month_map.get(month_key, 0) + max_val
    return month_map


async def compute_monthly_sums(entity_ids: list, start: str, end: str) -> dict:
    """Return {entity_id: {'YYYY-MM': sum, ...}} using the daily-max method."""
    history = await ha_client.get_history(entity_ids, start, end, None)
    monthly = {}
    for entity_history in history:
        if not entity_history or not entity_history[0].get("entity_id"):
            continue
        entity_id = entity_history[0]["entity_id"]
        monthly[entity_id] = _daily_max_to_monthly(entity_history)
    return monthly


async def run_daily_ha_sync():
    """Pull historical monthly energy totals from HA and store them in SQLite.

    Re-runs the same daily-max aggregation the manual Settings sync performs, so the
    dashboard refreshes automatically once a day (overnight) without needing a browser
    tab open. Installs date must be set; otherwise we skip (nothing to sync yet).
    """
    conn = get_db()
    try:
        settings = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings").fetchall()}
    finally:
        conn.close()

    install_date = settings.get("installDate", "")
    if not install_date:
        print("Daily HA sync: skipped (no install date set)")
        return

    try:
        install = datetime.fromisoformat(install_date)
        end = datetime.now(timezone.utc).isoformat()
        sums = await compute_monthly_sums(ENERGY_ENTITY_IDS, install.isoformat(), end)
    except Exception as e:
        print(f"Daily HA sync: ERROR fetching HA history: {e}")
        return

    # Build per-month records combining across entities, preserving any grid events.
    all_month_keys = set()
    for entity_map in sums.values():
        all_month_keys.update(entity_map.keys())

    conn = get_db()
    try:
        ts = now_ts()
        for month_key in sorted(all_month_keys):
            existing = conn.execute(
                "SELECT grid_events, export_income FROM monthly_data WHERE month = ?", (month_key,)
            ).fetchone()
            grid_events = existing["grid_events"] if existing else 0
            export_income = existing["export_income"] if existing else 0

            row = {
                "month": month_key,
                "year": int(month_key.split("-")[0]),
                "grid_events": grid_events,
                "export_income": export_income,
            }
            for db_field, entity in MONTH_FIELD_MAP.items():
                row[db_field] = sums.get(entity, {}).get(month_key, 0)

            conn.execute("""
                INSERT OR REPLACE INTO monthly_data
                (month, year, generated, exported, grid_import, bat_charge, bat_discharge, load, grid_events, export_income, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                row["month"], row["year"], row["generated"], row["exported"],
                row["grid_import"], row["bat_charge"], row["bat_discharge"], row["load"],
                row["grid_events"], row["export_income"], ts
            ))
        conn.commit()
        print(f"Daily HA sync: stored/updated {len(all_month_keys)} month(s)")
    finally:
        conn.close()


CURRENT_MONTH_REFRESH_INTERVAL_SECS = 30 * 60


async def run_current_month_refresh():
    """Refresh only the in-flight (current) month from live HA energy sensors.

    Unlike the overnight daily sync (which rebuilds all months), this runs every
    30 minutes and updates just the current month's generated/exported/grid/battery/
    load so the dashboard reflects "today so far" without churning historical months.
    Uses the same daily-max aggregation; preserves any grid events already recorded.
    """
    conn = get_db()
    try:
        settings = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings").fetchall()}
    finally:
        conn.close()

    install_date = settings.get("installDate", "")
    if not install_date:
        return  # Nothing to anchor to yet.

    now_local = datetime.now(local_tz())
    month_key = now_local.strftime("%Y-%m")
    month_start = now_local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    end = now_local.astimezone(timezone.utc).isoformat()

    try:
        sums = await compute_monthly_sums(ENERGY_ENTITY_IDS, month_start.astimezone(timezone.utc).isoformat(), end)
    except Exception as e:
        print(f"Current-month refresh: ERROR fetching HA history: {e}")
        return

    # Build the row for the current month, preserving grid events and export income.
    conn = get_db()
    try:
        ts = now_ts()
        existing = conn.execute(
            "SELECT grid_events, export_income FROM monthly_data WHERE month = ?", (month_key,)
        ).fetchone()
        grid_events = existing["grid_events"] if existing else 0
        export_income = existing["export_income"] if existing else 0

        row = {"month": month_key, "year": int(month_key.split("-")[0]),
               "grid_events": grid_events, "export_income": export_income}
        for db_field, entity in MONTH_FIELD_MAP.items():
            row[db_field] = sums.get(entity, {}).get(month_key, 0)

        conn.execute("""
            INSERT OR REPLACE INTO monthly_data
            (month, year, generated, exported, grid_import, bat_charge, bat_discharge, load, grid_events, export_income, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            row["month"], row["year"], row["generated"], row["exported"],
            row["grid_import"], row["bat_charge"], row["bat_discharge"], row["load"],
            row["grid_events"], row["export_income"], ts
        ))
        conn.commit()
        print(f"Current-month refresh: updated {month_key}")
    finally:
        conn.close()


async def monthly_refresh_loop():
    """Background task: refresh the in-flight month every 30 minutes, then rebuild
    the per-half-hour export slots + income from HA history."""
    while True:
        await asyncio.sleep(CURRENT_MONTH_REFRESH_INTERVAL_SECS)
        try:
            await run_current_month_refresh()
        except Exception as e:
            print(f"Current-month refresh: ERROR {e}")
        try:
            await repair_current_month_export()
        except Exception as e:
            print(f"Export-income repair: ERROR {e}")


async def daily_sync_loop():
    """Background task: run the HA sync once a day, overnight (~02:30 local).

    Uses HA's configured timezone so the run time lands in the user's local night.
    The first run is deferred to the next scheduled time (not immediately on start).
    """
    tz = local_tz()
    while True:
        now_local = datetime.now(tz)
        target = now_local.replace(hour=2, minute=30, second=0, microsecond=0)
        if target <= now_local:
            target += timedelta(days=1)
        delay = (target - now_local).total_seconds()
        print(f"Daily HA sync: next run in {delay/3600:.1f} h (at {target.isoformat()})")
        await asyncio.sleep(delay)
        try:
            await run_daily_ha_sync()
        except Exception as e:
            print(f"Daily HA sync: ERROR: {e}")


@app.get("/api/ha/monthly")
async def ha_monthly(
    entity_ids: str,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None
):
    """
    Compute monthly energy totals from HA history using daily-max method.
    Fox ESS sensors are total_increasing (lifetime cumulative).
    Daily max of raw history per day -> sum daily maxes per month.
    
    Query params:
    - entity_ids: comma-separated list (e.g., "sensor.foo,sensor.bar")
    - start_time: ISO datetime (default: 1 year ago)
    - end_time: ISO datetime (default: now)
    """
    ids = [e.strip() for e in entity_ids.split(",")]
    end = end_time or datetime.now(timezone.utc).isoformat()
    start = start_time or (datetime.now(timezone.utc).replace(year=datetime.now().year - 1)).isoformat()
    return await compute_monthly_sums(ids, start, end)


@app.get("/api/ha/history/monthly")
async def ha_history_monthly(
    entities: str,
    start: Optional[str] = None,
    end: Optional[str] = None
):
    """
    Alias for /api/ha/monthly with different parameter names for frontend compatibility.
    Query params:
    - entities: comma-separated list
    - start: ISO datetime
    - end: ISO datetime
    """
    return await ha_monthly(entity_ids=entities, start_time=start, end_time=end)


# =============================================================================
# Static Files (Frontend)
# =============================================================================

STATIC_DIR = Path(__file__).parent / "static"

# Ensure the browser revalidates static assets on every load (so ES-module
# sub-imports like ./views/*.js are never stuck on an old cached copy after an
# update). Combined with the ?v= cache-busting query on the entry assets.
@app.middleware("http")
async def add_no_cache_header(request: Request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response

# Serve the frontend + all its referenced assets (index.html, /js/*, /styles.css,
# /theme.js, ...) directly from the static dir at the root path. html=True serves
# index.html for "/" and for SPA-friendly subpaths. This MUST be mounted AFTER all
# the /api/* and /health routes above so they take precedence.
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static_root")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8099)
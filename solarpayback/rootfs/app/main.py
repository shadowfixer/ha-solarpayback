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
from datetime import datetime, timezone
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

        conn.commit()
    finally:
        conn.close()


def now_ts() -> int:
    return int(datetime.now(timezone.utc).timestamp())


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
        try:
            with open(SUPERVISOR_TOKEN_PATH, "r") as f:
                self.token = f.read().strip()
            print(f"HA Client: Loaded supervisor token (length: {len(self.token)})")
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
        query = "&".join(f"{k}={v}" for k, v in params.items())
        return await self.request("GET", f"/history/period?{query}")

    async def get_statistics(self, entity_ids: List[str], start_time: str, end_time: str) -> dict:
        params = {
            "statistic_ids": entity_ids,
            "start_time": start_time,
            "end_time": end_time,
        }
        query = "&".join(f"{k}={v}" for k, v in params.items())
        return await self.request("GET", f"/statistics?{query}")


ha_client = HAClient()


# =============================================================================
# Pydantic Models
# =============================================================================

class SettingsModel(BaseModel):
    systemCost: Optional[str] = None
    installDate: Optional[str] = None
    mcsAnnual: Optional[str] = None
    capacity: Optional[str] = None
    haUrl: Optional[str] = None
    haToken: Optional[str] = None
    entityMap: Optional[Dict[str, str]] = None


class MonthlyDataModel(BaseModel):
    month: str
    generated: float = 0
    exported: float = 0
    gridImport: float = 0
    batCharge: float = 0
    batDischarge: float = 0
    load: float = 0
    gridEvents: float = 0


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
    yield
    # Shutdown
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
                raise HTTPException(status_code=404, detail="Month not found")
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
            (month, year, generated, exported, grid_import, bat_charge, bat_discharge, load, grid_events, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    
    # Fetch raw history from HA
    history = await ha_client.get_history(ids, start, end, None)
    
    # Compute daily max per entity, then monthly sums
    monthly = {}
    
    for entity_history in history:
        if not entity_history or not entity_history[0].get("entity_id"):
            continue
           
        entity_id = entity_history[0]["entity_id"]
        daily_max = {}
        
        for point in entity_history:
            state = point.get("state")
            if state is None:
                continue
            try:
                val = float(state)
            except (ValueError, TypeError):
                continue
            
            # Parse timestamp to local calendar day
            last_changed = point.get("last_changed")
            if not last_changed:
                continue
            dt = datetime.fromisoformat(last_changed.replace("Z", "+00:00"))
            day_key = dt.strftime("%Y-%m-%d")
            
            # Track max state per day
            if day_key not in daily_max or val > daily_max[day_key]:
                daily_max[day_key] = val
       
        # Sum daily maxes by month
        month_map = {}
        for day_key, max_val in daily_max.items():
            month_key = day_key[:7]  # "YYYY-MM"
            month_map[month_key] = month_map.get(month_key, 0) + max_val
       
        monthly[entity_id] = month_map
   
    return monthly


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

@app.get("/")
async def root():
    return FileResponse(STATIC_DIR / "index.html")


# Mount static files at /static (but also serve root from static)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# Catch-all for SPA routing (hash-based, so index.html handles it)
@app.get("/{path:path}")
async def catch_all(path: str):
    # If it's an API path, 404
    if path.startswith("api/"):
        raise HTTPException(status_code=404, detail="API endpoint not found")
    # Otherwise serve index.html (hash routing handles the rest)
    return FileResponse(STATIC_DIR / "index.html")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8099)
# HA SunBack Add-on — Design Document

## Overview
Convert the existing static ES-module web app (`/config/www/ha-sunback/`) into a proper **Home Assistant Add-on** with:
- **Ingress** — Served via HA's ingress (auth handled by HA, works on all browsers, no per-browser tokens)
- **Server-side SQLite** — Persistent `/data/ha-sunback.db` for settings, monthly data, tariffs, grid events
- **Backend REST API** — Proxies HA calls using Supervisor token (injected at `/var/run/secrets/hassio-token`), so browsers need NO token

---

## 1. Add-on Structure (HA Convention)

```
ha-sunback/
├── config.yaml              # Add-on manifest
├── Dockerfile               # Alpine + Python 3.11
├── rootfs/
│   ├── run.sh               # Entrypoint (starts uvicorn)
│   └── app/
│       ├── main.py          # FastAPI app + routes
│       ├── db.py            # SQLite schema + helpers
│       ├── ha_client.py     # Server-side HA REST client (uses supervisor token)
│       └── static/          # Frontend files (index.html, css, js, assets)
│           ├── index.html
│           ├── styles.css
│           ├── theme.js
│           └── js/
│               ├── app.js
│               ├── api.js        # NEW: calls /api/* (replaces ha-api.js)
│               ├── calc.js       # unchanged
│               ├── storage.js    # REPLACED: now calls /api/* (no IndexedDB)
│               ├── utils.js      # unchanged
│               └── views/
│                   ├── overview.js
│                   ├── live.js
│                   ├── history.js
│                   ├── payback.js
│                   └── settings.js
├── build.yaml               # Multi-arch build config
└── README.md                # Install instructions
```

---

## 2. How Ingress + Backend + SQLite Work Together

```
┌─────────────────────────────────────────────────────────────────┐
│                    Home Assistant OS                            │
│  ┌──────────────┐    ┌──────────────────────────────────────┐  │
│  │   Ingress    │───▶│         ha-sunback Add-on            │  │
│  │  (HA Auth)   │    │  ┌─────────────┐  ┌───────────────┐  │  │
│  └──────────────┘    │  │   FastAPI   │  │   SQLite      │  │  │
│        │             │  │  (port 8099)│  │  /data/       │  │  │
│        │             │  │             │  │  ha-sunback.db│  │  │
│        ▼             │  │  /api/*     │  └───────────────┘  │  │
│  ┌──────────────┐    │  │  /static/*  │         ▲           │  │
│  │   Browser    │◀───│  └──────┬──────┘         │           │  │
│  │  (no token)  │    │         │                │           │  │
│  └──────────────┘    │         ▼                │           │  │
│                      │  ┌─────────────┐         │           │  │
│                      │  │  HA Client  │─────────┘           │  │
│                      │  │ (supervisor │    HA REST API       │  │
│                      │  │  token)     │    (internal)        │  │
│                      │  └─────────────┘                     │  │
│                      └──────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

**Key points:**
- **Ingress** handles TLS + HA authentication. The browser gets a session cookie from HA; no token in the browser.
- **Backend** reads the Supervisor token from `/var/run/secrets/hassio-token` (injected by HA when `homeassistant_api: true`).
- **SQLite** lives at `/data/ha-sunback.db` — HA mounts `/data` persistently across add-on updates/restarts.
- **All HA calls** (entity states, history, statistics) go through the backend. The browser never talks to HA directly.

---

## 3. SQLite Schema

```sql
-- Settings (key/value)
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Monthly energy data (one row per month "YYYY-MM")
CREATE TABLE monthly_data (
    month TEXT PRIMARY KEY,          -- "2026-11"
    year INTEGER NOT NULL,
    generated REAL DEFAULT 0,        -- kWh
    exported REAL DEFAULT 0,
    grid_import REAL DEFAULT 0,
    bat_charge REAL DEFAULT 0,
    bat_discharge REAL DEFAULT 0,
    load REAL DEFAULT 0,
    grid_events REAL DEFAULT 0,      -- manual £ entries
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Tariff history (rate changes over time)
CREATE TABLE tariff_history (
    id TEXT PRIMARY KEY,             -- UUID
    month TEXT NOT NULL,             -- "YYYY-MM" (start month)
    day REAL NOT NULL,               -- p/kWh
    night REAL NOT NULL DEFAULT 0,   -- p/kWh
    export REAL NOT NULL DEFAULT 0,  -- p/kWh
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE INDEX idx_tariff_month ON tariff_history(month);

-- Grid events (axle.energy payments)
CREATE TABLE grid_events (
    id TEXT PRIMARY KEY,             -- UUID
    date TEXT NOT NULL,              -- "YYYY-MM-DD"
    amount REAL NOT NULL,            -- £
    notes TEXT DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE INDEX idx_grid_date ON grid_events(date);
```

---

## 4. REST Endpoints (all under `/api`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/settings` | Get all settings |
| PUT | `/api/settings` | Update settings (full replace) |
| GET | `/api/monthly-data` | List all months |
| GET | `/api/monthly-data?month=2026-11` | Get single month |
| POST | `/api/monthly-data` | Save/replace month |
| DELETE | `/api/monthly-data?month=2026-11` | Delete month |
| GET | `/api/tariffs` | List all tariffs (sorted by month) |
| POST | `/api/tariffs` | Add tariff (returns id) |
| DELETE | `/api/tariffs/:id` | Delete tariff |
| GET | `/api/grid-events` | List all events (sorted by date) |
| GET | `/api/grid-events?month=2026-11` | Events for a month |
| POST | `/api/grid-events` | Add event (returns id) |
| DELETE | `/api/grid-events/:id` | Delete event |
| GET | `/api/ha/state?entity_id=...` | Proxy HA `/api/states/<entity>` |
| GET | `/api/ha/states` | Proxy HA `/api/states` |
| GET | `/api/ha/history` | Proxy HA `/api/history/period` (query: entity_id, start_time, end_time, period) |
| GET | `/api/ha/stats` | Proxy HA `/api/statistics` (for long-term stats) |

**All endpoints are relative to the add-on's ingress URL.**  
Example: `https://<ingress-host>/api/settings` — browser sends only cookies, no Bearer token.

---

## 5. Server-Side HA Authentication

- HA injects a **Supervisor token** at `/var/run/secrets/hassio-token` when the add-on declares `homeassistant_api: true` in `config.yaml`.
- The backend reads this token at startup and uses it as `Authorization: Bearer <token>` for all HA REST calls.
- The Supervisor token has full HA API access (scoped to the add-on's permissions).
- **No token ever reaches the browser.** The browser authenticates via HA's ingress session cookie.

---

## 6. Frontend Migration Plan

| Current File | Change |
|--------------|--------|
| `index.html` | Remove HA Connection form section; keep all other views identical |
| `theme.js` | Unchanged |
| `styles.css` | Unchanged |
| `js/ha-api.js` | **DELETE** — replace with `js/api.js` that calls `/api/*` |
| `js/storage.js` | **REPLACE** — new version calls `/api/*` (no IndexedDB) |
| `js/app.js` | Update imports; remove `haApi.init()` + HA connection logic |
| `js/views/settings.js` | Remove HA form + entity mapping (backend handles entities); keep tariff/grid event forms |
| `js/views/overview.js` | Replace `refreshFromHA()` with call to `/api/ha/history` via new API |
| `js/views/live.js` | Replace WebSocket with polling via `/api/ha/state` (or keep WS if we proxy it — scaffold for now) |
| `js/views/history.js` | Unchanged (uses Calc + storage) |
| `js/views/payback.js` | Unchanged |
| `js/calc.js` | Unchanged |
| `js/utils.js` | Unchanged |

---

## 7. Install Steps for James (HA OS 2026.11.2)

1. **Copy add-on to HA** (via Samba/SSH/File Editor):
   ```
   /addons/ha_sunback/  <-- entire folder contents
   ```
2. **Reload add-ons**: Settings → Add-ons → ⋮ → "Reload"
3. **Install "HA SunBack"** from Local add-ons list
4. **Start add-on** (set "Start on boot" = On)
5. **Open via Ingress**: Click "Open Web UI" in add-on panel, or navigate to `https://homeassistant.local:8123/ingress/ha_sunback/`
6. **Configure in Settings view**:
   - System cost / install date / MCS estimate (pre-filled from defaults)
   - Tariff history (day/night/export rates per month)
   - Grid events (axle.energy payments)
7. **No HA token/URL needed** — backend uses Supervisor token automatically.

---

## 8. Build Status Tracking

| Component | Status |
|-----------|--------|
| `config.yaml` manifest | ✅ Scaffolded |
| `Dockerfile` + `rootfs/run.sh` | ✅ Scaffolded |
| SQLite schema (`db.py`) | ✅ Scaffolded |
| FastAPI backend (`main.py`, `ha_client.py`) | ✅ Scaffolded |
| REST endpoints (settings, monthly, tariffs, grid-events) | ✅ Scaffolded |
| HA proxy endpoints (`/api/ha/*`) | ✅ Scaffolded |
| Frontend `api.js` (replaces `ha-api.js`) | ✅ Scaffolded |
| Frontend `storage.js` (server-backed) | ✅ Scaffolded |
| Frontend `app.js` updates | ✅ Scaffolded |
| Settings view (removed HA form) | ✅ Scaffolded |
| Overview view (HA sync via backend) | ✅ Scaffolded |
| Live view (polling fallback) | ✅ Scaffolded |
| Multi-arch `build.yaml` | ✅ Scaffolded |
| README with exact install steps | ✅ Scaffolded |
| **Git commits** | 🔄 In progress |

---

## 9. What Is COMPLETE vs SCAFFOLDED

| Item | Complete? | Notes |
|------|-----------|-------|
| Add-on manifest (`config.yaml`) | ✅ Complete | Validated structure, ingress, homeassistant_api |
| Dockerfile + run.sh | ✅ Complete | Alpine 3.20, Python 3.11, uvicorn |
| SQLite schema + `db.py` | ✅ Complete | All 4 tables, indexes, helpers |
| FastAPI app + all REST endpoints | ✅ Complete | Settings, monthly, tariffs, grid-events, HA proxy |
| HA client (supervisor token) | ✅ Complete | Reads `/var/run/secrets/hassio-token` |
| Frontend `api.js` | ✅ Complete | Fetch wrapper for all `/api/*` endpoints |
| Frontend `storage.js` | ✅ Complete | Server-backed, same interface as IndexedDB version |
| Frontend `app.js` migration | ✅ Complete | No HA init, uses new API |
| Settings view (no HA form) | ✅ Complete | Removed HA connection + entity mapping |
| Overview view (HA sync) | ✅ Complete | Calls backend `/api/ha/history` |
| Live view (polling) | ✅ Scaffolded | Polls `/api/ha/state` every 10s; WebSocket proxy TBD |
| History / Payback views | ✅ Complete | Unchanged, work via new storage |
| Build config (`build.yaml`) | ✅ Complete | aarch64/amd64/armv7 |
| Install README | ✅ Complete | Step-by-step for HA OS |
| **Tested on real HA OS** | ❌ No | Cannot install/test on user's HA; scaffold only |

---

## 10. Known Gaps / Future Work

1. **WebSocket proxy** — Live view currently falls back to polling. A proper `/api/ha/ws` proxy would forward HA's WebSocket through the add-on for true real-time updates.
2. **Entity auto-detection** — Removed from frontend; could add a backend endpoint `/api/ha/entities/foxess` that returns detected entities.
3. **Long-term statistics** — `/api/ha/stats` proxies HA's `/api/statistics` but frontend doesn't use it yet (overview still uses daily-max from history).
4. **Backup/restore** — Add-on doesn't yet implement HA's backup API; `/data/ha-sunback.db` is included in HA full backups automatically.
5. **Rate limiting / auth hardening** — Ingress handles auth; no additional rate limiting added.

---

## 11. Versioning

- Add-on version: `1.0.0` (set in `config.yaml`)
- Git tag: `v1.0.0-addon` (to be created after final commit)
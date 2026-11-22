# HA SolarPayBack — Local Solar Payback Dashboard

A self-hosted, privacy-first solar payback dashboard for Home Assistant. Styled like [SolarPayBack.co.uk](https://sunback.co.uk) but runs entirely locally — no cloud, no accounts, no tracking.

## Features

- **Auto-pulls from Home Assistant** — Fox ESS Cloud (generation, export, battery, grid, load) + Octopus Energy (import/export rates)
- **Payback calculation** — Solar used, export income, cheap-rate battery charging, axle.energy grid events
- **Manual entries** — Tariff history (rate changes over time), grid event payments (date + £)
- **Monthly history** — Auto-computed from HA history API, with MCS estimate comparison
- **Live view** — Real-time power flow via HA WebSocket (PV, battery, grid, house load)
- **Export** — PDF report, Excel (.xlsx), CSV
- **Light/dark theme** — Follows system preference, manual toggle, persists in localStorage
- **Responsive** — Works on desktop, tablet, mobile

## Quick Start

### Install as a Home Assistant add-on

HA SolarPayBack is distributed as a **Home Assistant add-on** (served via HA's ingress,
with a server-side SQLite store — no per-browser token required).

1. **Prerequisites:** Home Assistant with the **Fox ESS Cloud** and **Octopus Energy**
   integrations configured.
2. **Install:** follow [`INSTALL.md`](INSTALL.md) — add the repo to **Add-on Store →
   Repositories**, install, start. It appears in the sidebar.
3. **Open it** in any browser you're logged into HA with — no token to enter.
4. In **Settings**, set your **system cost**, **install date** and **MCS estimate**, then
   add your **tariff history** and **grid events** (axle.energy payments) as they occur.

> No HA URL or long-lived token is needed in the app — the add-on backend authenticates to
> Home Assistant server-side using the Supervisor token.

## Entity Mapping

The dashboard auto-detects Fox ESS entities from the `garage_foxess_` prefix. If your entities differ, override them in **Settings → Entity Mapping**:

| Key | Default Entity |
|-----|----------------|
| `pv_power` | `sensor.garage_foxess_pv_power` |
| `energy_generated` | `sensor.garage_foxess_energy_generated` |
| `feedin` | `sensor.garage_foxess_feedin` |
| `grid_consumption` | `sensor.garage_foxess_grid_consumption` |
| `bat_charge` | `sensor.garage_foxess_bat_charge` |
| `bat_discharge` | `sensor.garage_foxess_bat_discharge` |
| `bat_soc` | `sensor.garage_foxess_bat_soc` |
| `load` | `sensor.garage_foxess_load` |
| `inverter` | `sensor.garage_foxess_inverter` |

## Payback Calculation

Matches SolarPayBack's methodology:

| Component | Formula |
|-----------|---------|
| **Solar used** | `Generated - Exported` × Day rate |
| **Export income** | `Exported` × Export rate |
| **Battery saving** | `Bat charge` × (Day rate × 90% − Night rate) |
| **Grid events** | Manual entries (date + £) |
| **Total saved** | Sum of above |

**Payback date** — Projected using UK seasonal profile (winter months weighted lower).

## Data Flow

```
Add-on backend → HA REST API (Supervisor token, server-side) → SQLite (/data/ha-solarpayback.db)
Frontend → Add-on /api/* (ingress) → Dashboard
Live view → polls add-on /api/ha/* every ~20s
Manual entries (tariff, grid events) → SQLite (shared across all browsers/devices)
All calculations → Client-side JS → Render
```

No per-browser token; the add-on backend authenticates to Home Assistant server-side.
Data is stored in the add-on's SQLite database (persists across restarts, included in HA backups).

## Project Structure

```
ha-solarpayback/
├── README.md            # This file
├── INSTALL.md           # Full install instructions
├── DESIGN.md            # Architecture overview
└── solarpayback/        # The add-on directory (HA discovers add-ons in subdirs)
    ├── config.yaml      # Add-on manifest (slug ha_solarpayback, ingress)
    ├── Dockerfile       # Alpine + Python + FastAPI/uvicorn
    └── rootfs/app/
        ├── run.sh       # Entrypoint (starts uvicorn, waits for Supervisor token)
        ├── main.py      # FastAPI backend: SQLite + HA REST proxy
        └── static/      # Frontend (index.html, css, js/views/*) — calls /api/*
```

## Development

No build step required — plain ES6 modules. Open `index.html` via a local server for CORS:

```bash
# Python
python3 -m http.server 8000

# Node
npx serve .

# Then open http://localhost:8000
```

## Browser Support

- Chrome/Edge 90+, Firefox 88+, Safari 15+
- Requires: ES6 modules, CSS custom properties
- No IndexedDB/WebSocket dependency — data is served from the add-on's backend.

## Privacy

- **Zero tracking** — No analytics, no external requests except to your HA
- **Local storage only** — Token, settings, monthly data, tariff history, grid events all in your browser's IndexedDB/localStorage
- **Self-hosted** — Runs on your infrastructure

## License

MIT — Free for personal use.

---

**Based on the design of [SolarPayBack.co.uk](https://sunback.co.uk) — rebuilt for Home Assistant integration.**
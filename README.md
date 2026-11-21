# HA SunBack — Local Solar Payback Dashboard

A self-hosted, privacy-first solar payback dashboard for Home Assistant. Styled like [SunBack.co.uk](https://sunback.co.uk) but runs entirely locally — no cloud, no accounts, no tracking.

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

### 1. Prerequisites

- Home Assistant with **recorder** enabled (for historical data)
- **Fox ESS Cloud** integration configured
- **Octopus Energy** integration configured
- **Long-lived access token** (Settings → Profile → Long-Lived Access Tokens)

### 2. Deploy

**Option A: Serve from HA `www/` folder (recommended)**

```bash
# Copy to HA config/www/ha-sunback/
cp -r ha-sunback/* /config/www/ha-sunback/

# Access at: http://homeassistant.local:8123/local/ha-sunback/
```

**Option B: Any static host**

```bash
# Netlify, Vercel, GitHub Pages, Cloudflare Pages, etc.
# Just upload the folder contents
```

**Option C: Local file (for testing)**

```bash
# Just open index.html in a browser
# Note: HA API calls require CORS - use Option A for full functionality
```

### 3. Configure

1. Open the dashboard
2. Go to **Settings** (gear icon)
3. Enter your **HA URL** (e.g., `http://homeassistant.local:8123`)
4. Paste your **Long-Lived Access Token**
5. Click **Test & Save Connection**
6. System config is pre-filled (£9,150, 2026-11-13, 6,390 kWh/yr) — adjust if needed
7. Add your **tariff history** (day/night/export rates per month)
8. Add **grid events** (axle.energy payments) as they occur

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

Matches SunBack's methodology:

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
HA REST API (historical) → Monthly aggregates → IndexedDB
HA WebSocket (live) → Real-time updates → Dashboard
Manual entries (tariff, grid events) → IndexedDB
All calculations → Client-side JS → Render
```

**No data leaves your browser** except to your Home Assistant instance.

## Project Structure

```
ha-sunback/
├── index.html          # Main entry, hash routing
├── styles.css          # SunBack design tokens + components
├── theme.js            # Light/dark toggle
├── js/
│   ├── app.js          # Main init, routing, state
│   ├── ha-api.js       # HA REST + WebSocket client
│   ├── calc.js         # Payback calculations (pure functions)
│   ├── storage.js      # IndexedDB wrapper
│   ├── utils.js        # Date, number formatting
│   └── views/
│       ├── overview.js # Panels grid, payback summary
│       ├── live.js     # Real-time power flow
│       ├── history.js  # Monthly/yearly tables + charts
│       └── settings.js # Config, tariff history, grid events
└── assets/
    └── img/            # Placeholder SVGs
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

- Chrome/Edge 90+
- Firefox 88+
- Safari 15+
- Requires: IndexedDB, WebSocket, ES6 modules, CSS custom properties

## Privacy

- **Zero tracking** — No analytics, no external requests except to your HA
- **Local storage only** — Token, settings, monthly data, tariff history, grid events all in your browser's IndexedDB/localStorage
- **Self-hosted** — Runs on your infrastructure

## License

MIT — Free for personal use.

---

**Based on the design of [SunBack.co.uk](https://sunback.co.uk) — rebuilt for Home Assistant integration.**
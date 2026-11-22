# HA SolarPayBack — Local Solar Payback Dashboard

**Goal**: A local, self-hosted dashboard (plain HTML/CSS/JS) that pulls solar/inverter data from Home Assistant (Fox ESS Cloud + Octopus Energy) and calculates payback — no cloud, no auth, no signup. Styled like SolarPayBack.

---

## Data Sources

| Source | Purpose | Access |
|--------|---------|--------|
| **Home Assistant** | All live + historical data | REST API + WebSocket (long-lived token) |
| **Fox ESS Cloud (via HA)** | Generation, export, battery, load | `sensor.pvenergytotal`, `sensor.pv_power`, `sensor.solar_power`, `sensor.feedin` (TBD), `sensor.grid_consumption` (TBD), battery sensors |
| **Octopus Energy (via HA)** | Import rates (day/night), export rate (SEG), off-peak flag | `sensor.current_rate_electricity_...`, `sensor.next_rate_electricity_...`, `sensor.off_peak_electricity_...`, export rate entity (when available) |
| **Manual entry** | System cost, install date, MCS estimate, tariff history, axle.energy grid event payments | Local storage (IndexedDB/localStorage) |

---

## Fox ESS Entity IDs (from user)

| Metric | Entity ID(s) |
|--------|--------------|
| Total generation today | `sensor.pvenergytotal` (4.6 kWh) |
| Total generation power now | `sensor.pv_power` / `sensor.solar_power` (0 W) |
| Per-string | `sensor.pv1_current`, `sensor.pv1_power`, `sensor.pv1_volt` … through `pv6` |
| Solar (state) | `sensor.solar` (3.6) |

**Still need from user**:
- Export/Feed-in entity ID
- Grid consumption/import entity ID
- Battery charge/discharge energy + power entity IDs
- Battery SoC entity ID
- Load/house consumption entity IDs

---

## Octopus Entity IDs (from user)

| Metric | Entity ID (pattern) |
|--------|---------------------|
| Current rate (live) | `sensor.current_rate_electricity_<serial>_<mpan>` |
| Next rate | `sensor.next_rate_electricity_<serial>_<mpan>` |
| Previous rate | `sensor.previous_rate_electricity_<serial>_<mpan>` |
| Off-peak flag | `sensor.off_peak_electricity_<serial>_<mpan>` |
| Accumulative consumption | `sensor.current_accumulative_consumption_electricity_...` |
| Accumulative cost | `sensor.current_accumulative_cost_electricity_...` |
| Current demand | `sensor.current_demand_electricity_...` |
| Standing charge | `sensor.current_standing_charge_electricity_...` |

**Export rate**: Not yet configured — will pull from Octopus when SEG tariff is added.

---

## User Config (provided)

| Setting | Value |
|---------|-------|
| System cost | £0 (set in Settings) |
| Install date | — (set in Settings) |
| MCS estimated annual generation | (set in Settings) |
| HA URL | `http://homeassistant.local:8123` |
| HA Token | (provided, stored locally) |
| Export rate | TBD (from Octopus SEG) |
| Night rate | ~7.62p/kWh (off-peak) |
| Day rate | ~29.82p/kWh (peak) |
| Long-term statistics | **Need confirmation** |

---

## Features to Build

### 1. Dashboard (single page, hash-routed views)
- **Overview** — panels grid (1% per cell), payback £, % paid back, estimated payback date
- **Live** — real-time power flow (generation, battery, grid, load) via HA WebSocket
- **History** — monthly table + chart (generated, exported, used, saved, vs estimate)
- **Settings** — system config, tariff history (rate changes), axle.energy grid events, export settings

### 2. Payback Calculation (match SolarPayBack logic)
- **Solar used** = Generated − Exported, valued at day rate
- **Export income** = Exported × export rate (only for months SEG is active)
- **Cheap-rate battery saving** = (Day rate × 90% − Night rate) × kWh charged on night rate
- **Grid events** = Manual entries (date + £), added to monthly total
- **Payback date** = Projected from logged months + UK seasonal profile

### 3. Data Flow
```
HA REST API (historical) → Monthly aggregates → Local IndexedDB
HA WebSocket (live) → Real-time panel updates
Manual entries (tariff changes, grid events) → Local IndexedDB
All calculations → Client-side JS → Dashboard render
```

### 4. Tariff History
- User adds rate changes: start month, day rate, night rate, export rate
- Earlier months keep old rates
- Bonus first-year export rate supported

### 5. Axle Energy Grid Events
- Manual "Add grid event" → date + earnings (£)
- Appears in monthly breakdown as "Grid events"
- Included in payback total

### 6. Export
- PDF report (dashboard summary)
- Excel (.xlsx) — summary + monthly log
- CSV — monthly log

---

## Technical Stack

| Layer | Choice |
|-------|--------|
| **Frontend** | Plain HTML/CSS/JS (ES6 modules), no framework |
| **Styling** | CSS custom properties (SolarPayBack design tokens), Instrument Sans |
| **Charts** | Simple SVG/Canvas (no heavy library) or Chart.js via CDN if needed |
| **Storage** | IndexedDB (idb wrapper) for monthly data, tariff history, grid events, settings |
| **HA API** | REST for history, WebSocket for live updates |
| **Auth** | Long-lived token in `Authorization: Bearer` header (stored in localStorage) |
| **Hosting** | Static files — serve from HA `www/` folder, or any static host |

---

## Project Structure

```
ha-solarpayback/
├── index.html              # Main entry, hash routing
├── styles.css              # SolarPayBack design tokens + components
├── theme.js                # Light/dark toggle (localStorage + prefers-color-scheme)
├── js/
│   ├── app.js              # Main app init, routing, state
│   ├── ha-api.js           # HA REST + WebSocket client
│   ├── calc.js             # Payback calculations (pure functions)
│   ├── storage.js          # IndexedDB wrapper (idb)
│   ├── charts.js           # Simple SVG charts
│   ├── views/
│   │   ├── overview.js     # Panels grid, payback summary
│   │   ├── live.js         # Real-time power flow
│   │   ├── history.js      # Monthly table + charts
│   │   └── settings.js     # Config, tariff history, grid events
│   └── utils.js            # Date, number formatting, etc.
├── assets/
│   ├── fonts/              # Instrument Sans WOFF2 (or Google Fonts)
│   └── img/                # Placeholder SVGs
└── README.md               # Setup instructions
```

---

## Next Steps

1. **Confirm long-term statistics enabled** — needed for automatic monthly history
2. **Get missing Fox ESS entity IDs** (export, grid import, battery, load)
3. **Create project files** — start with `index.html`, `styles.css`, `theme.js`, `ha-api.js`
4. **Test HA connection** — verify token + entity IDs work
5. **Build views incrementally** — overview → history → settings → live
6. **Add manual entry forms** — tariff changes, grid events
7. **Polish & export features**

---

## Questions for User

1. **Long-term statistics enabled?** (Developer Tools → Statistics — do you see hourly/daily/monthly data for `sensor.pvenergytotal`, `sensor.feedin`, etc.?)
2. **Missing Fox ESS entity IDs** — check Settings → Devices → Fox ESS Cloud → Entities for:
   - Export/Feed-in total today
   - Grid import/consumption today
   - Battery charge energy today, discharge energy today
   - Battery charge power, discharge power
   - Battery SoC
   - House load energy today, load power now
3. **Export rate** — when SEG is active, what entity will Octopus expose? (Or we can add a manual override in Settings)
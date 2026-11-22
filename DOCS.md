# HA SolarPayBack

A self-hosted solar payback dashboard for Home Assistant — SolarPayBack-style UI
served via HA **ingress**, with a server-side SQLite database and a backend that
authenticates to Home Assistant using the Supervisor token.

## Getting started

1. Open the app from the sidebar (it appears automatically under Apps/Add-ons).
2. Go to **Settings → System Configuration** and set:
   - **System Cost (£)** — what your solar system cost
   - **Install Date** — when your solar was installed
   - **MCS Estimated Annual Generation (kWh/year)** — your installer's estimate
   - **Export Start Date** — the date you start being **paid** for export (leave
     blank if you don't have an export contract yet — until then exported power
     earns £0, and only your manual grid events / battery / solar-saved count).
3. Add **Tariff History** entries (day/night/export rates and their start month).
4. Add **Grid Events** (e.g. axle.energy payments: date + £ amount).
5. On the Overview, the app auto-syncs historical monthly data from HA when the
   database is empty. Use **Settings → Sync Monthly Data from HA** to resync.

## Entity mapping

The dashboard auto-detects Fox ESS sensors from the `garage_foxess_` prefix:
`energy_generated`, `feedin`, `grid_consumption`, `bat_charge`, `bat_discharge`,
`load` (energy totals, whose daily sums are aggregated into monthly figures).

## Data & privacy

- All data is stored locally in the add-on's SQLite database
  (`/data/ha-solarpayback.db`), which persists across restarts and is included in
  Home Assistant backups.
- No cloud, no accounts, no tracking.
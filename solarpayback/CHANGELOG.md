# Changelog

All notable changes to the **HA SolarPayBack** add-on.

## [1.3.1] - 2026-11-26

### Fixed
- **Export income was massively understated** (down to ~£1.13). The per-slot derivation
  assumed the `feedin` sensor was a *lifetime* cumulative meter, but it is actually a
  **per-day cumulative counter that resets to ~0 at midnight UTC**. `_feedin_delta_slots`
  now treats each UTC day as an independent run (subtracting the day's opening baseline),
  so the midnight reset no longer drops almost all of the export energy.
- **Slot total now reconciles to the month's authoritative `exported` figure.** The raw
  per-slot curve is scaled to equal the `exported` kWh stored on `monthly_data`, so the
  per-slot export kWh always sum to the dashboard's monthly number (was previously skewed
  by the reset handling). After this fix, 24–27 Nov rebuilds 56 slots scaling to the
  stored 23.9 kWh → ~£5.26 export income at the blended Agile rate.

### Notes
- The stored monthly `exported` (23.9 kWh for Nov) appears **lower than the raw `feedin`
  counter for 24–27 Nov alone (~45.6 kWh)**. The slot logic now reconciles *to* the
  stored figure as intended; whether that stored figure itself under-counts is tracked
  separately and not altered here.

## [1.3.0] - 2026-11-26

### Added
- **Slot-accurate export income.** Export income is now priced per 30-minute slot:
  each slot's export kWh (delta of the lifetime cumulative feedin meter) is multiplied
  by the Agile export rate logged for that slot, rather than one blended rate applied
  to the whole month. The monthly total is stored on `monthly_data.export_income` and
  used by the dashboard.
- **Export slot log + repair.** New `export_slot_log` table records each half-hour's
  export kWh and rate. `/api/export-rates/repair` (or the auto 30-min / boot task)
  rebuilds the in-flight month's slots from HA history: slots before the **export
  contract start date are priced at £0** (you were not paid for that export); sparse
  gaps before the rate log began use the month's blended average rate. `main.py`
  migrates an existing database idempotently (adds `export_income` column).
- **"This Month" card now splits the saved figure** into **Export Income** and
  **Solar-used value** tiles, so the Agile pay is distinguished from self-consumption
  savings. Card layout widened to a 5-column grid.

### Fixed
- **Battery savings were silently zero.** The server returns snake_case fields
  (`grid_import`, `bat_charge`, `grid_events`, `export_income`) but `calc.js` read
  camelCase, so battery arbitrage was never counted (this is why the Nov "Saved" was
  ~£29 rather than the true ~£42). `calc.js` now normalises the server keys.

### Notes
- Historical months before the rate log began (24 Nov) are blended, not slot-exact;
  accuracy improves month-over-month as the per-slot log accumulates.

## [1.2.1] - 2026-11-24

### Fixed
- **Settings → System Configuration: System Capacity dropped onto its own line** at the
  width the add-on renders inside the HA dashboard. The form's `align-items: end` bottom-aligned
  the short System Capacity field against the tall Export Start Date / Import Price Rise helper
  text, so it visually fell below its intended row. The System Configuration form now
  `align-items: start`, so Row 2 keeps **System Capacity | Export Start Date | Import Price Rise**
  together as intended.
- **Cache-buster bumped to `?v=1.2.1`** — the previous deploy changed the code but not the asset
  query string, so browsers (and HA) kept serving the cached 1.2.0 CSS and the fix appeared not
  to take. Bumping forces a fresh fetch after update.
- **Monthly Breakdown / payback never updated** ("None of these values have changed today"): the
  30-minute current-month refresh and the overnight daily sync both failed with
  `400 Invalid end_time`. The backend built the HA history URL by hand, and the `+` timezone
  separator in ISO timestamps (`…T14:21:17+00:00`) was decoded as a space, so HA rejected
  `end_time`. `get_history`/`get_statistics` now pass params through aiohttp so they are
  properly URL-encoded — the refresh and sync run again, and today's generated/exported energy
  (and therefore payback) updates as before.

## [1.2.0] - 2026-11-24

### Fixed
- **Agile export capture threw a 500** (both when selecting **Agile** and when pressing
  **Capture Now**): `_capture_export_rate_now` called the async HA REST client without
  awaiting it, so it received a coroutine instead of a response and raised
  `AttributeError: 'coroutine' object has no attribute 'get'`. The function is now
  properly async, all three callers (current-rate read, capture endpoint, 30-min
  logger) await it, and the capture works end-to-end.

### Changed
- **Settings → System Configuration laid out 3-per-row** in a deliberate order:
  Row 1 System Cost | Install Date | MCS · Row 2 System Capacity | Export Start Date |
  Import Price Rise · Row 3 Panel Wear + Save. (The previous `auto-fit` grid put four
  fields across, pushing Capacity up and Panel Wear far down.) Mobile stays single-column.

## [1.1.1] - 2026-11-24

### Fixed
- **Background tasks could crash if `tzdata` isn't in the add-on image**: the
  overnight HA sync and the new 30-minute refresh used `ZoneInfo("Europe/London")`,
  which raises `ZoneInfoNotFoundError` on slim images without the timezone database —
  so the daily sync could silently never run. The app now resolves its timezone
  from HA's injected `TZ` env var with a safe UTC fallback, so both background tasks
  run reliably.

## [1.1.0] - 2026-11-24

### Added — Agile export metering (headline)
- **Export Rate Source** selector in Settings with a **Fixed / Agile** radar toggle.
  - **Agile** prices export income at the **live Octopus Agile export rate** from
    Home Assistant (`sensor.…export_current_rate`), captured every 30 minutes; the
    manual per-month tariff is used otherwise (Fixed).
  - Switching to Agile captures the live rate immediately; a **Capture Now** button
    forces a manual read.
- **Raw export-rate log** (`export_rate_log` table): every rate read is stored with
  its timestamp and source. This is the persistent, worst-case-safe record of real
  Agile export prices — so export income can be reconstructed from true rates later,
  under no scenario a monthly average. Backed up with the add-on's SQLite DB.
- **30-minute current-month refresh**: the in-flight month's generated / exported /
  grid / battery / load now update every 30 min from live HA energy sensors, so the
  dashboard reflects "today so far" without churning historical months.
- **Export rate tile** on the Dashboard summary (e.g. `18.53p`), showing the live
  Agile rate when Agile is selected.

### Changed
- **Hourly Dashboard auto-refresh** so the 30-minute backend updates appear without
  a manual reload (timed to the long horizon — not a busy 60s poll).
- Dashboard summary now shows **four** metrics (Paid back / % of cost / Estimated
  payback / Export rate), laid out 4-across on desktop, stacked on mobile.

## [1.0.21] - 2026-11-22

### Reverted
- **Scenario legend pills**: rolled back the equal-width pill styling from 1.0.20 and
  restored the original layout. The "Cautious —y" pill missing its year was not a
  truncation bug — its break-even falls beyond the 25-year window, so it correctly
  shows no date. (1.0.20's equal-width change is withdrawn.)

## [1.0.19] - 2026-11-22

### Added
- **Daily overnight HA sync**: the add-on now automatically pulls historical monthly
  energy data from Home Assistant **every night (~02:30 local)** via a server-side
  background task, so the dashboard refreshes itself without needing a browser tab open.
  The manual **Settings → Sync Monthly Data from HA** button is retained for on-demand
  resyncs. (No more relying on the one-time first-load fill.)

### Changed
- **README + add-on docs**: added a **Screenshots** section (Dashboard, Payback, History,
  Settings) showing sample data, and updated the sync wording across the docs to describe
  the new daily overnight schedule.

## [1.0.18] - 2026-11-22

### Fixed
- **Runway "ahead after 25 years" was wrong**: the break-even loop stopped summing at the
  break-even year, so the 25-year figure only covered savings up to break-even — making a
  faster (optimistic) break-even appear to end up *worse off* than a slower one. The
  analysis now sums all 25 years for the net figure while computing break-even separately,
  so a quicker payback correctly shows a larger amount ahead (e.g. with current data:
  Optimistic 15.8 yrs → £9,089 ahead vs Expected 18.7 yrs → £4,187 ahead).

## [1.0.17] - 2026-11-22

### Fixed
- **Runway scenario buttons were dead after the first re-render**: the header
  Cautious/Expected/Optimistic buttons were bound with per-element listeners that were
  dropped when the view re-rendered, so they stopped working. All scenario selection is
  now handled by a single delegated listener on the container, so the header buttons work
  consistently across re-renders.

### Changed
- **The range-bar legend words are now clickable** (Cautious / Expected / Optimistic pills
  with the break-even year value), matching the header buttons and the dots — clicking
  either a pill or a dot switches the whole Runway scenario.

## [1.0.16] - 2026-11-22

### Changed
- **Runway range bar now uses the same 25-year scale as the year tiles** above it: a
  scenario's dot is positioned at `× / 25` of the width, so each dot sits directly above
  its corresponding Year tile (a 15.8-yr break-even shows over ~year 16, 18.7-yr over
  ~year 19). Previously the bar zoomed to just the three dots, making break-even years
  appear far away from where they actually fall.

## [1.0.15] - 2026-11-22

### Fixed
- **Runway didn't render with little or no historical data**: a variable name typo in the
  low-data baseline path threw a `ReferenceError` and left the Runway box empty. The
  seasonally-adjusted baseline now uses the correct date variable, so the Runway renders
  even with a single month of data.

## [1.0.14] - 2026-11-22

### Added
- **Runway** on the Dashboard, replacing the old (invisible) 100-cell panel grid inside the
  paid-back box. Two tile strips:
  - **How close to payback** — 25 square tiles, each 4% of system cost (actuals): green when
    recovered, a split tile while in progress, amber to recover.
  - **25 years** — 25 numbered portrait tiles (year 1 from install date): amber before the
    break-even year, split tile at break-even, green after; projected years are dashed.
    A **Cautious / Expected / Optimistic** scenario toggle (projection only), a break-even
    readout ("Break-even in X.X years (year N, month)"), a range bar with three scenario dots,
    and hover/focus/tap tooltips. Edge cases handled (no install date / zero cost / no data).
  All payback maths is re-used from Calc/Utils (totalSaved, cumulative, seasonal projection).

### Changed
- Removed the old dashboard panel grid (markup, renderer, and unused CSS/token).

## [1.0.13] - 2026-11-22

### Fixed
- **Saving Settings threw a 422 and silently failed**: Import Price Rise and Panel Wear
  were submitted as numbers, but the backend SettingsModel expects strings (as all other
  settings are). The pydantic reject caused the Save to abort before writing and before
  showing the "System config saved" toast. Both fields are now submitted as strings, so
  the save completes, the values persist, and the confirmation shows.

## [1.0.12] - 2026-11-22

### Fixed
- **Stale browser module cache**: ES-module sub-imports (`./views/*.js`, `calc.js`,
  `storage.js`, `utils.js`) now carry a `?v=` release cache-buster in `app.js`, so a
  freshly-loaded app always fetches the current copies instead of a browser-cached
  older module. This is what made the Import Price Rise / Panel Wear fields appear to
  not save after an update.

## [1.0.11] - 2026-11-22

### Changed
- **Dashboard "Paid back so far" box restored to full width**, but made **shorter** (tighter
  gap, smaller label + value font) so it sits compactly at its natural height.

## [1.0.10] - 2026-11-22

### Fixed
- **Settings now hold for Import Price Rise and Panel Wear**: the backend SettingsModel
  didn't declare these two keys, so `put_settings` silently dropped them and the values
  were never saved to SQLite. Both keys are now accepted and persisted — the values entered
  survive clicking Save.

### Changed
- **Dashboard "Paid back so far" box no longer full-width** — it now sizes to its content
  (max-width, centred, auto-width columns) so the three figures sit at a natural size.

## [1.0.9] - 2026-11-22

### Added
- **Import Price Rise (% per year)** and **Panel Wear (% per year)** settings in System
  Configuration. Both apply to the **payback-date projection only** (compounding annually
  from the install date): price rise inflates the day/night/export rates (pulling payback
  earlier), panel wear degrades generation output (pushing payback later). Historical
  monthly savings are unchanged.

### Changed
- **Live Power Flow**: all four boxes (PV, Battery, Grid, House) now have vertically
  centred text — PV/Grid/House centred, Battery left-justified with its gauge on the right.
- **Dashboard**: removed the inaccurate "Each panel = 1% of the system cost" caption.

## [1.0.8] - 2026-11-22

### Changed
- **Battery box text left-justified** on the Live Power Flow diagram (the SoC gauge
  stays anchored on the right) — the numbers no longer look cramped.

## [1.0.7] - 2026-11-22

### Fixed
- **Live power flow values**: entity mapping switched from fragile substring matches
  to **exact entity IDs**, so the `unknown` `bat_soc1`/`bat_soc2` duplicates and the
  feed-in/grid-consumption pair can no longer corrupt the displayed SoC or grid value.
- **Grid box now shows net import/export** (import minus export) with a correct
  Import/Export label, instead of two sensors fighting over the same value.

### Changed
- **Battery SoC is now a bottom-up, proportional gauge** — an 11% SoC shows an
  almost-empty battery (previously it looked full regardless of the readout).
- **Live flow lines re-routed** so the PV→Grid (export) line no longer crosses
  through the battery box; import and PV→House flows route around the nodes too.

## [1.0.6] - 2026-11-22

### Fixed
- **Changelog tab now appears**: `CHANGELOG.md` moved inside the add-on directory
  (`solarpayback/`) alongside `DOCS.md`. HA detects the changelog/documentation files
  in the add-on folder, not the repo root. Version bumped so HA re-fetches the repo.

## [1.0.5] - 2026-11-22

### Changed
- **Cache-busting asset URLs**: static assets now load with a version query
  (`?v=1.0.5`) and the backend sends `no-cache` for all non-API assets, so after an
  update the new UI appears immediately — no more hard-refresh / cache-clear needed.
  (Your browser caches the frontend files otherwise and can keep showing the old
  version until it re-validates.)

## [1.0.4] - 2026-11-22

### Changed
- **Removed the "Free" badge** from the header — this is a free, self-hosted app;
  the placeholder badge is gone.
- **Live Power Flow diagram 50% larger** — boxes enlarged (180×120) with a bigger
  canvas; the whole Live page was re-spaced to fit them. Diagram now also renders
  immediately on page load (previously blank for 5s while waiting on the refresh
  interval).
- **Wider page container** — the layout now uses up to 960px (was 720px) so tables
  and cards have more room, instead of shrinking the type.
- **History monthly table fits without a horizontal scrollbar** — concise column
  headers combined with the wider container.
- **Cumulative-savings chart legend moved to the bottom** of the chart (was
  top-right where it clipped/overlapped).

## [1.0.3] - 2026-11-22

### Fixed
- **Live Power Flow diagram**: text inside the navy boxes was dark-on-dark
  (unreadable/squished). Values/labels are now light (`--on-panel`) with proper
  contrast against the panel background, and flow arrows use the lighter panel line.
- **Settings form layout**: long labels (e.g. "MCS Estimated Annual Generation")
  no longer truncate; inputs have consistent widths/heights with even gutters, and
  date-input icons are no longer squished.
- **Layout spacing / alignment**: header top-right buttons (theme + plan) aligned and
  not crowded; footer nav items evenly spaced with consistent sizing;
  content no longer clipped behind the bottom nav bar (increased bottom clearance).

## [1.0.2] - 2026-11-22

### Fixed
- **First-sync bootstrap bug**: syncing a month that had never been saved returned an
  HTTP 404 (`Month not found`), which aborted the whole sync — no months were stored,
  so the dashboard stayed at £0 / no data. A missing month now returns an empty shell
  so the sync saves all months correctly.
- Changelog / Documentation tabs now actually appear in the add-on (manifest fields
  enabled in 1.0.1's commit but the version wasn't re-bumped, so HA never re-fetched
  the repo).

> **After updating:** the add-on restarts automatically during the update. If the UI
> looks stale afterwards, Stop then Start the add-on. Your data in `/data` persists.

## [1.0.1] - 2026-11-22

### Added
- **Auto-sync from HA on first load**: the dashboard now pulls historical monthly
  data from Home Assistant automatically (when there is no data yet and an install
  date is set), so it isn't blank on first open.
- **Manual sync button retained**: the "Sync Monthly Data from HA" button in Settings
  is kept for forcing a fresh resync.
- **Export Start Date** setting: export income now only counts from the date you set
  (when you start being paid for export). Until then, exported kWh earns £0 so the
  payback figures reflect only solar-saved, battery savings, and manual grid events
  (e.g. axle payments). When you later add an export contract, set the date and rate
  and the app back-values export income.
- **Version manifest** (`changelog: true`) so HA surfaces this file in the app's
  Changelog tab.

### Fixed
- Supervisor token is now read from the `SUPERVISOR_TOKEN` **environment variable**
  (modern HA injects it there, not as a file) — HA API calls for live data and
  history now work.
- Static assets are served correctly at the root mount, so `/js/*`, `/styles.css`
  and `/theme.js` load as real files instead of `index.html` (broken/blank UI fixed).
- Frontend API base is now **ingress-aware** (derived from the current URL path), so
  API calls reach the add-on instead of Home Assistant's own API when served via
  ingress.

## [1.0.0] - 2026-11-22

### Added
- Initial release of the add-on: SolarPayBack-style dashboard served via HA ingress.
- Server-side SQLite persistence (`/data/ha-solarpayback.db`) shared across all
  browsers — no per-browser token, no re-authentication.
- Backend proxies Home Assistant's REST API using the Supervisor token.
- Live power view (PV, battery, grid, house load) polling the add-on's `/api/ha/*`.
- Monthly history auto-computed from HA history, with MCS estimate comparison.
- Manual entries: tariff history and grid events (axle.energy payments).
- Export to PDF, Excel, and CSV.
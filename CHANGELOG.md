# Changelog

All notable changes to the **HA SolarPayBack** add-on.

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
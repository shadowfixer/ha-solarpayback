# Installing the HA SunBack Add-on

HA SunBack is now a proper **Home Assistant add-on**: it runs on your HA OS, is served
through HA's ingress (so it appears in the sidebar), and handles authentication server-side
using HA's Supervisor token — **no per-browser token, works in every browser you're logged into HA with.**

---

## Before you start

- You need the **whole `ha-sunback` repo folder** on a machine HA can build from.
- The add-on has **not been runtime-tested** yet — it's code-complete and syntax-checked,
  but a fresh install may surface runtime issues. Install on a day you can poke at it.
- This add-on is built **locally from the Dockerfile** (from `/config` or a local repo —
  there is no publicly published container image).

---

## Option A — Install from the `/config` share (simplest, no GitHub needed)

1. **Copy the repo** to your HA config share (the `H:` drive on your PC):
   ```
   H:/ha-sunback/
   ```
   (Copy the whole folder — `config.yaml`, `Dockerfile`, `rootfs/`, etc.)

2. In HA web UI go to **Settings → Add-ons → Add-on Store**.

3. On the **Add-on Store** page, click the **⋮ menu (top-right) → Repositories**,
   then enter the *path on the HA host* to the folder that **contains** `config.yaml`:

   For the config share that is:
   ```
   /config/ha-sunback
   ```
   ⚠️ Note: for a local add-on you're adding the *parent path* `/config/ha-sunback`
   as a repository only if your HA version supports "local add-ons from config".
   If Repositories only accepts URLs on your version, use **Option B**.

   *Simpler alternative if your HA supports it:* place the folder content directly under
   `/config/addons/ha-sunback/` (a folder HA scans for local add-ons) and reload the
   **Add-on Store** page.

4. The **"HA SunBack"** add-on now appears in the store → **Install**.

5. Toggle **Start**. HA builds the image locally from the Dockerfile (takes a minute or two).

6. It appears in your **sidebar** (ingress). Open it — go to **Dashboard**, **Live**,
   **History**, **Payback**, **Settings**.

---

## Option B — Install from a GitHub repo URL

1. Push the `ha-sunback` repo to your own GitHub account (or a private repo) so it's reachable.
2. HA: **Settings → Add-ons → Add-on Store → ⋮ → Repositories** → add your repo URL.
3. Refresh the store → **HA SunBack** → **Install** → **Start**.
4. Sidebar > open it.

> For building to work from a URL, HA needs to reach the repo to get the Dockerfile —
> a **public** repo is easiest. (The `image:` field is omitted in `config.yaml`, so it always
> builds from the downloaded Dockerfile rather than pulling a registry image.)

---

## First-run data

- **Your grid events and tariff history** are stored in the add-on's SQLite DB
  at `/data/ha-sunback.db` (persists across add-on restarts, included in HA backups).
- On first run the app pulls the last 12 months of solar/battery data from HA via the server-side
  proxy to populate Dashboard / History / Payback.
- If you had data in the **old static-app version** (`/config/ha-sunback-data.json` or the
  browser IndexedDB), it is **not** automatically migrated to the add-on DB — you'll re-enter
  grid events / tariffs in Settings. The old files can be deleted once the add-on is working.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "HA SunBack" doesn't appear in the store | Check you added the *parent path/URL* containing `config.yaml`, then reload the Add-on Store page (hard refresh). |
| Build fails / can't pull image | The `image:` field is intentionally omitted (local build). If your HA insists on a registry image, re-add `image: local/ha-sunback-{arch}` — or confirm the Dockerfile is at the repo root. |
| Health check error in logs | The add-on polls `/health`. If the port/interface differs, check `run.sh` / `main.py` are listening on `0.0.0.0:8099` and `ingress_port: 8099` in `config.yaml`. |
| Live view not updating | Live view now **polls** the backend (~20–30 s) instead of a browser WebSocket. If it looks frozen, reload the page. |
| HA data (solar/battery) not loading | Confirm the add-on's Supervisor token is available (`/var/run/secrets/hassio-token`) — requires `homeassistant_api: true` (already set). Check add-on logs for "WARNING: Supervisor token not found". |
| My old static version still opens | The old dashboard/iframe (`/local/ha-sunback-*`) and the `command_line` sensor + `/config/ha-sunback-data.json` are still present. Remove them once the add-on is confirmed working (see Cleanup below). |

---

## Cleanup (after you've confirmed the add-on works)

Once you're happy with the add-on, you can remove the old static-app deployment:

- Delete the versioned folders under `H:/www/ha-sunback-*`
- Remove the **Solar Payback** dashboard (`ha-sunback-dashboard.yaml` + its entry in `configuration.yaml`)
- Remove the `command_line` sensor **HA SunBack Data** and the `shell_command` `ha_sunback_store`
  from `configuration.yaml`, plus `/config/packages/ha_sunback_store.py` and `/config/ha-sunback-data.json`

> Each of these is a config change → reload/restart HA after editing, and do them one at a time.

---

## Files (what's in the repo)

```
ha-sunback/
├── config.yaml          # Add-on manifest (slug ha_sunback, ingress 8099)
├── Dockerfile           # Alpine 3.20 + Python 3.11 + FastAPI/uvicorn
├── rootfs/
│   └── app/
│       ├── run.sh       # Entrypoint: waits for Supervisor token, starts uvicorn
│       ├── main.py      # FastAPI backend: SQLite + HA REST proxy (Supervisor token)
│       └── static/      # Frontend (index.html, css, js/views/*) - calls /api/*, no browser token
└── DESIGN.md            # Architecture overview
```

**Note:** the add-on is built locally from this Dockerfile on your HA OS — it does **not**
download a prebuilt image. Build-on-install takes longer the first time but keeps everything
self-contained and free.
# Squadron Dashboard

**Release 1.2**

A self-hosted room display for RAF Air Cadets (and similar units): clock, weather, news, individual + flight leaderboard, events, Instagram, and custom embed widgets — plus a phone-friendly **edit** page and a **status** page.

**Repository:** [github.com/AstroLabs-UK/SquadronDashboard](https://github.com/AstroLabs-UK/SquadronDashboard)

---

## What’s new in 1.2

- **Scrolling important-information banner** — icon, title, and message move together as one ticker (title/icon in red, message in black); only shown when enabled in settings
- **News as an embeddable widget** — default FeedGrabbr embed; replace the code on `/edit` with any compatible news widget
- **Leaderboard caps** — individual **top 5**, flight **top 3** (blank / N/A flight labels ignored)
- **Clearer errors** — panel failures show a specific reason when available
- **Safer Git updates** — force update matches GitHub even with local edits; settings in `data/` are never overwritten
- **Version check** — `sqndash --check` and `/api/version` compare local vs GitHub; Force update on `/edit` confirms with commit details
- **Windows support** — `sqndash.cmd` / `sqndash.ps1` for update, restart, and version check on Windows
- **Compact layout** — small screens still show full top 5 / top 3 leaderboards with tighter rows

---

## What you get

| Page | URL | Purpose |
|------|-----|---------|
| **Display** | `http://<host>:3000/` | Full-screen kiosk dashboard |
| **Edit** | `http://<host>:3000/edit` | Configure everything from a phone or laptop |
| **Status** | `http://<host>:3000/status` | Health checks, uptime, git/version info |

**Default port:** `3000` (override with env `PORT`)

---

## Quick start

### Raspberry Pi (recommended for a room screen)

One command on a fresh Raspberry Pi OS install:

```bash
curl -fsSL https://raw.githubusercontent.com/AstroLabs-UK/SquadronDashboard/refs/heads/main/install.sh | bash
```

Then reboot:

```bash
sudo reboot
```

Or if you already cloned the repo:

```bash
git clone https://github.com/AstroLabs-UK/SquadronDashboard.git
cd SquadronDashboard
./install.sh
```

`install.sh` is safe to re-run. It typically:

- Installs Docker if needed  
- Builds and runs the app in Docker  
- Sets up Chromium kiosk autostart  
- Configures auto-update and auto-shutdown (host systemd timers)  
- Installs the `sqndash` command  

### Windows (dev / test PC)

1. Install [Node.js](https://nodejs.org/) (LTS) and [Git for Windows](https://git-scm.com/download/win).
2. Clone and run:

```powershell
git clone https://github.com/AstroLabs-UK/SquadronDashboard.git
cd SquadronDashboard
npm install --omit=dev
npm start
```

3. Open **http://localhost:3000** (display) and **http://localhost:3000/edit** (settings).

Optional: Docker Desktop + `docker compose up -d --build`.

### Linux (non-Pi, Node only)

```bash
git clone https://github.com/AstroLabs-UK/SquadronDashboard.git
cd SquadronDashboard
npm install --omit=dev
npm start
```

---

## Full setup guide (after install)

Open **`http://<device-IP>:3000/edit`** on any device on the same network.

### Core

| Setting | Notes |
|---------|--------|
| **Squadron / unit name** | Shown in the header |
| **Weather location** | Display name + latitude / longitude (used by Open-Meteo) |
| **Leaderboard Google Sheets CSV URL** | See [Leaderboard](#leaderboard-google-sheets) below |
| **“See all events” URL** | QR on the events panel (defaults to Bader events) |
| **Error report URL** | QR shown when a panel fails; leave blank to disable |
| **Auto shutdown (minutes)** | Pi only; minutes after boot before power-off (default **165** ≈ 2h45m). Applies from the **next** boot |
| **Screen layout** | `Automatic` / always full / always compact |

### Weather

- **Built-in:** temperature, feels-like, condition (Open-Meteo, no API key).  
- **Optional embed:** paste a full widget snippet (e.g. weatherwidget.io). Used on **full-size** layout only; compact always uses built-in weather.

### Carousel widgets (tick to show)

Order on screen: **Leaderboard → News → Events → Instagram → extra embeds**.

| Widget | Notes |
|--------|--------|
| **Leaderboard** | Individual top 5 + Flight top 3 |
| **News** | Embed widget (default FeedGrabbr). Paste any compatible embed under **News widget embed code** |
| **Events** | List you edit on this page; 3 per page, auto-rotate; optional “see all” QR |
| **Instagram** | Needs embed code (Elfsight, SociableKit, etc.); skipped if empty |

**Extra embed widgets:** add as many as you like (+ Add embed widget). Each has enable tick, name (edit page only), title (on screen), and embed code. They refresh about every 10 minutes.

### Important information banner

- Enable + optional title + message.  
- Appears at the **bottom** of the display only when enabled with a non-empty message.  
- Icon + title + message **scroll horizontally as one strip** (icon/title red, message black).

### Events

Add title, date/recurrence, and detail. Changes appear on the display within about **10 seconds** after **Save**.

---

## Leaderboard (Google Sheets)

1. In your points sheet: **File → Share → Publish to web**.  
2. Choose the sheet/tab, format **CSV**, copy the link.  
3. Paste into **Leaderboard Google Sheets CSV link** on `/edit` and **Save**.

**Expected columns** (header row, case-insensitive):

- Something containing **name**  
- Something containing **point**  
- Optional: **flight** (enables the Flight leaderboard)  
- Optional: **rank** (keeps the sheet’s order instead of re-sorting by points)

Blank / `N/A` / `none` flight labels are ignored. Individual shows **top 5**; flights **top 3** by total points.

---

## Layout (what the room screen shows)

- **Header:** squadron name, clock, date  
- **Left:** weather (always visible)  
- **Right:** rotating carousel (10s each, events longer if multiple pages)  
- **Bottom:** important-info banner only when enabled  

**Compact mode** (automatic when width ≤ 800px or height ≤ 500px, or forced on `/edit`): tighter spacing; weather becomes a slim strip; leaderboard still shows top 5 / top 3.

---

## Updating

Your settings live in the **`data/`** folder (git-ignored). Updates **never** overwrite them.

### Check local vs GitHub

```bash
# Linux / Pi
sqndash --check

# Windows (from the project folder)
sqndash --check
# or:  .\sqndash.cmd --check
```

Shows local commit, GitHub commit, and whether you are behind/ahead.

### Force update (match GitHub exactly)

**Warning:** local edits to tracked files are replaced. `data/` settings are kept.

```bash
# Linux / Pi
sqndash --force-update

# Windows
sqndash --force-update
```

You will be asked to confirm before it runs.

### From the web UI

1. Open `/edit` and **Save** any unsaved changes (Force update stays disabled while dirty).  
2. Click **Force update**.  
3. Confirm the dialog (includes local vs GitHub commit info when available).  
4. On a Pi with installers set up, a watcher runs the update and restarts the app.  
5. On Windows Node-only installs, prefer `sqndash --force-update` in a terminal (the button writes a request file; the Pi path unit is what usually picks it up).

### Manual update (any OS)

```bash
cd /path/to/SquadronDashboard
git fetch origin
git reset --hard origin/main
git clean -fd
npm install --omit=dev
# restart: npm start   or   docker compose up -d --build
```

### Auto-update (Pi with full install)

Checks shortly after boot and about every 30 minutes. Same rule: code from GitHub, **settings preserved**.

---

## Commands reference (`sqndash`)

| Command | Meaning |
|---------|---------|
| `sqndash --check` / `--version` | Compare local git to GitHub |
| `sqndash --update` | Update if behind, then restart |
| `sqndash --force-update` | Reset to latest GitHub even if “up to date”, then restart |
| `sqndash --restart` | Restart only |
| `sqndash --help` | Help |

**Windows:** use `sqndash.cmd` or `.\sqndash.ps1` from the project directory (or add the folder to PATH).

---

## Docker

```bash
docker compose up -d --build
docker compose logs -f
docker compose restart
```

Settings are bind-mounted from `./data` so they survive rebuilds.

---

## Status page & diagnostics

**http://\<host\>:3000/status** refreshes about every 30 seconds:

- Server online, uptime, Node version, app version  
- Weather API, news widget configured, leaderboard CSV, Instagram configured  
- `data.json` / backup presence  
- Git commit and local-change warning when relevant  

Dashboard panels that fail show a **reason** when the API provides one, and an error-report QR if you set that URL.

---

## Project layout (for developers)

```text
SquadronDashboard/
  server.js          Express API + static files
  storage.js         Atomic settings load/save under data/
  updater.js         Force-update request/status files
  update.sh          Linux update (fetch, reset --hard, restart)
  setup.sh / install.sh
  sqndash.sh         Linux CLI
  sqndash.ps1 / .cmd Windows CLI
  package.json
  docker-compose.yml / Dockerfile
  data.example.json  Example settings (real settings go in data/)
  public/
    dashboard.html   Kiosk UI
    edit.html        Settings UI
    status.html      Health UI
    roundel.png
```

**Settings path:** `data/data.json` (+ `data.backup.json`). Do not commit `data/`.

**API highlights:**

| Endpoint | Role |
|----------|------|
| `GET /api/data` | Read settings |
| `POST /api/data` | Save settings |
| `GET /api/weather` | Open-Meteo proxy |
| `GET /api/leaderboard` | CSV → top 5 / top 3 |
| `GET /api/news` | Legacy BBC RSS (display uses embed) |
| `GET /api/version` | Local vs GitHub commits |
| `POST /api/update` | Request force update |
| `GET /api/update/status` | Update progress |
| `GET /api/status` | Health payload |
| `GET /api/boot` | Boot id (clients reload after restart) |

---

## Requirements

| Environment | Needs |
|-------------|--------|
| **Pi room display** | Raspberry Pi OS, network, display; install script handles Docker/Chromium where used |
| **Windows / Linux Node** | Node.js 18+, Git, network for weather/news embeds/leaderboard CSV |
| **Docker** | Docker + Compose |

Outbound HTTPS is required for weather, sheet CSV, and most embed widgets.

---

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| Blank or old UI after update | Hard-refresh (**Ctrl+F5**); confirm `npm start` / container was restarted |
| `sqndash` not found (Windows) | Run from project folder: `.\sqndash.cmd --check` |
| Force update “could not determine remote” | `git remote -v`, then `git fetch origin` and `git branch -r`; ensure `origin/main` exists |
| Leaderboard empty | Publish sheet as CSV; check Name/Points headers; open `/api/leaderboard` |
| News empty | On `/edit`, ensure News is ticked and embed code is present; Save |
| Settings lost after update | They should not be — confirm files are under `data/`, not next to `server.js` only |
| Pi Force update button waits forever | Re-run `install.sh`, or SSH and run `sqndash --force-update` |

---

## Licence

See [LICENSE](LICENSE) in the repository.

---

**Squadron Dashboard 1.2** — self-hosted, settings-safe updates, room-ready display for your unit.

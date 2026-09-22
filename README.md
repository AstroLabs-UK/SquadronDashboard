# Squadron Dashboard

A self-hosted room display for RAF Air Cadets (and similar organisations): clock, weather, news, an individual + flight leaderboard, events, Instagram, and custom embed widgets — plus a phone-friendly **edit** page for changing settings and a **status** page for health checks.

**Repository:** [github.com/AstroLabs-UK/SquadronDashboard](https://github.com/AstroLabs-UK/SquadronDashboard)

---

## Install

### Raspberry Pi (recommended for a room screen)

One command on a fresh Raspberry Pi OS install:

```bash
curl -fsSL https://raw.githubusercontent.com/AstroLabs-UK/SquadronDashboard/refs/heads/Stable/install.sh | bash
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

`install.sh` is safe to re-run. It:

- Installs Node.js if needed and the app's dependencies
- Runs the dashboard as a systemd service that starts on boot and restarts if it crashes
- Sets up auto-update (a host timer, a couple of minutes after boot and every 30 minutes after that) and the Force update watcher
- Sets up auto-shutdown (host systemd service; minutes are set on `/edit`)
- Installs the `sqndash` command
- **Creates a random 6-digit editor PIN and prints it at the end — write it down**

### Kiosk autostart (Pi)

Point Chromium at the dashboard in kiosk mode when the desktop starts:

```bash
chromium-browser --kiosk --noerrdialogs --disable-infobars http://localhost:3000
```

Add that line to your Pi OS desktop's autostart (the file depends on the Pi OS version — for example `~/.config/lxsession/LXDE-pi/autostart`, with an `@` in front of the command on older releases). The dashboard reloads itself after an update, so the screen never needs touching.

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

### Docker (any OS)

```bash
docker compose up -d --build
docker compose logs -f
```

Settings are bind-mounted from `./data` so they survive rebuilds. Set the editor PIN with the `EDIT_PIN` environment variable or by putting it in `./data/edit-pin`. The app runs as an unprivileged user inside the container, and there's a built-in health check (`docker ps` shows `healthy`).

---

## Updating

Settings live in the **`data/`** folder and are git-ignored — updates never overwrite them.

Devices follow the newest tagged release (`v1.6.0`, `v1.7.0`, …) by default, not every commit on the default branch, so a half-finished change can't reach a room screen by accident.

| How | Command |
|-----|---------|
| Check for an update | `sqndash --check` |
| Update if behind | `sqndash --update` |
| Re-apply the current target anyway | `sqndash --force-update` |
| From the web UI | Open `/edit`, enter the PIN, click **Force update** |

Auto-update runs on its own too: a Pi checks shortly after boot and every 30 minutes via a host timer; Windows/bare Node checks at launch and every 5 minutes (disable with `AUTO_UPDATE=0`). Every update is tested before it goes live — the new version has to answer a health check, or the previous one is restored automatically and the failed release is remembered so it isn't retried every few minutes.

A test device that should always run the very latest code can follow the **Update** branch instead of tagged releases with `sqndash --channel update`; switch back with `sqndash --channel stable`.

Full details, manual/CLI update commands, and cutting a new release are in [Updating](#updating-in-depth) below.

---

## What you get

| Page | URL | Purpose |
|------|-----|---------|
| **Display** | `http://<host>:3000/` | Full-screen kiosk dashboard |
| **Edit** | `http://<host>:3000/edit` | Configure everything from a phone or laptop (PIN protected) |
| **Status** | `http://<host>:3000/status` | Health checks, uptime, git/version info |

**Default port:** `3000` (override with env `PORT`; bind address with `SQNDASH_HOST`, default all interfaces)

The dashboard is built around content that looks after itself once it's set up:

- **Calendar feed.** Paste a calendar's `.ics` link (Google, Outlook, iCloud, or a TimeTree calendar (sign in on `/edit` and pick which calendar) — choose the source from a dropdown on `/edit`) and upcoming events, plus the uniform of the week, show up on their own. Repeating events, cancelled dates, all-day/multi-day events and time zones are all handled.
- **Uniform panel.** Shows what to wear this week and next, taken from a `Uniform: Working blues` line in the calendar and/or a typed list.
- **Leaderboard.** Reads a published Google Sheets CSV — individual top 5, flight top 3.
- **News, weather, Instagram and custom embeds** as carousel panels, each with its own on/off switch.
- **Auto-hide expired events**, "last updated" stamps that go amber when a source is offline, and cached data so a panel never just goes blank.
- **Screen controls.** Push a full-screen message to every display, clear it, or force a reload, all from `/edit`.
- **Backup & restore.** Download every setting as one file and restore it on another device.
- **An editor PIN** protects `/edit` and anything that changes settings; the public display never needs a login.

---

## Full setup guide (after install)

Open **`http://<device-IP>:3000/edit`** on any device on the same network.

### Core settings

| Setting | Notes |
|---------|--------|
| **Squadron / unit name** | Shown in the header |
| **Weather location** | Display name + latitude / longitude |
| **Leaderboard Google Sheets CSV URL** | Publish the sheet as CSV first |
| **"See all events" URL** | QR code on the events panel |
| **Error report URL** | QR shown when a panel fails; leave blank to disable |
| **Auto shutdown (minutes)** | Pi only; applies from the next boot |
| **Screen layout** | Automatic / always full / always compact |

### Calendar

On `/edit`, above the calendar settings there's a **Calendar source** dropdown: **ICS import** or **TimeTree**. ICS asks for a secret calendar link; TimeTree asks for your email/password and then lets you pick a calendar from a list.

**ICS import** (Google, Outlook, iCloud, or anything else that gives out a calendar link):

1. In Google Calendar, open **Settings** for your squadron calendar, scroll to **Integrate calendar**, and copy **Secret address in iCal format**.
2. Paste it into the calendar link field on `/edit`, **Save**, then **Test calendar**.

**TimeTree:**

TimeTree is built in — no sidecar required.

1. On `/edit`, set **Calendar source** to **TimeTree**.
2. Enter your TimeTree **email** and **password**.
3. Click **Connect & list calendars** — the dashboard logs into TimeTree and lists your active calendars.
4. Pick the **calendar**, then tick the **tags** you want on the public board (leave all unchecked to show every event).
5. **Save**, then **Test calendar**.

Credentials are stored only in `data/data.json` on the device (never sent to the public display). Events are refreshed at most every 10 minutes; if TimeTree is briefly unreachable the last good copy is kept for up to 24 hours.

This uses the same unofficial TimeTree web API as [timetree-live-ics](https://github.com/mr-onadasky/timetree-live-ics) (login + calendar sync). It is lightweight: a few extra HTTP calls on a timer, no browser automation. Fine on a Pi next to the rest of the dashboard.

Outlook, iCloud and most other calendars still use their own `.ics` / "subscribe" link under **ICS import**.

### Carousel widgets

Panels appear in this order: **Leaderboard → News → Events → Uniform → Instagram → any extra embeds.** Each has its own tick box on `/edit`; leaving a widget's embed code blank hides that panel instead of showing an error.

### Editor PIN

- **Set or change it:** `sqndash --set-pin` (asks twice) or `sqndash --set-pin 482913`. Takes effect immediately, no restart.
- **Docker / servers:** use the `EDIT_PIN` environment variable instead.
- **Remove it:** `sqndash --clear-pin` (not recommended on a shared network).
- If no PIN is set, the editor stays open so upgrades never lock anyone out, and `/status` shows a warning.

---

## Updating in depth

### Which version does a device follow?

| Channel | Follows | Use for |
|---------|---------|---------|
| **stable** (default) | The newest tag like `v1.7.0` (falls back to the **Stable** branch if no tags yet) | Room screens |
| **update** | The tip of the **Update** branch | A test device that should always be latest |

Change it with `sqndash --channel stable` / `sqndash --channel update` (or the `UPDATE_CHANNEL` environment variable). Legacy aliases `release`→`stable` and `main`→`update` still work. A device that's already at or ahead of its target is left alone rather than downgraded.

### The safety net

1. Settings are snapshotted before anything changes, and restored straight after the new code lands.
2. New code is downloaded; `npm install` only runs if `package.json` changed.
3. The new version has to answer a health check before it goes live (a spare port on Windows/bare Node, a restart-and-wait on the Pi).
4. If it fails, the previous version is restored automatically, and that release is remembered so it isn't retried every few minutes.

### Manual update (any OS)

```bash
cd /path/to/SquadronDashboard
git fetch --tags origin
git reset --hard v1.7.0        # or the tag you want, or origin/Stable
git clean -fd
npm install --omit=dev
# restart: npm start   or   docker compose up -d --build
```

### Cutting a release (maintainers)

```bash
git checkout Stable && git pull
# bump "version" in package.json, update this README, merge, then:
git tag v1.7.0
git push origin v1.7.0
```

Tags must look like `vMAJOR.MINOR.PATCH` — anything else (`v1.7.0-beta`) is ignored by the stable channel. Experimental work lives on the **Update** branch.

---

## Commands reference (`sqndash`)

| Command | Meaning |
|---------|---------|
| `sqndash --check` / `--version` | Compare local git to the update target |
| `sqndash --update` | Update if there is a newer version, then restart |
| `sqndash --force-update` | Re-apply the target even if "up to date", then restart |
| `sqndash --restart` | Restart only |
| `sqndash --set-pin [PIN]` | Set the `/edit` PIN |
| `sqndash --clear-pin` | Remove the PIN |
| `sqndash --channel [stable\|update]` | Show or change the update channel |
| `sqndash --help` | Help |

**Windows:** use `sqndash.cmd` or `.\sqndash.ps1` from the project directory (or add the folder to PATH).

---

## Status page & diagnostics

**http://\<host\>:3000/status** refreshes about every 30 seconds and shows server uptime, which data sources are configured, editor PIN status, calendar feed health, device health (CPU temp, memory, storage, Wi-Fi, uptime on a Pi), and the current git commit.

**http://\<host\>:3000/healthz** is a cheap liveness check used by Docker and by the update safety net.

---

## Project layout (for developers)

```text
SquadronDashboard/
  server.js          App wiring: pages, settings API, security, route modules
  routes/            weather, news, leaderboard, schedule (events + uniform), control, config, status (+ /healthz), update
  lib/
    auth.js          Editor PIN check
    security.js      Security headers + rate limiter
    csv.js           CSV parser
    leaderboard.js   Sheet table -> top 5 / top 3
    cache.js         TTL cache with serve-stale-on-error
    git.js           Run git without a shell
    release.js       Which version to follow (stable tags / Stable branch vs Update branch), skip list
    canary.js        Start-and-check a new version before switching
    cleanup.js       Silent start-up deletion of stray files named "temp"
    tz.js            Time-zone / date helpers (Intl, no dependencies)
    ics.js           Calendar (.ics) reader incl. repeating events
    calendar.js      Fetch + cache the calendar link
    events.js        Typed + calendar events -> the display list
    uniform.js       This week / next week uniform
    sysinfo.js       Pi health numbers (temperature, memory, disk, Wi-Fi)
    restart.js       Relaunch the app after an in-app update
    settingsGuard.js Settings snapshot/restore around updates
  storage.js         Atomic settings load/save/validate under data/
  updater.js         Force-update request/status files (Pi watcher hand-off)
  autoUpdate.js      In-process update engine (Windows / bare Node)
  scripts/update.js  CLI for the update engine (used by sqndash.ps1)
  update.sh          Linux update: target, safety copy, restart, health check, rollback
  install.sh         Pi installer (setup.sh is an alias)
  sqndash.sh         Linux CLI
  sqndash.ps1 / .cmd Windows CLI
  test/              npm test  (node:test, no extra dependencies)
  .github/workflows/ CI: tests on Node 18/20/22, shell checks, Docker build
  package.json
  docker-compose.yml / Dockerfile / docker-entrypoint.sh
  .env.example        Copy to .env for Docker (PIN, optional TimeTree credentials)
  data.example.json  Example settings (real settings go in data/)
  public/
    dashboard.html   Kiosk UI
    edit.html        Settings UI
    status.html      Health UI
    roundel.png
```

**Settings path:** `data/data.json` (+ `data.backup.json`). Do not commit `data/`. Other files in `data/`: `edit-pin`, `update-status.json`, `update-channel`, `skip-release.json`, `last-good-commit`. A safety copy of the whole folder is kept in `.squadron-dashboard-backup` beside the app folder (override with `DATA_BACKUP_DIR`).

**Run the tests:** `npm install` then `npm test`.

**API highlights:**

| Endpoint | Role |
|----------|------|
| `GET /api/data` | Read settings |
| `POST /api/data` | Save settings (PIN) |
| `GET /api/weather` | Open-Meteo proxy (cached, serves stale on error) |
| `GET /api/events` | Typed + calendar events for the display (calendar status included) |
| `GET /api/uniform` | This week / next week uniform |
| `POST /api/control` | Show / clear a screen message, reload screens (PIN) |
| `GET /api/config/export` | Download all settings as a file (PIN) |
| `POST /api/config/import` | Restore settings from a file (PIN) |
| `GET /api/leaderboard` | CSV → top 5 / top 3 (cached, serves stale on error) |
| `GET /api/news` | BBC headlines (title, description, thumbnail) |
| `GET /api/version` | Local vs update target |
| `POST /api/update` | Request force update (PIN) |
| `GET /api/update/status` | Update progress |
| `GET /api/status` | Health payload |
| `GET /healthz` | Liveness |
| `GET /api/boot` | Boot id + pending reload / screen message (clients poll it) |

---

## Requirements

| Environment | Needs |
|-------------|--------|
| **Pi room display** | Raspberry Pi OS, network, display; the installer sets up Node.js and the services |
| **Windows / Linux Node** | Node.js 18+, Git, network for weather/news/leaderboard CSV |
| **Docker** | Docker + Compose |

Outbound HTTPS is required for weather, sheet CSV, and most embed widgets.

---

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| Blank or old UI after update | Hard-refresh (**Ctrl+F5**); confirm `npm start` / the service was restarted |
| `/edit` asks for a password | Leave the username blank, enter the editor PIN. Forgotten it? `sqndash --set-pin` on the device |
| "Too many wrong PIN attempts" | Wait 5 minutes |
| `sqndash` not found (Windows) | Run from project folder: `.\sqndash.cmd --check` |
| Update says the release "failed its safety check" | The new version didn't start, so the old one was kept. Check the logs, fix, and tag a new release. `sqndash --force-update` retries the same one |
| Devices aren't getting a new release | Is it tagged (`vX.Y.Z`) and pushed? `sqndash --check` shows the target. A device on the `update` channel ignores tags |
| Force update "could not determine remote" | `git remote -v`, then `git fetch --tags origin`; ensure the default branch exists on `origin` |
| Leaderboard empty | Publish the sheet as CSV; check Name/Points headers; open `/api/leaderboard` |
| News empty | On `/edit`, ensure News is ticked; check `/api/news` |
| Settings lost after update | They restore themselves from `.squadron-dashboard-backup` (next to the app folder) when the dashboard starts or the next update runs |
| Dashboard stopped after an update | On a Pi it restarts itself within 30 minutes, or run `sqndash --restart` now. Windows: `sqndash --restart` or `npm start` |
| Pi Force update button waits forever | Re-run `install.sh`, or SSH in and run `sqndash --force-update` |

---

## Where this is headed

The dashboard is still growing. Ideas queued up for future releases:

### Dashboard features

- **Themes** — a dark mode for evening events, and a "parade night" view showing the evening's programme.
- **Birthday, promotion and "cadet of the month" shout-outs**, driven from the points sheet.
- **A richer uniform panel** — a picture of the uniform alongside the text, not just a description.
- **Weekly movement on the leaderboard** — flight progress or "+12 this week" instead of only totals, which means the dashboard keeping a little history rather than just the current standings.

### Bigger projects

- **A proper API behind the points tracker**, replacing the CSV-from-a-spreadsheet approach with a small endpoint that returns validated JSON.
- **A badge/award tracker** — gamified proficiency tracking with photo or instructor sign-off.
- **A multi-squadron mode** — configurable enough that another unit can install it with one command and make it their own, rather than forking the code.

None of this is built yet — it's the direction the project is heading, not a promise of what's in the next release.

---

## Licence

See [LICENSE](LICENSE) in the repository.

# Squadron Dashboard

**Release 1.6.0**

A self-hosted room display for RAF Air Cadets (and similar organisations): clock, weather, news, individual + flight leaderboard, events, Instagram, and custom embed widgets — plus a phone-friendly **edit** page and a **status** page.

**Repository:** [github.com/AstroLabs-UK/SquadronDashboard](https://github.com/AstroLabs-UK/SquadronDashboard)

---

## What's new in 1.6

Release 1.6 makes the content look after itself: connect a calendar once and events and next week's uniform appear on their own.

- **Calendar feed (live link).** Paste a calendar's `.ics` link on `/edit` and its upcoming events show on the display, after any events you typed by hand. Works with Google Calendar's "Secret address in iCal format" (and Outlook, iCloud, anything that gives an `.ics` link). Repeating events, single moved or cancelled dates, all-day and multi-day events and time zones (including the clocks changing) are handled. Read at most every 10 minutes; if the calendar can't be reached the last copy is used for up to 24 hours. See [Calendar](#calendar-live-link).
- **Uniform panel.** A new carousel panel shows what to wear **this week** and **next week**. It reads a `Uniform: Working blues` line from the calendar event, and/or a list you type on `/edit`. See [Uniform](#uniform-this-week--next-week).
- **Auto-hide expired events.** Calendar events disappear when they finish. Typed events get an optional "Hide after" date.
- **"Last updated" stamps.** Each data panel shows when it was last refreshed, and turns amber with "Offline – showing data from 14:32" when the source is down and old data is being kept.
- **Screen controls on `/edit`.** Show a full-screen message on every display for a set time, clear it, or reload all screens.
- **Backup & restore.** Download every setting as one file and restore it on another device (a copy of the previous settings is kept first).
- **Richer `/status`.** CPU temperature, memory, storage free, Wi-Fi signal, load and device uptime, plus calendar health.
- **Docker runs as a normal user, not root** (details under [Docker](#docker)).
- **The calendar's private link stays private:** when an editor PIN is set, the public display page never receives it.

Upgrading from 1.5.x needs nothing: settings are untouched and every new option starts switched off or empty.

## What was new in 1.5 (and its 1.5.x patches)

Release 1.5 is a **hardening and tidy-up patch**. There are no new panels: the goal is a dashboard that is safer to leave running on a shared network, harder to break with a bad update, and easier to keep working on. The features planned for after it are listed under [Future updates](#future-updates).

### Security fixes

- **Editor PIN for `/edit`.** Saving settings, the Force update button and the edit page itself now sit behind a PIN. The room display stays open (it never needs a login). Set it with `sqndash --set-pin`; the Pi installer creates a random one for you. See [Editor PIN](#editor-pin).
- **Stored cross-site scripting closed.** Event titles, event details, cadet names, flight names and panel error messages are now escaped before being put on the screen. Previously a name like `<img onerror=…>` typed into the points sheet or the edit page would have run on the room display.
- **URL settings are validated.** The leaderboard, "see all events" and error-report links must be a real `http(s)` address (or blank). `javascript:` and `file://` values are refused, which also stops the server being pointed at odd schemes when it fetches the sheet.
- **Safer headers and rate limits.** Responses carry `X-Content-Type-Options`, `X-Frame-Options` and `Referrer-Policy` headers, the API is rate limited, and repeated wrong PINs lock the guesser out for a few minutes. (There is deliberately no Content-Security-Policy, because the dashboard exists to run third-party embed widgets.)
- **Git is run without a shell**, so nothing from a branch or tag name can be treated as a command.

### Reliability fixes

- **Proper CSV parsing.** The old parser dropped every quote character, so escaped quotes and line breaks inside a cell scrambled the leaderboard. It now follows the CSV standard (quoted commas, `""`, multi-line cells, BOM, any line ending).
- **Updates follow releases, not `main`.** Devices update to the newest tagged release (`v1.5.0`, `v1.6.0`…). A half-finished commit on `main` can no longer reach a room screen. A test device can still follow `main` with `sqndash --channel main`. A device that is already ahead of the target is never downgraded.
- **Updates test themselves and roll back.** On Windows/bare Node the new code is started on a spare port and must answer `/healthz` *before* the live dashboard switches to it. On the Pi the restarted dashboard must answer `/healthz` within about 90 seconds. If it doesn't, the device goes back to the previous version and remembers the bad release so it isn't retried every 30 minutes. See [Updating](#updating).
- **`npm install` only when dependencies changed**, so updates are quicker and work with a flaky connection.
- **Docker image fixed.** `autoUpdate.js` was missing from the image, so a container built from the old Dockerfile could not start. The image now copies every module, has a health check, and uses the lockfile when there is one.
- **Settings can no longer be wiped by an update (1.5.1).** Two ways it could happen are closed: a release that is missing `.gitignore` (easy to do when uploading files by hand, because dotfiles are hidden) made the update's `git clean` delete `data/`, and a release that accidentally tracked `data/data.json` overwrote it. Updates now keep a snapshot of `data/` in a hidden folder *outside* the app folder (`.squadron-dashboard-backup`, next to it), put it back straight after the code is swapped, and `git clean` is told never to touch `data/`. The server also restores any missing settings from that snapshot when it starts, and refreshes the snapshot after every save.
- **The dashboard always comes back after an update (1.5.2).** The in-app restart no longer relies on shell commands that break on paths with spaces; it uses a small Node helper that waits, then launches the new copy. On a Pi, the service is now `Restart=always` (so even a "clean" exit restarts it), every update run starts the dashboard if it found it stopped, and the update script double-checks it is running after the restart. Existing Pis get the new restart policy automatically on the next update run.
- **Windows updates are no longer silent (1.5.3).** `sqndash --update` / `--force-update` used to end without a word when something went wrong, because the result line was lost when the helper exited. Every outcome now prints what happened and the recorded reason (also in `data\update-status.json`), and each failure has its own exit code. A `git reset` that fails because of a briefly locked file or a stale `.git\index.lock` is retried automatically. The settings backup for an app in a drive root (e.g. `C:\SquadronDashboard`) goes to your user folder instead of `C:\`.
- **Start-up housekeeping (1.5.4).** When the dashboard starts it silently deletes any file named exactly `temp` (no extension) inside the app folder. It skips `node_modules`, `.git` and `data/`, follows no shortcuts, and prints nothing.
- **Panels survive a wifi wobble.** Weather, news headlines and the leaderboard are cached, and if the source is unreachable the last good data is shown for up to six hours (`"stale": true` in the API) instead of a blank panel. All outgoing requests have timeouts.
- **Large settings save.** The request size limit is raised so a squadron with many big embed widgets can save.
- **Leaderboard re-renders when names change**, not only when the number of rows changes.
- **`shutdown-timer.sh` is now git-ignored.** The installer generates it next to the code, and the update's `git clean` was able to delete it, which would have broken auto-shutdown after an update.
- **The in-process updater stands down under systemd/Docker.** On a Pi the host update timer already does the job; running a second updater inside the app could fight it.

### Tidy-up

- `setup.sh` was a byte-for-byte copy of `install.sh`; it is now a one-line alias.
- `server.js` is split into small modules (`routes/`, `lib/`) instead of one 400-line file.
- The unneeded `node-fetch` dependency is gone (Node 18+ has `fetch` built in), and `package.json` now declares `"node": ">=18"`.
- New `GET /healthz` endpoint and a Docker `HEALTHCHECK`.
- News uses the HTTPS BBC feed. The FeedGrabbr embed that used to ship as the default is no longer baked into the repo — see [Carousel widgets](#carousel-widgets-tick-to-show).
- Automated tests (`npm test`, 108 checks covering the CSV parser, leaderboard maths, settings storage, PIN protection, rate limiting, the cache and the whole update/rollback flow) and a GitHub Actions workflow that runs them, plus a Docker build check.
- Installer uses Node 22 LTS.

### Upgrading from 1.2 – 1.4

Nothing to reconfigure — settings in `data/` are untouched. Two things to know:

1. **No PIN is set on an existing device until you set one**, so `/edit` keeps working exactly as before. The `/status` page shows a warning until you run `sqndash --set-pin`.
2. **Tag the release.** Devices now follow release tags, so after merging, create the tag (see [Cutting a release](#cutting-a-release)). Until any `vX.Y.Z` tag exists, devices fall back to following `main`, so nobody is stranded.

### Earlier releases

**1.2**

- Scrolling important-information banner (icon, title and message move as one ticker; shown only when enabled)
- News as an embeddable widget (replace the code on `/edit` with any compatible news widget)
- Leaderboard caps: individual top 5, flight top 3 (blank / N/A flight labels ignored)
- Clearer panel errors with a specific reason when available
- Force update matches GitHub even with local edits; settings in `data/` are never overwritten
- Version check: `sqndash --check` and `/api/version`
- Windows support: `sqndash.cmd` / `sqndash.ps1`
- Compact layout: small screens still show the full top 5 / top 3

---

## What you get

| Page | URL | Purpose |
|------|-----|---------|
| **Display** | `http://<host>:3000/` | Full-screen kiosk dashboard |
| **Edit** | `http://<host>:3000/edit` | Configure everything from a phone or laptop (PIN protected) |
| **Status** | `http://<host>:3000/status` | Health checks, uptime, git/version info |

**Default port:** `3000` (override with env `PORT`; bind address with `SQNDASH_HOST`, default all interfaces)

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

`install.sh` is safe to re-run. It:

- Installs Node.js if needed and the app's dependencies
- Runs the dashboard as a systemd service that starts on boot and restarts if it crashes
- Sets up auto-update (a host timer, about 2 minutes after boot and every 30 minutes) and the Force update watcher
- Sets up auto-shutdown (host systemd service; minutes are set on `/edit`)
- Installs the `sqndash` command
- **Creates a random 6-digit editor PIN and prints it at the end — write it down**

### Kiosk autostart (Pi)

Point Chromium at the dashboard in kiosk mode when the desktop starts:

```bash
chromium-browser --kiosk --noerrdialogs --disable-infobars http://localhost:3000
```

Add that line to your Pi OS desktop's autostart (the file depends on the Pi OS version — for example `~/.config/lxsession/LXDE-pi/autostart` with an `@` in front of the command on older releases). The dashboard reloads itself after an update, so the screen never needs touching.

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

## Editor PIN

The `/edit` page, saving settings and Force update all need the PIN. The display (`/`) and status page do not.

- **Set or change it:** `sqndash --set-pin` (asks twice) or `sqndash --set-pin 482913`. It's stored in `data/edit-pin` and takes effect straight away — no restart.
- **Signing in:** your browser shows a sign-in box. Leave the username blank and enter the PIN as the password. The browser remembers it until you close it.
- **Docker / servers:** set the `EDIT_PIN` environment variable instead (it wins over the file). With Docker Compose: `EDIT_PIN=482913 docker compose up -d`.
- **Forgotten it?** On the Pi run `sqndash --set-pin` again — it needs access to the device, not the old PIN.
- **Remove it:** `sqndash --clear-pin` (not recommended on a shared network).
- **Wrong guesses:** 10 wrong attempts locks the address out for 5 minutes.
- **Not set yet?** The editor stays open so upgrades never lock anyone out, the server logs a warning, and `/status` shows a warning.

---

## Full setup guide (after install)

Open **`http://<device-IP>:3000/edit`** on any device on the same network.

### Core

| Setting | Notes |
|---------|--------|
| **Squadron / unit name** | Shown in the header |
| **Weather location** | Display name + latitude / longitude (used by Open-Meteo) |
| **Leaderboard Google Sheets CSV URL** | See [Leaderboard](#leaderboard-google-sheets) below. Must be `http(s)` |
| **“See all events” URL** | QR on the events panel (defaults to Bader events) |
| **Error report URL** | QR shown when a panel fails; leave blank to disable |
| **Auto shutdown (minutes)** | Pi only; minutes after boot before power-off (default **165** ≈ 2h45m). Applies from the **next** boot |
| **Screen layout** | `Automatic` / always full / always compact |

### Weather

- **Built-in:** temperature, feels-like, condition (Open-Meteo, no API key). Cached for 5 minutes; if the service is unreachable the last reading is kept.
- **Optional embed:** paste a full widget snippet (e.g. weatherwidget.io). Used on **full-size** layout only; compact always uses built-in weather.

### Carousel widgets (tick to show)

Order on screen: **Leaderboard → News → Events → Uniform → Instagram → extra embeds**.

| Widget | Notes |
|--------|--------|
| **Leaderboard** | Individual top 5 + Flight top 3 |
| **News** | Embed widget. Paste any news widget snippet (for example one you create at FeedGrabbr) under **News widget embed code**. **Blank hides the panel** — new installs no longer ship with a default |
| **Events** | Typed events + calendar events; 3 per page, auto-rotate; optional “see all” QR |
| **Uniform** | This week / next week; from the calendar and/or a typed list |
| **Instagram** | Needs embed code (Elfsight, SociableKit, etc.); skipped if empty |

**Extra embed widgets:** add as many as you like (+ Add embed widget). Each has enable tick, name (edit page only), title (on screen), and embed code. They refresh about every 10 minutes.

### Important information banner

- Enable + optional title + message.
- Appears at the **bottom** of the display only when enabled with a non-empty message.
- Icon + title + message **scroll horizontally as one strip** (icon/title red, message black).

### Events

Add title, date/recurrence, and detail. Changes appear on the display within about **10 seconds** after **Save**. Typed events come first, then upcoming calendar events. Give a typed event a **Hide after** date and it disappears by itself.

### Screen controls and backup

- **Show message** puts a full-screen notice on every display for 1–720 minutes (default 30). **Clear message** removes it; **Reload screens** reloads every display. They take effect within about 10 seconds. A restart clears any message.
- **Download settings file** saves everything (including the private calendar link, but not the PIN). **Restore from file…** loads one, after asking; the previous settings are kept in `data/data.before-import.json`.

---

## Calendar (live link)

Events and the uniform panel can read from a calendar, so nobody has to retype anything.

**Google Calendar**

1. On a computer open Google Calendar &rarr; **Settings** (cog) &rarr; click your squadron calendar under *Settings for my calendars*.
2. Scroll to **Integrate calendar** and copy **Secret address in iCal format** (a long link ending `basic.ics`).
3. Paste it into **Calendar link (.ics)** on `/edit`, **Save**, then press **Test calendar link**.

That's it &ndash; no sign-in, no API keys. Outlook, iCloud and other calendars work the same way with their `.ics` / "subscribe" link (`webcal://` links are accepted).

- **Speed:** the dashboard reads the link at most every 10 minutes. Google itself can take a few hours to show a change in that feed, so a brand-new event may not appear straight away. Use a typed event (or the screen message) for anything urgent.
- **Privacy:** anyone with the secret link can read the calendar. It is stored on the device only, is never shown on the public display page when a PIN is set, and is included in settings backups.
- **Time zone and range:** default `Europe/London`, looking 60 days ahead (14–365).
- **Why not sign in to Google?** A live `.ics` link needs no Google Cloud project or logins that can expire. If you ever need instant updates, the Google Calendar API is the alternative, at the cost of that extra setup.
- **Offline:** if the calendar can't be reached the last good copy is shown (up to 24 hours) with an amber "Offline" stamp; typed events always keep working.

## Uniform (this week / next week)

A carousel panel (tick **Uniform** on `/edit`) with two columns: **This week** (from today onwards) and **Next week**. It is hidden while there is nothing to show.

Where the uniform comes from (both are combined):

- **The calendar.** In the event's description put a line such as `Uniform: Working blues`. Or put `[Uniform: Working blues]` at the end of the title &ndash; that part is removed from the title on the events panel.
- **A list on `/edit`** (**Uniform** section): a date, an optional label and the uniform. Useful without a calendar.

Weeks run Monday to Sunday. The same day + uniform found twice is shown once.

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

Blank / `N/A` / `none` flight labels are ignored. Individual shows **top 5**; flights **top 3** by total points. Names may contain commas, quotes and even line breaks. The sheet is re-read at most every 2 minutes; if it can't be reached the last good table stays on screen.

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

### Which version does a device follow?

| Channel | Follows | Use for |
|---------|---------|---------|
| **release** (default) | The newest tag like `v1.5.0` | Room screens |
| **main** | The tip of the `main` branch | A test device that should always be latest |

Change it with `sqndash --channel main` / `sqndash --channel release` (or the `UPDATE_CHANNEL` environment variable). A device that is already at or ahead of its target is left alone rather than downgraded. If the repository has no release tags yet, the release channel falls back to `main`.

### The safety net

0. **Your settings are snapshotted first** to `.squadron-dashboard-backup` (next to the app folder) and restored over `data/` as soon as the new code is in place.
1. New code is downloaded and `npm install` runs only if `package.json` changed.
2. **Windows / bare Node:** a throw-away copy of the new version is started on a spare port with a scratch copy of your settings. It must answer `/healthz` before the live dashboard is restarted onto it.
3. **Raspberry Pi:** after the restart the script waits up to about 90 seconds for `/healthz`.
4. If the new version fails, the previous version is restored (and restarted on the Pi), and the bad release is written to `data/skip-release.json` so it isn't retried every few minutes. The result appears on the `/edit` page and in `data/update-status.json`.
5. `sqndash --force-update` tries the release again on purpose.

### Cutting a release

```bash
git checkout main && git pull
# bump "version" in package.json, update this README, merge, then:
git tag v1.5.0
git push origin v1.5.0
```

Devices on the release channel pick the tag up within about 30 minutes (Pi) or 5 minutes (Windows). Tags must look like `vMAJOR.MINOR.PATCH`; other tags such as `v1.5.0-beta` are ignored.

### Check local vs GitHub

```bash
# Linux / Pi
sqndash --check

# Windows (from the project folder)
sqndash --check
# or:  .\sqndash.cmd --check
```

Shows the local commit, the update target (and which channel), and whether you are behind.

### Force update (match the target exactly)

**Warning:** local edits to tracked files are replaced. `data/` settings are kept.

```bash
sqndash --force-update
```

You will be asked to confirm before it runs on Windows.

### From the web UI

1. Open `/edit` (enter the PIN) and **Save** any unsaved changes (Force update stays disabled while dirty).
2. Click **Force update**.
3. Confirm the dialog (includes local vs target release when available).
4. On a Pi with the installer set up, the update watcher runs the update and restarts the app. On Windows / bare Node the app updates itself and restarts.

### Manual update (any OS)

```bash
cd /path/to/SquadronDashboard
git fetch --tags origin
git reset --hard v1.5.0        # or origin/main
git clean -fd
npm install --omit=dev
# restart: npm start   or   docker compose up -d --build
```

### Auto-update

- **Pi (systemd):** checked shortly after boot and about every 30 minutes by a host timer. The app itself does not also update — that would fight the timer.
- **Windows / bare Node:** checked at launch and every 5 minutes by the app.
- Disable the in-app updater with `AUTO_UPDATE=0`.

Same rule everywhere: code from GitHub, **settings preserved**.

---

## Commands reference (`sqndash`)

| Command | Meaning |
|---------|---------|
| `sqndash --check` / `--version` | Compare local git to the update target |
| `sqndash --update` | Update if there is a newer version, then restart |
| `sqndash --force-update` | Re-apply the target even if “up to date”, then restart |
| `sqndash --restart` | Restart only |
| `sqndash --set-pin [PIN]` | Set the `/edit` PIN (takes effect immediately) |
| `sqndash --clear-pin` | Remove the PIN |
| `sqndash --channel [release\|main]` | Show or change the update channel |
| `sqndash --help` | Help |

**Windows:** use `sqndash.cmd` or `.\sqndash.ps1` from the project directory (or add the folder to PATH). Node.js and Git must be installed.

---

## Docker

```bash
docker compose up -d --build
docker compose logs -f
docker compose restart
```

Settings are bind-mounted from `./data` so they survive rebuilds. Set the editor PIN with the `EDIT_PIN` environment variable or by putting it in `./data/edit-pin`. The image has a health check (`docker ps` shows `healthy`). The app runs as the unprivileged `node` user (not root): the container starts as root only long enough to make the mounted `./data` folder writable by that user (Docker creates it root-owned on first run), then drops privileges. Note the container has no settings snapshot outside `./data`, because updating means rebuilding the image, not swapping code in place. The container has no git history, so updating means rebuilding: `git pull` on the host, then `docker compose up -d --build`.

---

## Status page & diagnostics

**http://\<host\>:3000/status** refreshes about every 30 seconds:

- Server online, uptime, Node version, app version
- Weather API, news widget configured, leaderboard CSV, Instagram configured
- `data.json` / backup presence
- Editor PIN set or not
- Calendar feed health (events in range, when it was last fetched)
- Device health: CPU temperature, memory, storage free, Wi-Fi signal, load, uptime (Pi/Linux; "Not available" elsewhere)
- Git commit and local-change warning when relevant

**http://\<host\>:3000/healthz** is a cheap liveness check (`{"ok":true}`) used by Docker and by the update safety net.

Dashboard panels that fail show a **reason** when the API provides one, and an error-report QR if you set that URL.

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
    release.js       Which version to follow (release tag vs main), skip list
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
| `GET /api/news` | BBC RSS headlines (display uses the embed) |
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
| **Windows / Linux Node** | Node.js 18+, Git, network for weather/news embeds/leaderboard CSV |
| **Docker** | Docker + Compose |

Outbound HTTPS is required for weather, sheet CSV, and most embed widgets.

---

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| Blank or old UI after update | Hard-refresh (**Ctrl+F5**); confirm `npm start` / the service was restarted |
| `/edit` asks for a password | Leave the username blank, enter the editor PIN. Forgotten it? `sqndash --set-pin` on the device |
| “Too many wrong PIN attempts” | Wait 5 minutes |
| `sqndash` not found (Windows) | Run from project folder: `.\sqndash.cmd --check` |
| Update says the release “failed its safety check” | The new version didn't start, so the old one was kept. Check `journalctl -u squadron-dashboard`, fix, and tag a new release. `sqndash --force-update` retries the same one |
| Devices aren't getting a new release | Is it tagged (`vX.Y.Z`) and pushed? `sqndash --check` shows the target. A device on the `main` channel ignores tags |
| Force update “could not determine remote” | `git remote -v`, then `git fetch --tags origin`; ensure `origin/main` exists |
| Leaderboard empty | Publish sheet as CSV; check Name/Points headers; open `/api/leaderboard` |
| News empty | On `/edit`, ensure News is ticked and an embed code is pasted (there is no default any more); Save |
| Settings lost after update | They restore themselves from `.squadron-dashboard-backup` (next to the app folder) when the dashboard starts or the next update runs. To do it by hand: `cp -a ../.squadron-dashboard-backup/. data/` then `sqndash --restart`. Make sure `.gitignore` is in the repo — it's a hidden file that's easy to miss when uploading |
| `sqndash --force-update` prints a reason but doesn't update (Windows) | The message says why. If it's `git reset failed`, close editors/terminals using files in the folder and retry. Full text: `type data\update-status.json` |
| Dashboard stopped after an update | On a Pi it restarts itself within 30 minutes (the update timer starts it), or run `sqndash --restart` now. Windows: `sqndash --restart` or `npm start` |
| Pi Force update button waits forever | Re-run `install.sh`, or SSH and run `sqndash --force-update` |

---

## Future updates

Ideas queued for releases after 1.6. Nothing here is built yet.

### Dashboard features

- **Themes:** a dark mode for evening parade nights, plus a "parade night" view showing tonight's programme.
- **Birthday and promotion shout-outs, and "cadet of the month"** panels, driven from the sheet.
- **Uniform and dress-of-the-day panel** beyond the weekly one (for example a picture of the uniform).
- **Weekly points movement:** flight progress bars, or "+12 this week", rather than only totals. Needs the dashboard to keep a little history.

### Future projects

- **Points tracker → API:** the 40F points spreadsheet feeding the dashboard through a small Apps Script endpoint that returns JSON, replacing the CSV scraping and adding proper validation.
- **Award and badge tracker:** DOJO-style gamification for cadet proficiency levels, with photo or instructor sign-off.
- **Multi-squadron version:** configurable enough that another unit can install it with one command and its own theme.

### Follow-ups

- Commit a `package-lock.json`: run `npm install` once in the project folder and commit the file it creates, so Pi installs are reproducible. The Dockerfile and CI then use it automatically.

---

## Licence

See [LICENSE](LICENSE) in the repository.

---

**Squadron Dashboard 1.6.0** — self-hosted, settings-safe updates, room-ready display for your unit.

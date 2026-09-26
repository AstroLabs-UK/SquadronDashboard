# Squadron Dashboard

Self-hosted room screen for UK cadet units. Built for **RAF Air Cadets (RAFAC / ATC)**, with themes for **Army Cadets (ACF)**, **Sea Cadets (SCC)**, **Combined Cadet Force (CCF)**, and **Volunteer Cadet Corps (VCC)**.

Clock, weather, BBC news, individual + flight leaderboard, events, uniform of the week, Instagram/embeds, and a **Chain of Command** panel. Configure everything from a phone-friendly `/edit` page. `/status` is for health checks.

Repo: [github.com/AstroLabs-UK/SquadronDashboard](https://github.com/AstroLabs-UK/SquadronDashboard)

---

## Install on a Raspberry Pi

One line on a fresh Pi OS box:

```bash
curl -fsSL https://raw.githubusercontent.com/AstroLabs-UK/SquadronDashboard/refs/heads/Stable/install.sh | bash
```

Then reboot:

```bash
sudo reboot
```

If you already have the repo:

```bash
git clone https://github.com/AstroLabs-UK/SquadronDashboard.git
cd SquadronDashboard
./install.sh
```

`install.sh` is safe to run again. It:

- Installs **Git** and **Node.js** if needed (does **not** install Chromium)
- Runs `npm install` and starts the app as a **systemd** service (starts on boot, restarts on crash)
- Sets up auto-update and optional auto-shutdown
- Puts `sqndash` on your PATH
- Prints a random **6-digit editor PIN** — write that down

Default URL after install: `http://localhost:3000` (also reachable as `http://<pi-ip>:3000` on your LAN).

### Kiosk mode (Chromium)

Chromium is **not** installed by `install.sh`. On Raspberry Pi OS:

```bash
sudo apt-get update
sudo apt-get install -y chromium-browser
```

Point Chromium at the board when the desktop starts:

```bash
chromium-browser --kiosk --noerrdialogs --disable-infobars http://localhost:3000
```

To **wait until a monitor is connected** (helps with slow TVs missing the loading screen):

```bash
# After install, path may be under the clone folder or /opt — use your install location:
./scripts/kiosk-wait-display.sh
```

Optional environment variables:

| Variable | Default | Meaning |
|----------|---------|---------|
| `SQNDASH_URL` | `http://localhost:3000` | Page to open |
| `SQNDASH_DISPLAY_WAIT` | `120` | Max seconds to wait for a display |

Autostart depends on your Pi OS version (often `~/.config/lxsession/LXDE-pi/autostart` or a desktop autostart entry). Put `@` in front of the command on older LXDE setups.

---

## Windows / Linux (no install script)

Install [Node.js LTS](https://nodejs.org/) (18+) and Git, then:

```bash
git clone https://github.com/AstroLabs-UK/SquadronDashboard.git
cd SquadronDashboard
npm install --omit=dev
npm start
```

- Display: http://localhost:3000  
- Settings: http://localhost:3000/edit  
- Status: http://localhost:3000/status  

Docker:

```bash
docker compose up -d --build
```

---

## Pages

| Page | URL |
|------|-----|
| Display | `http://<host>:3000/` |
| Edit | `http://<host>:3000/edit` (PIN protected once a PIN is set) |
| Status | `http://<host>:3000/status` |
| PIN unlock | `http://<host>:3000/pin` |

Port defaults to **3000** (`PORT`). Bind address: `SQNDASH_HOST` (default all interfaces).

---

## What you get

### Display board

- Local clock and date (works offline)
- Weather (Open-Meteo) or a custom weather embed
- Rotating panels: **leaderboard**, **BBC news**, **events**, **uniform**, **Instagram / custom embeds**, **Chain of Command**
- Important-information banner (optional)
- Loading animation (Astro Labs logo, or your own transparent PNG)
- Small **“No internet connection”** note (bottom-right) when offline
- Unit **theme** colours and crest in the header

### Unit themes

On `/edit` → **Unit theme**:

| Theme | Typical use |
|-------|-------------|
| RAF Air Cadets (RAFAC / ATC) | Default — navy / light blue, RAF roundel |
| Army Cadets (ACF) | Dark green / gold, Army Cadets logo |
| Sea Cadets (SCC) | Navy / cyan / gold |
| Combined Cadet Force (CCF) | Royal blue / gold — ranks grouped by RN / Army / RAF section |
| Volunteer Cadet Corps (VCC) | Navy / green |

Optional **custom unit crest** overrides the theme logo on the header (transparent PNG recommended).

Theme logos are cached on disk as a single active crest (`data/theme-cache/`). Packaged files under `public/` are used offline; otherwise they can be fetched from the GitHub repo when online.

### Chain of Command

- Levels (not per-person “reports to”) — everyone on a level reports to the level above
- Ranks, names, tags, photos (with crop guide) or pastel avatar colours
- Drag-and-drop levels (desktop); arrows on mobile; full-screen person editor on mobile
- Rank lists follow the selected theme (RAFAC, ACF, SCC, CCF by section, VCC)
- **Test preview** and **Print / PDF** on `/edit`; **Print / PDF** also on the board panel

### Settings (`/edit`)

- Squadron / unit name, location, widgets on/off, layout
- Leaderboard Google Sheet (CSV URL)
- Calendar: **ICS** link or **TimeTree** login + calendar + tags
- Uniform of the week (from calendar tags or manual items)
- Events, Instagram embed, custom embed widgets
- Screen notice / force reload
- **Export settings** / **Upload settings** (JSON backup; TimeTree password stripped from exports)
- On-device backup snapshot
- Loading logo upload
- Force update (downloads new code to disk; apply on next launch or **Restart now**)

### Status (`/status`)

- Server uptime, data file health, PIN status, git commit
- Upstream reachability (weather, news, leaderboard, calendar)
- Device stats when available (temp, disk, Wi‑Fi)
- **Update ready — restart to apply** when a staged update is waiting

Colours follow the unit theme.

---

## Configuration notes

### Leaderboard

Publish a Google Sheet as CSV. Expect columns for name (or similar) and points; flight column optional. Top individuals and flights are shown on the board. Empty data shows a clear message instead of a blank table.

### Calendar & events

- **ICS:** Google / Outlook / iCloud “secret address in iCal format”
- **TimeTree:** email + password on `/edit`, pick a calendar; optional label filters for events and uniform

### PIN

Set at install (random 6-digit). Change with:

```bash
sqndash --set-pin
```

Wrong PIN attempts are rate-limited.

### Updates

Stable channel follows version tags (`v1.8.0` style). Updates apply **on disk only** — the running display does not restart by itself. New code loads on the next process start or reboot.

- `/status` and `/edit` can show **Restart now** when an update is staged
- Or run: `sqndash --restart` / `sqndash --force-update`

Auto-update can be disabled with `AUTO_UPDATE=0`.

### Auto shutdown

Optional minutes-after-boot shutdown (configured on `/edit`). Read fresh from `data.json` at each boot.

---

## `sqndash` commands

| Command | Purpose |
|---------|---------|
| `sqndash` / `sqndash --start` | Start (or show status of) the service |
| `sqndash --stop` | Stop |
| `sqndash --restart` | Restart the dashboard process |
| `sqndash --set-pin` | Set / change editor PIN |
| `sqndash --check` | Version / update target |
| `sqndash --force-update` | Pull latest allowed release onto disk |

On Windows use `sqndash.cmd` from the project folder if the command is not on PATH.

---

## Data & backups

Runtime settings live in **`data/`** (not committed to git):

- `data/data.json` — live settings  
- `data/data.backup.json` — in-app backup  
- External snapshot folder (e.g. next to the app) used by install/update safety  
- `data/theme-cache/` — active theme crest only  

**Export settings** on `/edit` downloads a portable JSON file. **Upload settings** restores one. Large logos increase file size.

---

## Environment variables

| Variable | Purpose |
|----------|---------|
| `PORT` | HTTP port (default `3000`) |
| `SQNDASH_HOST` | Bind address |
| `DATA_DIR` | Settings directory (default `./data`) |
| `AUTO_UPDATE` | Set to `0` to disable auto-update checks |
| `SQNDASH_URL` | Kiosk script target URL |
| `SQNDASH_DISPLAY_WAIT` | Kiosk display wait (seconds) |

---

## Project layout (overview)

```
server.js            HTTP app
storage.js           Settings load / save / sanitize
autoUpdate.js        Staged updates (no forced restart)
updater.js           Update request files for supervised installs
lib/                 Calendar, news, leaderboard, auth, theme assets, …
public/              dashboard, edit, pin, status + theme logos
scripts/             kiosk-wait-display.sh, update helpers
data.example.json    Example settings shape
install.sh           Pi installer
update.sh            Host update helper
sqndash.sh / .ps1 / .cmd
test/                Node test suite
```

---

## Troubleshooting

| Symptom | What to try |
|---------|-------------|
| Can't open `/edit` | PIN set? Use the one from install, or `sqndash --set-pin` |
| Too many wrong PIN attempts | Wait a few minutes |
| No Chromium / black screen | Install `chromium-browser`; set kiosk autostart; try `scripts/kiosk-wait-display.sh` |
| Theme / crest wrong | Save on `/edit`; clear custom crest to use theme logo; check `public/` logos exist offline |
| Empty leaderboard | Sheet published as CSV? Check `/api/leaderboard` |
| Empty news | News widget enabled? Offline? Check `/api/news` |
| Settings lost after update | Restored from external backup on start when possible; use **Export settings** regularly |
| Update downloaded but board unchanged | Expected — restart service or use **Restart now** / reboot |
| Force update hangs on Pi | Re-run `install.sh`, or `sqndash --force-update` over SSH |
| TimeTree tags empty | Connect again on `/edit`; password still saved? |

---

## Licence

See [LICENSE](LICENSE).

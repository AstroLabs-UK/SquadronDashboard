# Squadron Dashboard

Self-hosted room screen for UK cadet units. Themes for **RAF Air Cadets (RAFAC / ATC)**, **Army Cadets (ACF)**, **Sea Cadets (SCC)**, **Combined Cadet Force (CCF)**, and **Volunteer Cadet Corps (VCC)**.

Clock, weather, BBC news, individual and flight leaderboard, events, uniform of the week, Instagram or custom embeds, and a **Chain of Command** panel. Configure from a phone-friendly `/edit` page. Health checks on `/status`.

**Version:** 1.9.0  
**Repo:** [github.com/AstroLabs-UK/SquadronDashboard](https://github.com/AstroLabs-UK/SquadronDashboard)

---

## Quick start (Raspberry Pi)

On a Pi with network access:

```bash
# Download then run (recommended — shows the first-time menu)
curl -fsSL https://raw.githubusercontent.com/AstroLabs-UK/SquadronDashboard/refs/heads/Stable/install.sh -o install.sh
bash install.sh
sudo reboot
```

Piping straight into `bash` (`curl … | bash`) skips the menu because there is no interactive terminal. Use the two-line form above for questions, or `INSTALL_NONINTERACTIVE=1 bash install.sh` for defaults.

Or from a clone:

```bash
git clone https://github.com/AstroLabs-UK/SquadronDashboard.git
cd SquadronDashboard
./install.sh
```

On **first run only**, the installer asks (interactive terminal):

- Install **Chromium** for kiosk?
- Install a **desktop** (for Raspberry Pi OS Lite)?
- Which **unit theme**?
- Choose an **editor PIN** (enter and confirm — this is saved for `/edit`)

Re-running `install.sh` later skips that menu. Non-interactive: `INSTALL_NONINTERACTIVE=1` or `./install.sh --yes`.

`install.sh` is safe to run again. It will:

- Install **Git** and **Node.js** if needed (**not** Chromium)
- Install npm dependencies and run the app as a **systemd** service (starts on boot, restarts on crash)
- Set up optional auto-update and auto-shutdown
- Put `sqndash` on your PATH
- Save the **editor PIN** you chose (or a random one only in non-interactive install)

After install: display at `http://localhost:3000`, settings at `http://localhost:3000/edit`.

### Kiosk (full-screen Chromium)

Chromium is **optional** — choose it in the first-run menu, or install later with apt. On Raspberry Pi OS:

```bash
sudo apt-get update
sudo apt-get install -y chromium-browser
```

Simple kiosk command:

```bash
chromium-browser --kiosk --noerrdialogs --disable-infobars \
  --password-store=basic \
  http://localhost:3000
```

`--password-store=basic` avoids the “Unlock keyring” dialog on many Pis.

To **wait for a monitor** before opening the browser (slow TVs):

```bash
./scripts/kiosk-wait-display.sh
```

| Environment variable | Default | Meaning |
|----------------------|---------|---------|
| `SQNDASH_URL` | `http://localhost:3000` | Page to open |
| `SQNDASH_DISPLAY_WAIT` | `120` | Max seconds to wait for a display |

Add the command to your desktop autostart (path depends on Pi OS version; older LXDE often uses `~/.config/lxsession/LXDE-pi/autostart` with `@` before the line).

---

## Windows / Linux (manual)

Install [Node.js LTS](https://nodejs.org/) (18+) and Git:

```bash
git clone https://github.com/AstroLabs-UK/SquadronDashboard.git
cd SquadronDashboard
npm install --omit=dev
npm start
```

| Page | URL |
|------|-----|
| Display | http://localhost:3000/ |
| Edit | http://localhost:3000/edit |
| Status | http://localhost:3000/status |

Docker:

```bash
docker compose up -d --build
```

---

## Pages

| Page | Path | Notes |
|------|------|--------|
| Display | `/` | Room screen — no editor buttons |
| Edit | `/edit` | PIN protected once a PIN is set |
| Status | `/status` | Health, upstream checks, staged updates |
| PIN | `/pin` | Unlock editor session |

Port: `PORT` (default `3000`). Bind address: `SQNDASH_HOST` (default all interfaces).

---

## Features

### Display board

- Local clock and date (works without internet)
- Weather via Open-Meteo, or a custom weather embed
- Rotating widgets: **leaderboard**, **BBC news**, **events**, **uniform**, **Instagram / embeds**, **Chain of Command**
- Optional important-information banner
- Loading animation (default Astro Labs logo, or your PNG)
- Small **No internet connection** notice (bottom-right) when offline
- Header uses unit **theme colours** and crest

### Unit themes (`/edit`)

| Theme | Look |
|-------|------|
| RAF Air Cadets | Navy / light blue, RAF roundel |
| Army Cadets | Dark green / gold |
| Sea Cadets | Navy / cyan / gold |
| Combined Cadet Force | Royal blue / gold; ranks by RN / Army / RAF section |
| Volunteer Cadet Corps | Navy / green |

Optional **custom unit crest** overrides the theme logo (transparent PNG recommended). Clear it to use the theme crest again.

Theme crests are kept as a single active file under `data/theme-cache/`. Files in `public/` work offline; otherwise the app can fetch the matching logo from GitHub when online.

### Chain of Command

- Level-based hierarchy (everyone on a level reports to the level above)
- Rank, name, role tag, photo (crop guide) or pastel colour avatar
- Desktop: drag levels and people; mobile: level arrows and full-screen person editor
- Rank lists follow the selected theme
- **Test preview** and **Print / PDF** on `/edit` only (not on the room display)

### Calendar and tags

- **ICS** secret link (Google, Outlook, iCloud, …), or **TimeTree** email + password
- **Tags to show on the board** — filters which TimeTree events appear in the **Events** panel. Leave all unchecked to show every event; tick tags to limit to those labels
- **Uniform tags** — separate; used for “uniform of the week”
- Time zone and “days ahead” controls

### Leaderboard

Google Sheet published as CSV (name + points; optional flight column). Empty data shows a clear message on the board. Top rows use gold / silver / bronze highlighting.

### Backup and branding

- **Export settings** / **Upload settings** — JSON backup (TimeTree password stripped from exports)
- On-device backup snapshot
- Custom **loading logo** (PNG with transparent background preferred)

### Updates

Stable follows version tags. Updates are **downloaded to disk only** — the display does not restart by itself. Apply with **Restart now** on `/edit` or `/status`, reboot, or `sqndash --restart`.

Disable auto-check with `AUTO_UPDATE=0`.

---

## `sqndash` commands

| Command | Purpose |
|---------|---------|
| `sqndash` (no args) | Show help |
| `sqndash --start` | Start the dashboard service |
| `sqndash --stop` | Stop |
| `sqndash --restart` | Restart the process |
| `sqndash --set-pin` | Set or change editor PIN |
| `sqndash --check` | Local / remote version info |
| `sqndash --force-update` | Pull latest allowed release onto disk |

Windows: use `sqndash.cmd` from the project folder if needed.

---

## Data layout

Runtime settings are under **`data/`** (not in git):

| Path | Role |
|------|------|
| `data/data.json` | Live settings |
| `data/data.backup.json` | In-app backup |
| `data/theme-cache/` | Active theme crest |
| External snapshot folder | Safety copy used by install/update |

---

## Environment variables

| Variable | Purpose |
|----------|---------|
| `PORT` | HTTP port (default `3000`) |
| `SQNDASH_HOST` | Bind address |
| `DATA_DIR` | Settings directory (default `./data`) |
| `AUTO_UPDATE` | Set `0` to disable auto-update checks |
| `SQNDASH_URL` | Kiosk script URL |
| `SQNDASH_DISPLAY_WAIT` | Kiosk display wait (seconds) |

---

## Project layout

```
server.js              HTTP application
storage.js             Settings load / save / sanitize
autoUpdate.js          Staged updates (no forced restart)
updater.js             Supervised update requests
lib/                   Calendar, news, leaderboard, auth, themes, …
public/                dashboard, edit, pin, status + logos
scripts/               kiosk-wait-display.sh, update helpers
routes/                API route modules
data.example.json      Example settings shape
install.sh             Pi installer
update.sh              Host update helper
sqndash.sh / .ps1 / .cmd
test/                  Node test suite
```

---

## Troubleshooting

| Symptom | What to try |
|---------|-------------|
| Cannot open `/edit` | Enter the install PIN, or run `sqndash --set-pin` |
| Too many wrong PIN attempts | Wait a few minutes |
| Unlock keyring dialog | Use `--password-store=basic` on Chromium, or set an empty Login keyring password in Passwords and Keys |
| Black screen / no browser | Install Chromium; configure autostart; try `scripts/kiosk-wait-display.sh` |
| Wrong theme or crest | Save on `/edit`; clear custom crest to restore theme logo |
| Empty leaderboard | Publish sheet as CSV; open `/api/leaderboard` |
| Empty or offline news | Enable the news widget; check network and `/api/news` |
| Events missing | Events widget on? TimeTree tags filter too strict? |
| Settings lost after update | Use **Export settings** regularly; app restores from safety backup when possible |
| Code updated but board unchanged | Restart the service or reboot (updates are staged until then) |
| Force update hangs on Pi | Re-run `install.sh`, or `sqndash --force-update` over SSH |

---

## Licence

See [LICENSE](LICENSE). Copyright (c) 2026 AstroLabs.

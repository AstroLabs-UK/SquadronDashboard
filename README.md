# Squadron Dashboard

Self-hosted room screen for RAF Air Cadets (or similar units). Clock, weather, BBC news, individual + flight leaderboard, events, Instagram, and a few embed slots. Settings live on a phone-friendly `/edit` page. `/status` is for health checks.

Repo: [github.com/AstroLabs-UK/SquadronDashboard](https://github.com/AstroLabs-UK/SquadronDashboard)

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

`install.sh` is safe to run again. It installs Node if needed, runs the app as a systemd service (starts on boot, restarts on crash), sets up auto-update and auto-shutdown, and puts `sqndash` on your PATH. At the end it prints a random 6-digit editor PIN. Write that down.

### Kiosk mode

Point Chromium at the board when the desktop comes up:

```bash
chromium-browser --kiosk --noerrdialogs --disable-infobars http://localhost:3000
```

Autostart file depends on your Pi OS version (often `~/.config/lxsession/LXDE-pi/autostart`, with `@` in front of the line on older setups). The app reloads itself after an update, so you rarely need to touch the screen.

## Windows / Linux (no install script)

Install [Node.js LTS](https://nodejs.org/) and Git, then:

```bash
git clone https://github.com/AstroLabs-UK/SquadronDashboard.git
cd SquadronDashboard
npm install --omit=dev
npm start
```

Open http://localhost:3000 for the display and http://localhost:3000/edit for settings.

Docker works too:

```bash
docker compose up -d --build
```

## What you get

| Page | URL |
|------|-----|
| Display | `http://<host>:3000/` |
| Edit | `http://<host>:3000/edit` (PIN protected once you set one) |
| Status | `http://<host>:3000/status` |

Default port is 3000. Override with `PORT`. Bind address with `SQNDASH_HOST` (default is all interfaces).

Once configured, most content looks after itself:

- Calendar from an ICS link or TimeTree (sign in on `/edit`, pick a calendar, optionally filter by tags)
- Uniform panel from `Uniform: …` lines in events, TimeTree tags you mark as uniform sources, or a typed list
- Leaderboard from a published Google Sheets CSV (top 5 individuals, top 3 flights)
- News, weather, Instagram, and custom embeds as rotating panels (each can be switched off)
- **Chain of Command** panel: levels (not per-person reports-to), ranks, photos, tags, drag-and-drop on desktop, mobile full-screen editor
- Custom **loading logo** (transparent PNG recommended) and Astro Labs loading animation
- Stale-source banner when the calendar feed is offline or only serving cached data
- Screen notice / force reload from `/edit`
- Backup download and restore as one JSON file (TimeTree password is stripped from downloads; large logos increase file size)

## After install

Open `http://<device-IP>:3000/edit` from anything on the same network.

### Core settings

| Setting | Notes |
|---------|--------|
| Squadron / unit name | Header text |
| Weather location | Name plus lat/lon |
| Leaderboard CSV URL | Publish the sheet as CSV first |
| "See all events" URL | QR on the events panel |
| Error report URL | QR when a panel fails; blank disables it |
| Auto shutdown (minutes) | Pi only; applies from next boot |
| Screen layout | Automatic, always full, or always compact |

### Calendar

Above the calendar fields there is a **Calendar source** dropdown: ICS import or TimeTree.

**ICS** (Google, Outlook, iCloud, anything with a subscribe link):

1. In Google Calendar, open Settings for the squadron calendar, scroll to Integrate calendar, copy **Secret address in iCal format**.
2. Paste it on `/edit`, Save, then Test calendar.

**TimeTree** (built in, no extra process):

1. Set source to TimeTree.
2. Enter email and password, click Connect.
3. Pick a calendar, tick the tags you want on the board (none checked = show everything).
4. Optional: mark some tags as **Uniform tags** so those event titles feed the Uniform panel.
5. Save, then Test calendar.

Credentials stay in `data/data.json` on the device. The public display never sees the password. Events refresh at most every 10 minutes. If TimeTree is briefly down, the last good copy is kept for up to a day.

This uses the same unofficial TimeTree web API as [timetree-live-ics](https://github.com/mr-onadasky/timetree-live-ics). A few HTTP calls on a timer, no browser automation. Fine to run on the same Pi as the rest of the app.

Tag names are refreshed about once a week in the background so renamed tags do not go stale in the edit UI.

### Uniform

Put `Uniform: Working blues` on its own line in an event description, or `[Uniform: PT kit]` in the title. Or use TimeTree uniform tags as above. Typed rows on `/edit` still work for one-offs.

### Leaderboard sheet

Publish as CSV (File → Share → Publish to web → CSV). The sheet needs Name and Points columns (or close equivalents). Paste the published URL into `/edit`.

### Chain of Command

On `/edit`, enable the **Chain of Command** widget and build the hierarchy by **level** (Level 1 = top). Everyone on a level reports to the level above — there is no per-person “reports to”. Drag people between levels (desktop) or use ▲ ▼ on levels (mobile). Tap a person on mobile to edit in a full-screen sheet. Ranks follow the RAFAC/ATC order and people are auto-sorted by rank within each level. Use **Test preview** and **Print / PDF** for a paper copy.

### Loading logo

At the bottom of `/edit`, upload a **transparent PNG** (preferred) for the boot animation. Images are resized on upload and replace any previous logo.

### PIN

`install.sh` creates one for you. Change it with:

```bash
sqndash --set-pin
```

Wrong PIN attempts lock out for a few minutes. Without a PIN, `/edit` is open to anyone on the network.

## Auto-update

Stable channel devices follow tagged releases (`v1.8.0` style). The Pi checks a couple of minutes after boot and every 30 minutes via a host timer. Windows / bare Node checks at launch and every 5 minutes (`AUTO_UPDATE=0` turns that off).

Updates are applied **on disk only** — the running display does **not** restart by itself. New code loads on the next launch or reboot. `/status` shows **Update ready — restart to apply** with a **Restart now** button when a staged update is waiting. You can also run `sqndash --restart`.

Before switching files, the new version has to answer a health check. If it does not, the previous version is put back and that release is skipped for a while so the device is not stuck in a loop.

A test device can track the **Update** branch instead of tags:

```bash
sqndash --channel update
```

Back to tags:

```bash
sqndash --channel stable
```

### Manual update

```bash
cd /path/to/SquadronDashboard
git fetch --tags origin
git reset --hard v1.8.0        # or origin/Stable
git clean -fd
npm install --omit=dev
# restart: npm start, or docker compose up -d --build
```

### Cutting a release (maintainers)

```bash
git checkout Stable && git pull
# bump version in package.json, update this README, merge, then:
git tag v1.8.0
git push origin v1.8.0
```

Tags must match `vMAJOR.MINOR.PATCH`. Anything else is ignored on the stable channel. Day-to-day work sits on the **Update** branch.

## `sqndash` commands

| Command | What it does |
|---------|----------------|
| `sqndash --check` / `--version` | Local git vs update target |
| `sqndash --update` | Pull newer version if available, then restart |
| `sqndash --force-update` | Re-apply the target even if it looks current |
| `sqndash --restart` | Restart only |
| `sqndash --set-pin [PIN]` | Set the `/edit` PIN |
| `sqndash --clear-pin` | Remove the PIN |
| `sqndash --channel [stable\|update]` | Show or change channel |
| `sqndash --help` | Help |

On Windows use `sqndash.cmd` or `.\sqndash.ps1` from the project folder (or put that folder on PATH).

## Status and health

`/status` refreshes about every 30 seconds: uptime, data sources, PIN status, calendar (including TimeTree name/tags when configured), and on a Pi CPU temp, memory, disk, Wi-Fi, and OS uptime.

`/healthz` is a cheap liveness check used by Docker and the update safety net.

## Project layout

```text
SquadronDashboard/
  server.js          Pages, settings API, security, route wiring
  routes/            weather, news, leaderboard, schedule, control, config, status, update, timetree
  lib/
    auth.js          Editor PIN
    security.js      Headers + rate limits
    calendar.js      ICS fetch + cache
    timetree.js      TimeTree login / calendars / labels / events
    ics.js           Parse ICS (including repeats)
    events.js        Merge typed + calendar events
    uniform.js       This week / next week uniform list
    cache.js         TTL cache, serve stale on error
    release.js       Stable tags vs Update branch
    canary.js        Health-check a new version before switching
  public/            dashboard, edit, pin, status HTML
  data/              Runtime settings (not in git)
  install.sh         Pi installer
  update.sh          Update helper used by the timer / force update
  sqndash.sh / .ps1 / .cmd
```

## Troubleshooting

| Symptom | What to try |
|---------|-------------|
| Can't open `/edit` | PIN set? Use the one from install, or `sqndash --set-pin` on the device |
| Too many wrong PIN attempts | Wait 5 minutes |
| `sqndash` not found on Windows | Run from the project folder: `.\sqndash.cmd --check` |
| Update failed its safety check | New version did not start, old one kept. Check logs, fix, tag again. `sqndash --force-update` retries |
| Devices not picking up a release | Is the tag `vX.Y.Z` pushed? `sqndash --check` shows the target. Update-channel devices ignore tags |
| Force update can't find remote | `git remote -v`, then `git fetch --tags origin` |
| Empty leaderboard | Sheet published as CSV? Name/Points headers? Open `/api/leaderboard` |
| Empty news | News ticked on `/edit`? Check `/api/news` |
| Settings gone after update | Restored from `.squadron-dashboard-backup` (next to the app folder) on start or next update |
| Dashboard stopped after update | Pi should restart within 30 minutes, or run `sqndash --restart`. Windows: `sqndash --restart` or `npm start` |
| Force update button hangs on Pi | Re-run `install.sh`, or SSH in and run `sqndash --force-update` |
| TimeTree tags empty after refresh | Password still saved? Connect once more on `/edit`, or wait for the weekly refresh |
| Want to wake a powered-off Pi from your phone | Visiting `:3000` cannot do that. Use a Wake-on-LAN app with the Pi's MAC on the same LAN (Ethernet is more reliable than Wi-Fi) |

## Licence

See [LICENSE](LICENSE).

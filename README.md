# Squadron Dashboard

A self-hosted screen for a squadron/unit room: clock, weather, news headlines, an individual + flight leaderboard, events, and Instagram — plus a mobile-friendly edit page you can update from any phone or laptop on the network, and a `/status` page for checking on its health.

Repo: https://github.com/AstroLabs-UK/SquadronDashboard

## Install (one command, from a fresh Raspberry Pi OS install)

```bash
curl -fsSL https://raw.githubusercontent.com/AstroLabs-UK/SquadronDashboard/refs/heads/main/install.sh | bash
```

This single command:
- Installs Docker if it isn't already present
- Clones this repository
- Builds and starts the dashboard in a Docker container (all dependencies bundled in the image - no `npm install` headaches, ever)
- Installs Chromium if needed, and sets it to launch automatically on boot in kiosk mode, pointed at the dashboard
- Sets up auto-shutdown (duration configurable on `/edit`, defaults to 2h45m after boot) and auto-update (checks this repo shortly after every boot, then every 30 minutes, and applies any changes automatically - your settings from `/edit` are never overwritten) as host-level systemd timers

Reboot when it finishes, and it comes up full-screen on its own:

```bash
sudo reboot
```

### Already have it cloned?

```bash
git clone https://github.com/AstroLabs-UK/SquadronDashboard.git
cd SquadronDashboard
./install.sh
```

Both routes end up in the same place, and `install.sh` is safe to re-run any time.

### Why Chromium isn't in a container too

Everything that's just "the app" (Node, Express, its dependencies) lives in Docker, so it's fully reproducible and there's nothing to install by hand. Chromium runs natively on the host instead, launched by the desktop's own autostart mechanism. Passing a container's output through to a physical HDMI display reliably - especially with Raspberry Pi OS Bookworm's default Wayland compositor - is fragile and inconsistent across Pi OS versions. Launching the browser natively and pointing it at the containerized app (`localhost:3000`) gets you the same one-command result with far fewer moving parts to go wrong on a screen you can't easily SSH into from across the room.

## Checking on it

```bash
sudo docker compose logs -f          # live logs
sudo docker compose restart          # restart the dashboard
sudo docker compose up -d --build    # manually rebuild after local changes
sudo systemctl status squadron-dashboard-update.timer     # auto-update timer
sudo systemctl status squadron-dashboard-shutdown.service # auto-shutdown timer
```

Or visit `http://<pi's IP>:3000/status` from any device on the network - it shows server uptime, current time, versions, and live health checks (weather API, BBC News, your leaderboard CSV, Instagram widget, `data.json`/backup, and update status), refreshing every 30 seconds. One failing check never breaks the rest of the page.

## Setting it up for your squadron/unit

Everything is done from `/edit` in a normal browser - no code editing needed. Go to `http://<pi's IP>:3000/edit` from any phone or laptop on the same network, and fill in:

- **Squadron/unit name** and **weather location** (name + latitude/longitude)
- **Leaderboard Google Sheets CSV link** — see below
- **"See all events" QR link** — shown on the right-hand side of the events panel; defaults to the cadet portal events page
- **Error report link** — shown as a QR code if a panel fails to load (e.g. a Google Form); leave blank to disable
- **Auto shutdown after (minutes)** — how long after boot the device powers itself off, defaults to 165 (2h45m). Takes effect from the next boot onwards, since the timer reads this value fresh at boot time rather than while it's already counting down
- **Instagram widget embed code** — paste a full embed snippet from a free widget service like [elfsight.com](https://elfsight.com) or [sociablekit.com](https://sociablekit.com); refreshes itself on screen every 10 minutes
- **Weather widget embed code (optional)** — paste an embed snippet (e.g. from [weatherwidget.io](https://weatherwidget.io)) to replace the built-in weather display with a live widget; leave blank to keep the simple built-in one
- **Important Information banner** — an enable toggle, optional title, and message, shown as a banner at the bottom of the screen. Off and invisible unless you turn it on and give it a message
- **Events list**

News is fixed to BBC News and isn't editable. Changes made on `/edit` are picked up by the display within about 10 seconds.

### Connecting your leaderboard

In your points tracker Google Sheet: **File > Share > Publish to web**, choose the specific sheet/tab with names and points, pick **CSV**, and paste that link into the "Leaderboard Google Sheets CSV link" field.

The dashboard expects a header row with a column containing "name" and a column containing "point" (case-insensitive). If your sheet also has a column containing "flight" (or similar), a second Flight leaderboard appears automatically alongside the individual one, grouping and summing points by whatever flight names are in your sheet - nothing is hardcoded. If there's no flight column, that side just shows "FLIGHT DATA UNAVAILABLE" without affecting the individual leaderboard. If your sheet has a pre-ranked "LEADERBOARD" section above a messier full list, the parser looks for a row with both "rank" and "name" columns first and reads straight down from there, keeping your sheet's own tie-breaking order.

## Layout

- **Left quarter:** weather — temperature, feels-like, and condition (or your custom weather widget), always visible
- **Right three-quarters:** rotates every 10 seconds through Leaderboard → News → Events → Instagram. The Leaderboard shows Individual and Flight side by side. Events show 3 at a time with their own internal rotation, with the "see all events" QR code fixed on the right. The Flight leaderboard shows the top 3 flights.
- **Bottom banner:** only appears when Important Information is enabled and has a message - otherwise takes up zero space

If weather, news, or the leaderboard fails to load, it shows a short message and, if you've set an error report link, a QR code linking to it.

## Updating

From anywhere on the Pi (SSH or a terminal), run:

```bash
sqndash --update
```

That downloads the latest version from GitHub and restarts the dashboard; the screen reloads itself a few seconds later. If you're already on the latest version it just says so. Other commands: `sqndash --restart` (restart only) and `sqndash --help`.

The Pi also checks by itself 2 minutes after every boot and then every 30 minutes, so pushing to GitHub is enough. Your settings are never touched by an update: they live in the `data/` folder, which is in `.gitignore`, so it is never committed and never overwritten. (`sqndash` is installed by `install.sh`, and refreshed by every update, so re-running `bash install.sh` once is all it takes to get it.)

## Power cuts, restarts and updates: your settings are kept

Everything saved on `/edit` (name, weather location, events, links, banner, and so on) is stored in `data/data.json` and survives power cuts, restarts and updates.

- Settings are never held only in memory - every page load and every save reads and writes straight to disk. In Docker, `data/` is bind-mounted into the container, so it lives on the host's storage.
- Saves are atomic and flushed to disk (write to a temp file, `fsync`, then rename it into place), so a power cut can never leave `data.json` half-written. It is either the complete old version or the complete new one.
- A second copy is kept at `data/data.backup.json` on every save. If `data.json` is ever found empty or corrupted on boot, the server restores it from the backup automatically.
- If both files are somehow lost, the server falls back to built-in defaults rather than crashing.
- Settings added in later updates are filled in with defaults, so an older settings file keeps working after an update.
- Invalid values (for example a blank or non-numeric latitude) are ignored on save and the previous value is kept, so a bad save can't break the screen.
- Older versions kept `data.json` next to `server.js`. On first start it is copied into `data/` automatically.

No manual recovery steps needed - just power it back on.

## Alternative: without Docker

If you'd rather not use Docker at all, `setup.sh` installs Node.js directly and runs the app as a systemd service instead:

```bash
curl -fsSL https://raw.githubusercontent.com/AstroLabs-UK/SquadronDashboard/refs/heads/main/setup.sh | bash
```

This path handles its own auto-shutdown/auto-update via host-level systemd timers (same mechanism as the Docker path, just restarting a systemd service instead of a container) rather than in-app logic. Use whichever suits you - they're independent, don't mix them on the same machine.

### Kiosk autostart (non-Docker path)

Point the Pi's browser at `http://localhost:3000` on boot:

```bash
chromium-browser --kiosk --noerrdialogs --disable-infobars http://localhost:3000
```

Add that command to your desktop environment's autostart (e.g. `~/.config/lxsession/LXDE-pi/autostart` on older Raspberry Pi OS, or `~/.config/labwc/autostart` on Bookworm and later). The Docker path (`install.sh`) sets this up for you automatically - this manual step is only needed if you used `setup.sh` instead.

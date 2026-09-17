# Squadron Dashboard

A self-hosted screen for a squadron/unit room: clock, weather, news headlines, a top-5 leaderboard, events, and socials — plus a mobile-friendly edit page you can update from any phone or laptop on the network.

Repo: https://github.com/AstroLabs-UK/SquadronDashboard

## Install (one command)

On a Raspberry Pi (or any Linux machine) with internet connected, run:

```bash
curl -fsSL https://raw.githubusercontent.com/AstroLabs-UK/SquadronDashboard/refs/heads/main/setup.sh | bash
```

This single command:
- Clones this repository
- Installs Node.js if it isn't already present
- Installs the app's dependencies
- Grants the passwordless permission needed for the auto-shutdown feature
- Installs a systemd service so the dashboard starts automatically on every boot and restarts itself if it ever crashes

When it finishes, it prints the two URLs you need:

```
Display:  http://localhost:3000
Edit:     http://<this device's IP>:3000/edit
```

That's it — nothing else to install or configure to get it running.

### Already have it cloned?

If you'd rather clone it yourself first:

```bash
git clone https://github.com/AstroLabs-UK/SquadronDashboard.git
cd SquadronDashboard
./setup.sh
```

Both routes end up in the same place. `setup.sh` is safe to re-run any time — it skips steps that are already done.

### Updating later

```bash
cd SquadronDashboard
git pull
./setup.sh
```

## Kiosk autostart (showing it on a screen)

Point the device's browser (Chromium in kiosk mode works well) at `http://localhost:3000`:

```bash
chromium-browser --kiosk --noerrdialogs --disable-infobars http://localhost:3000
```

Add that command to your desktop environment's autostart (e.g. `~/.config/lxsession/LXDE-pi/autostart` on Raspberry Pi OS) so it launches automatically after boot, alongside the systemd service that keeps the server itself running.

## Setting it up for your squadron/unit

Everything below is done from the `/edit` page in a normal browser — no code editing needed.

Go to `http://<device's IP>:3000/edit` from any phone or laptop on the same network, and fill in:

- **Squadron/unit name** and **weather location** (name + latitude/longitude)
- **Leaderboard Google Sheets CSV link** — see below
- **"More events" QR link** — shown as a QR code when there are more than 2 events; point it at a full calendar or events page
- **Error report link** — shown as a QR code if a panel fails to load (e.g. a Google Form); leave blank to disable
- **Instagram widget embed code** — paste a full embed snippet from a free widget service like [elfsight.com](https://elfsight.com) or [sociablekit.com](https://sociablekit.com) (their Instagram Feed app, on the free plan); paste the whole script + div they give you into the box, and it'll appear on screen and refresh itself every 10 minutes automatically
- **Events list** and **social media links** (Facebook, X)

News is fixed to BBC News and isn't editable. Changes made on `/edit` are picked up by the display within about 10 seconds.

### Connecting your leaderboard

In your points tracker Google Sheet: **File > Share > Publish to web**, choose the specific sheet/tab with names and points, pick **CSV**, and paste that link into the "Leaderboard Google Sheets CSV link" field.

The dashboard expects a header row with a column containing "name" and a column containing "point" (case-insensitive) — it works with most simple points-tracker layouts as long as those two columns exist. If your sheet has a pre-ranked "LEADERBOARD" section above a messier full list, the parser looks for a row with both "rank" and "name" columns first and reads straight down from there, keeping your sheet's own tie-breaking order.

## Layout

- **Left third:** weather — temperature, feels-like, and condition, always visible
- **Right two-thirds:** rotates every 10 seconds through Leaderboard → News → Events → Follow Us

If a panel (weather, news, or leaderboard) fails to load, it shows a short message and, if you've set an error report link, a QR code linking to it.

## Auto shutdown

The dashboard automatically powers the device off 2 hours 45 minutes after the server starts (handy if it's normally switched on manually and then forgotten about). `setup.sh` configures the passwordless permission this needs automatically.

If you set it up manually instead, add the permission yourself:

```bash
sudo visudo
```

Add this line at the bottom (replace `pi` with whichever user runs the server):

```
pi ALL=(ALL) NOPASSWD: /sbin/shutdown
```

Without this step, the server still runs fine — you'll just see a warning in the console and the device won't power itself off automatically.

## Power cuts and corrupted settings

The device may get switched off at the wall at any point, with no warning. The app is built around that:

- Settings are never held only in memory — every page load and every save reads and writes straight to `data.json` on disk.
- Saves are atomic (write to a temp file, then rename it into place), so a mid-write power cut can never leave `data.json` half-written or corrupted.
- A redundant copy is kept at `data.backup.json` on every save. If `data.json` is ever found corrupted on boot, the server automatically restores it from the backup.
- If both files are somehow lost, the server falls back to sensible built-in defaults rather than crashing, and immediately writes those back to disk.

No manual recovery steps needed — just power it back on.

## Checking on it later

```bash
sudo systemctl status squadron-dashboard   # is it running?
journalctl -u squadron-dashboard -f        # live logs
sudo systemctl restart squadron-dashboard  # restart manually if needed
```

## Manual install (without setup.sh)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
git clone https://github.com/AstroLabs-UK/SquadronDashboard.git
cd SquadronDashboard
npm install
npm start
```

You'll then need to add the sudoers line above yourself, and optionally set up a systemd service or `pm2` to keep it running across reboots:

```bash
sudo npm install -g pm2
pm2 start server.js --name squadron-dashboard
pm2 startup
pm2 save
```

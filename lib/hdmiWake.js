// Watch Linux DRM connectors for HDMI (and similar) outputs coming online.
// Used to wake the room-screen sleep cover when a TV is powered on — not when it
// turns off. Browsers on a kiosk TV have no reliable "HDMI plugged in" event, so
// we read /sys/class/drm from the server.
//
// Status files look like: /sys/class/drm/card0-HDMI-A-1/status → "connected" | "disconnected"
const fs = require('fs');
const path = require('path');

const DRM_DIR = '/sys/class/drm';
const DEFAULT_MS = 2000;

function listConnectorStatuses() {
  const out = {};
  try {
    if (!fs.existsSync(DRM_DIR)) return out;
    for (const name of fs.readdirSync(DRM_DIR)) {
      // card0-HDMI-A-1, card0-HDMI-A-2, card1-DP-1, card0-DVI-I-1, …
      if (!/^card\d+-/i.test(name)) continue;
      if (/^card\d+$/i.test(name)) continue;
      const statusPath = path.join(DRM_DIR, name, 'status');
      try {
        const raw = fs.readFileSync(statusPath, 'utf8').trim().toLowerCase();
        if (raw === 'connected' || raw === 'disconnected' || raw === 'unknown') {
          out[name] = raw;
        }
      } catch (e) { /* connector disappeared mid-read */ }
    }
  } catch (e) { /* no drm (Windows / some Docker hosts) */ }
  return out;
}

/**
 * @param {{ onConnect: (info: { connector: string }) => void, intervalMs?: number, log?: Function }} opts
 * @returns {{ stop: () => void, snapshot: () => object } | null}
 */
function startHdmiWake({ onConnect, intervalMs = DEFAULT_MS, log = console.log } = {}) {
  if (typeof onConnect !== 'function') return null;
  if (!fs.existsSync(DRM_DIR)) {
    log('[hdmi] no /sys/class/drm — HDMI wake disabled (not Linux DRM)');
    return null;
  }

  let prev = listConnectorStatuses();
  const keys = Object.keys(prev);
  if (!keys.length) {
    log('[hdmi] no DRM connectors found — HDMI wake idle');
  } else {
    log('[hdmi] watching ' + keys.join(', ') + ' for connect (TV power-on)');
  }

  const timer = setInterval(() => {
    const now = listConnectorStatuses();
    for (const name of Object.keys(now)) {
      const was = prev[name];
      const is = now[name];
      // Only wake on a real off → on edge. First sighting of a connector while already
      // connected is baseline, not a wake. "unknown" is ignored either way.
      if (is === 'connected' && was === 'disconnected') {
        log('[hdmi] ' + name + ' connected — waking display');
        try { onConnect({ connector: name }); } catch (e) {
          console.warn('[hdmi] onConnect failed', e && e.message ? e.message : e);
        }
      }
    }
    prev = now;
  }, Math.max(500, intervalMs));

  // Do not keep the event loop alive solely for this on some hosts
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop: () => clearInterval(timer),
    snapshot: () => ({ ...prev })
  };
}

module.exports = { startHdmiWake, listConnectorStatuses };

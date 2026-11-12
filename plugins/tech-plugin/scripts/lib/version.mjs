// Is this session running the tech-plugin version that is installed?
//
// WHY: Claude Code loads a plugin when a session starts. After `/plugin
// update` in an open session, the session keeps running the old copy, and a
// command quietly gives old results ("already up to date"). The commands check
// this first and ask for a new session.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function cmpVersion(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

export function runningVersion(pluginRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

// null when up to date (or unknown); otherwise a message for the person.
export function pluginUpdate(pluginRoot, home = process.env.HOME || os.homedir()) {
  const running = runningVersion(pluginRoot);
  if (!running) return null;
  let installed = null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const [k, v] of Object.entries(j.plugins || {})) {
      if (!/^tech-plugin@/.test(k)) continue;
      for (const e of Array.isArray(v) ? v : [v]) if (e && e.version && (!installed || cmpVersion(e.version, installed) > 0)) installed = e.version;
    }
  } catch {
    return null;
  }
  if (!installed || cmpVersion(installed, running) <= 0) return null;
  return { running, installed, message: `tech-plugin v${installed} is installed, but this session still runs v${running}. Quit Claude Code and start a new session, then run the command again.` };
}

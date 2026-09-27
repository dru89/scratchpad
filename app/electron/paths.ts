// Where the daemon lives and listens. Mirrors crates/core/src/paths.rs, so
// the app, the CLI and the daemon agree without configuration.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function dataDir(): string {
  if (process.env.SCRATCHPAD_DATA_DIR) return process.env.SCRATCHPAD_DATA_DIR;
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'dev.unremarkable.scratchpad');
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'scratchpad');
}

export function socketPath(): string {
  if (process.env.SCRATCHPAD_SOCKET) return process.env.SCRATCHPAD_SOCKET;
  if (process.platform !== 'darwin' && process.env.XDG_RUNTIME_DIR) {
    return join(process.env.XDG_RUNTIME_DIR, 'scratchpad', 'daemon.sock');
  }
  return join(dataDir(), 'daemon.sock');
}

/** The daemon binary: an explicit override, a bundled copy, or an installed one. */
export function daemonBinary(): string {
  if (process.env.SCRATCHPAD_DAEMON) return process.env.SCRATCHPAD_DAEMON;
  const candidates = [
    process.resourcesPath && join(process.resourcesPath, 'bin', 'scratchpadd'),
    join(homedir(), '.local', 'bin', 'scratchpadd'),
    join(homedir(), '.cargo', 'bin', 'scratchpadd'),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p)) ?? 'scratchpadd';
}

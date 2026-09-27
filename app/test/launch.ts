// How the specs start the app: from this checkout, or as a packaged build
// when SCRATCHPAD_E2E_APP names its executable (CI tests the macOS build this
// way). A packaged build brings its own CLI and daemon, and the specs use
// those too.

import { _electron as electron } from '@playwright/test';
import { dirname, join, resolve } from 'node:path';

const packaged = process.env.SCRATCHPAD_E2E_APP;

/** Where the scratchpad and scratchpadd binaries come from. */
export const binDir = packaged
  ? resolve(dirname(packaged), ...(process.platform === 'darwin' ? ['..', 'Resources', 'bin'] : ['resources', 'bin']))
  : join(__dirname, '..', '..', 'target', 'debug');

export function launch(env: Record<string, string>) {
  // SCRATCHPAD_E2E_SCALE renders at that device scale, for sharp screenshots
  // from a virtual display.
  const scale = process.env.SCRATCHPAD_E2E_SCALE;
  const args = scale ? [`--force-device-scale-factor=${scale}`] : [];
  if (packaged) return electron.launch({ executablePath: packaged, args, env });
  // On Linux: Wayland normally, X11 when there's no Wayland display, as under
  // `npm run test:e2e:headless`, which keeps the run off your screen.
  if (process.platform === 'linux') args.push(`--ozone-platform=${process.env.WAYLAND_DISPLAY ? 'wayland' : 'x11'}`);
  return electron.launch({ args: [...args, '.'], cwd: resolve(__dirname, '..'), env });
}

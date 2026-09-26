// Float-on-top and focus on KDE Plasma under Wayland, where apps can't ask
// for either themselves. A one-shot KWin script finds the window by pid and
// caption and sets it (docs/research.md#platform-gotchas). Elsewhere,
// Electron's own calls work.

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const isKdeWayland =
  process.platform === 'linux' &&
  (process.env.XDG_CURRENT_DESKTOP ?? '').includes('KDE') &&
  process.env.XDG_SESSION_TYPE === 'wayland';

let counter = 0;

/** Sets keep-above and/or activates the window with this pid and caption. */
export async function kwinApply(pid: number, caption: string, opts: { keepAbove?: boolean; activate?: boolean }) {
  const name = `scratchpad-${process.pid}-${++counter}`;
  const dir = mkdtempSync(join(tmpdir(), 'scratchpad-kwin-'));
  const file = join(dir, 'script.js');
  const statements = [
    opts.keepAbove === undefined ? '' : `w.keepAbove = ${opts.keepAbove ? 'true' : 'false'};`,
    opts.activate ? 'workspace.activeWindow = w;' : '',
  ].join(' ');
  writeFileSync(
    file,
    `for (const w of workspace.windowList()) {
       if (w.pid === ${pid} && w.caption === ${JSON.stringify(caption)}) { ${statements} }
     }`,
  );
  try {
    const { stdout } = await run('qdbus6', ['org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting.loadScript', file, name]);
    const id = stdout.trim();
    await run('qdbus6', ['org.kde.KWin', `/Scripting/Script${id}`, 'org.kde.kwin.Script.run']);
  } finally {
    await run('qdbus6', ['org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting.unloadScript', name]).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

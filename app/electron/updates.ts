// Updates on macOS. The packaged app checks GitHub Releases at launch and
// every few hours, downloads a new version in the background, and installs
// it when the app quits or when you choose Restart to Update. Squirrel.Mac
// only accepts an update signed like the running app, so this needs the
// signed builds from CI.

import { app, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

let ready = false;

/** Whether this build updates itself: packaged, on macOS, and not a test run. */
export const updatesEnabled = () =>
  app.isPackaged && process.platform === 'darwin' && !process.env.SCRATCHPAD_APP_STATE_DIR;

export const updateReady = () => ready;

/** Starts checking. `onReady` runs once a downloaded update is waiting. */
export function startUpdates(onReady: () => void) {
  if (!updatesEnabled()) return;
  autoUpdater.on('update-downloaded', () => {
    ready = true;
    onReady();
  });
  autoUpdater.on('error', (e) => console.error('scratchpad: update check failed:', e.message));
  const check = () => void autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, CHECK_EVERY_MS);
}

/** Check for Updates… in the app menu: the same check, with an answer either way. */
export async function checkNow() {
  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo.version;
    if (!latest || latest === app.getVersion()) {
      await dialog.showMessageBox({ message: "You're up to date", detail: `scratchpad ${app.getVersion()} is the latest version.` });
    } else {
      await dialog.showMessageBox({
        message: ready ? `scratchpad ${latest} is ready to install` : `Downloading scratchpad ${latest}`,
        detail: ready
          ? 'Choose Restart to Update in the scratchpad menu, or it installs the next time scratchpad quits.'
          : 'Restart to Update appears in the scratchpad menu when it has downloaded.',
      });
    }
  } catch (e) {
    await dialog.showMessageBox({ type: 'warning', message: "Couldn't check for updates", detail: String(e) });
  }
}

/** Restart to Update. `beforeQuit` lets the windows that hide on close actually close. */
export function restartToUpdate(beforeQuit: () => void) {
  beforeQuit();
  autoUpdater.quitAndInstall();
}

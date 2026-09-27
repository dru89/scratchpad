// End-to-end: the real app, a real daemon, and the real CLI standing in for
// agents and the hotkey, all in a throwaway data directory. Needs a display,
// real or virtual.
//
//   cargo build --workspace && npm run test:e2e:headless

import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { binDir, launch } from './launch';

const cli = join(binDir, 'scratchpad');
const shots = process.env.SCRATCHPAD_SHOTS;

let dir: string;
let env: Record<string, string>;
let app: ElectronApplication;

interface Summary {
  id: string;
  title: string;
  state: string;
}

function run(...args: string[]): string {
  return execFileSync(cli, args, { env, encoding: 'utf8' });
}

function list(...flags: string[]): Summary[] {
  return JSON.parse(run('--json', 'list', ...flags));
}

async function windowOf(kind: string): Promise<Page> {
  await expect.poll(() => app.windows().some((w) => w.url().includes(`kind=${kind}`))).toBe(true);
  return app.windows().find((w) => w.url().includes(`kind=${kind}`))!;
}

async function isVisible(kind: string): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }, kind) => {
    return BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().includes(`kind=${kind}`) && w.isVisible());
  }, kind);
}

function editorText(page: Page) {
  return page.locator('.cm-content').innerText();
}

async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
}

test.describe.serial('scratchpad app', () => {
  test.beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'scratchpad-e2e-'));
    env = {
      ...(process.env as Record<string, string>),
      SCRATCHPAD_DATA_DIR: join(dir, 'data'),
      SCRATCHPAD_SOCKET: join(dir, 'daemon.sock'),
      SCRATCHPAD_APP_STATE_DIR: join(dir, 'app'),
      SCRATCHPAD_DAEMON: join(binDir, 'scratchpadd'),
      SCRATCHPAD_IDLE_MS: '1500',
    };
    app = await launch(env);
  });

  test.afterAll(async () => {
    // Quit the way the menu does. Closing windows only hides the main and
    // capture windows, by design.
    if (app) {
      const proc = app.process();
      const exited = new Promise<boolean>((resolve) => {
        if (proc.exitCode !== null) return resolve(true);
        proc.once('exit', () => resolve(true));
        setTimeout(() => resolve(false), 10_000);
      });
      await app.evaluate(({ app }) => app.quit()).catch(() => {});
      expect(await exited, 'the app should exit when asked to quit').toBe(true);
    }
    try {
      run('daemon', 'stop');
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  test('typing in the main window creates a draft', async () => {
    const main = await windowOf('main');
    await main.locator('.cm-content').click();
    await main.keyboard.type('# Hello from the app\n\nFirst thoughts go here.');
    await expect.poll(() => list().map((d) => d.title)).toContain('Hello from the app');
    await expect(main.locator('.item-title', { hasText: 'Hello from the app' })).toBeVisible();
    await expect(main.locator('.title-text')).toHaveText('Hello from the app');
  });

  test('agent edits show up live in the open draft', async () => {
    const main = await windowOf('main');
    const id = list().find((d) => d.title === 'Hello from the app')!.id;
    run('append', id, 'A line from an agent.');
    await expect.poll(() => editorText(main)).toContain('A line from an agent.');
    // Typing continues where the cursor was, after the agent's edit merged.
    await main.keyboard.type(' (typed after)');
    await expect.poll(() => run('show', id)).toContain('First thoughts go here. (typed after)');
  });

  test('the sidebar follows drafts created elsewhere', async () => {
    const main = await windowOf('main');
    run('new', '# Made by the CLI');
    await expect(main.locator('.item-title', { hasText: 'Made by the CLI' })).toBeVisible();
    await main.locator('.item-title', { hasText: 'Made by the CLI' }).click();
    await expect.poll(() => editorText(main)).toContain('Made by the CLI');
    await shot(main, 'main-window');
  });

  test('the capture hotkey path opens the capture window, and Done files the draft', async () => {
    run('capture');
    const capture = await windowOf('capture');
    await expect.poll(() => isVisible('capture')).toBe(true);
    await capture.locator('.cm-content').click();
    await capture.keyboard.type('Quick thought from the hotkey');
    await expect.poll(() => list().map((d) => d.title)).toContain('Quick thought from the hotkey');
    await shot(capture, 'capture-window');
    await capture.keyboard.press('ControlOrMeta+Enter');
    await expect.poll(() => isVisible('capture')).toBe(false);
    expect(await editorText(capture)).not.toContain('Quick thought');
  });

  test('an idle capture window opens on a new draft; a pinned one stays', async () => {
    run('capture');
    const capture = await windowOf('capture');
    await capture.locator('.cm-content').click();
    await capture.keyboard.type('Pinned note');
    await capture.keyboard.press('ControlOrMeta+Shift+P');
    await capture.keyboard.press('Escape');
    await expect.poll(() => isVisible('capture')).toBe(false);
    await capture.waitForTimeout(2000);
    run('capture');
    await expect.poll(() => isVisible('capture')).toBe(true);
    await expect.poll(() => editorText(capture)).toContain('Pinned note');

    await capture.keyboard.press('ControlOrMeta+Shift+P'); // unpin
    await capture.keyboard.press('Escape');
    await capture.waitForTimeout(2000);
    run('capture');
    await expect.poll(() => editorText(capture)).not.toContain('Pinned note');
    expect(list().map((d) => d.title)).toContain('Pinned note');
    await capture.keyboard.press('Escape');
  });

  test('a draft emptied before moving on is discarded', async () => {
    const main = await windowOf('main');
    await main.bringToFront();
    await main.keyboard.press('ControlOrMeta+n');
    await main.keyboard.type('temporary');
    await expect.poll(() => list().map((d) => d.title)).toContain('temporary');
    await main.keyboard.press('ControlOrMeta+a');
    await main.keyboard.press('Backspace');
    await main.keyboard.press('ControlOrMeta+n');
    await expect.poll(() => list().map((d) => d.title)).not.toContain('temporary');
    expect(list().some((d) => d.title === 'New draft')).toBe(false);
  });

  test('archive moves the open draft out of the Inbox', async () => {
    const main = await windowOf('main');
    await main.locator('.item-title', { hasText: 'Made by the CLI' }).click();
    await main.keyboard.press('ControlOrMeta+Shift+A');
    await expect.poll(() => list('--archived').map((d) => d.title)).toContain('Made by the CLI');
    await expect(main.locator('.item-title', { hasText: 'Made by the CLI' })).toHaveCount(0);
    await main.keyboard.press('ControlOrMeta+2');
    await expect(main.locator('.item-title', { hasText: 'Made by the CLI' })).toBeVisible();
    await main.keyboard.press('ControlOrMeta+1');
  });

  test('copy as rich text puts HTML on the clipboard', async () => {
    const main = await windowOf('main');
    await main.keyboard.press('ControlOrMeta+n');
    await main.keyboard.type('| a | b |\n| - | - |\n| 1 | 2 |\n\n**bold**');
    await expect.poll(() => list().some((d) => d.title === 'a | b')).toBe(true);
    await main.keyboard.press('ControlOrMeta+Shift+C');
    await expect(main.locator('#toast')).toHaveText('Copied as rich text');
    const html = await app.evaluate(async ({ clipboard }) => {
      const [item] = await clipboard.read();
      return item.types.includes('text/html') ? (item.getType('text/html') as Promise<Blob>).then((b) => b.text()) : '';
    });
    expect(html).toContain('<table>');
    expect(html).toContain('<strong>bold</strong>');
  });

  test('a draft opened in its own window stays in sync', async () => {
    const main = await windowOf('main');
    await main.locator('.item-title', { hasText: 'Hello from the app' }).click();
    await main.keyboard.press('ControlOrMeta+Shift+O');
    const own = await windowOf('draft');
    await expect.poll(() => editorText(own)).toContain('A line from an agent.');
    await own.locator('.cm-content').click();
    await own.keyboard.press('ControlOrMeta+End');
    await own.keyboard.type('\nWritten in the second window.');
    await expect.poll(() => editorText(main)).toContain('Written in the second window.');
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()))).toContain(
      'Hello from the app — scratchpad',
    );
  });

  test('quick switcher finds and opens drafts', async () => {
    const main = await windowOf('main');
    await main.bringToFront();
    await main.keyboard.press('ControlOrMeta+k');
    await main.keyboard.type('hotkey');
    await expect(main.locator('.switcher-item .item-title').first()).toHaveText('Quick thought from the hotkey');
    await shot(main, 'switcher');
    await main.keyboard.press('Enter');
    await expect.poll(() => editorText(main)).toContain('Quick thought from the hotkey');
  });

  test('find marks matches inside a rendered table', async () => {
    const main = await windowOf('main');
    await main.keyboard.press('ControlOrMeta+n');
    await main.keyboard.type('Status\n\n| part | note |\n| - | - |\n| server | needs **more** work |\n\nsee more below');
    const table = main.locator('.cm-table-wrap');
    await expect(table).toBeVisible();
    await main.keyboard.press('ControlOrMeta+f');
    await main.keyboard.type('more');
    await expect(main.locator('.find-count')).toHaveText('2 matches');
    await expect(table.locator('.cm-searchMatch')).toHaveText(['more']);
    await expect(table.locator('strong')).toHaveText('more');
    await main.keyboard.press('Escape');
    await expect(table.locator('.cm-searchMatch')).toHaveCount(0);
    await expect(table.locator('td').last()).toHaveText('needs more work');
  });

  test('scratchpad:// links open drafts and the capture window', async () => {
    const id = run('new', 'Opened from a link').trim();
    // Linux passes a link to the running app on the command line; macOS sends open-url.
    await app.evaluate(({ app }, url) => app.emit('second-instance', {}, ['scratchpad-app', url], '/'), `scratchpad://open/${id}`);
    await expect.poll(() => app.windows().some((w) => w.url().includes(`draft=${id}`))).toBe(true);
    const own = app.windows().find((w) => w.url().includes(`draft=${id}`))!;
    await expect.poll(() => editorText(own)).toContain('Opened from a link');
    await own.close();

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('kind=capture'))?.hide();
    });
    await app.evaluate(({ app }) => app.emit('open-url', { preventDefault() {} }, 'scratchpad://capture'));
    await expect.poll(() => isVisible('capture')).toBe(true);
    await (await windowOf('capture')).keyboard.press('Escape');
  });

  test('the Draft menu copies, duplicates and shows info for the open draft', async () => {
    const main = await windowOf('main');
    await main.locator('#sidebar .item-title', { hasText: 'Hello from the app' }).click();
    const id = list().find((d) => d.title === 'Hello from the app')!.id;
    const menu = (item: string) =>
      app.evaluate(({ BrowserWindow, Menu }, item) => {
        const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('kind=main'));
        Menu.getApplicationMenu()!.getMenuItemById(item)!.click(undefined, win);
      }, item);
    const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());

    await menu('copyLink');
    await expect.poll(clipboard).toBe(`scratchpad://open/${id}`);
    await expect(main.locator('#toast')).toHaveText('Copied link');
    await menu('copyId');
    await expect.poll(clipboard).toBe(id);

    await menu('info');
    const info = main.locator('.info-box');
    await expect(info).toBeVisible();
    await expect(info.locator('.info-title')).toHaveText('Hello from the app');
    await expect(info).toContainText(id);
    await main.keyboard.press('Escape');
    await expect(info).toBeHidden();

    await menu('duplicate');
    await expect.poll(() => list().filter((d) => d.title === 'Hello from the app').length).toBe(2);
    await expect(main.locator('#toast')).toHaveText('Duplicated');
  });

  test('Tab nests a list item and Shift-Tab brings it back', async () => {
    const main = await windowOf('main');
    await main.keyboard.press('ControlOrMeta+n');
    await main.keyboard.type('Packing\n\n- bag\nlaptop');
    await expect.poll(() => list().some((d) => d.title === 'Packing')).toBe(true);
    const id = list().find((d) => d.title === 'Packing')!.id;
    await main.keyboard.press('Tab');
    await expect.poll(() => run('show', id)).toBe('Packing\n\n- bag\n  - laptop\n');
    await main.keyboard.press('Shift+Tab');
    await expect.poll(() => run('show', id)).toBe('Packing\n\n- bag\n- laptop\n');
  });

  test('clicking a task box checks and unchecks it', async () => {
    const main = await windowOf('main');
    const id = run('new', 'Errands\n\n- [ ] milk\n- [ ] stamps').trim();
    await main.locator('#sidebar .item-title', { hasText: 'Errands' }).click();
    const boxes = main.locator('.cm-task');
    await expect(boxes).toHaveCount(2);
    await boxes.first().click();
    await expect.poll(() => run('show', id)).toBe('Errands\n\n- [x] milk\n- [ ] stamps\n');
    await expect(boxes.first()).toHaveAttribute('aria-checked', 'true');
    await boxes.first().click();
    await expect.poll(() => run('show', id)).toBe('Errands\n\n- [ ] milk\n- [ ] stamps\n');
  });

  test('toolbar buttons explain themselves on hover', async () => {
    const main = await windowOf('main');
    await main.locator('.toolbar .tool[data-action="pin"]').hover();
    const tip = main.locator('.tip');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('Pin');
    await expect(tip.locator('.kbd')).toHaveCount(3);
    await main.mouse.move(600, 500);
    await expect(tip).toBeHidden();
  });

  test('Empty Trash deletes what is in the Trash, after asking', async () => {
    const id = run('new', 'Doomed').trim();
    run('trash', id);
    await app.evaluate(({ dialog, Menu }) => {
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
      Menu.getApplicationMenu()!.getMenuItemById('emptyTrash')!.click();
    });
    await expect.poll(() => list('--trash').length).toBe(0);
    expect(list().some((d) => d.title === 'Hello from the app')).toBe(true);
  });
});

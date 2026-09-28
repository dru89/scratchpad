// Screenshots for design reviews: realistic drafts, every window and state.
// Skipped unless SCRATCHPAD_SCREENSHOTS names an output directory:
//
//   npm run screenshots        (writes to docs/design-handoff/screenshots)

import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoroDoc } from 'loro-crdt';
import { binDir, launch } from './launch';

const out = process.env.SCRATCHPAD_SCREENSHOTS;
test.skip(!out, 'set SCRATCHPAD_SCREENSHOTS to write screenshots');

const cli = join(binDir, 'scratchpad');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const DRAFTS: { text: string; age: number; state?: 'archived' | 'trashed' }[] = [
  {
    age: 12 * MIN,
    text: `# Q4 planning notes

Three things to settle before the **planning review** on Friday. Background is in the [kickoff doc](https://example.com/kickoff), and the numbers are from last week's sync.

## Priorities

| Area | Owner | Status |
| :--- | :--- | :---: |
| Sync server | Priya | In progress |
| iOS capture | Drew | Not started |
| Search polish | Sam | Done |

## Open questions

- Ship sync before the iOS app, or together?
- Who owns the migration from the old notes tool?
  - Sam volunteered, pending the offsite
- Budget for a hosted option

> The goal is fewer places where text lives, not more.

## Next steps

1. Draft the sync milestones
2. Book time with design
3. Send the summary once it's *actually* short

\`\`\`ts
// Keep the summary where everyone can find it.
const draft = await scratchpad.create({ text: summary, retries: 3 });
console.log(\`Saved \${draft.id}\`, true);
\`\`\`
`,
  },
  {
    age: 25 * MIN,
    text: `Reply to Sam about the offsite

Thanks for pulling this together. Thursday works for me, but I'd rather not stack it on the planning review. Could we move the design session to the morning and keep the afternoon open for the migration discussion?

I can bring the draft milestones.`,
  },
  {
    age: 5 * HOUR,
    text: `## Standup, Tuesday

- Finished the capture window
- Idle rule works; pin is in
- Blocked on nothing, for once`,
  },
  {
    age: 26 * HOUR,
    text: `# Why I keep a scratchpad

Most writing tools want to know where a thing belongs before you've written it. A folder, a notebook, a title. That's backwards for the way I actually work: the first version of almost anything I write is a mess I'm going to copy somewhere else.

> Text starts somewhere. It shouldn't have to start *filed*.

So the rule is simple. Everything goes in the inbox, and the only decision is whether I'm done with it.`,
  },
  {
    age: 3 * DAY,
    text: `Groceries

- [ ] oat milk
- [ ] coffee beans
- [x] lemons
- [ ] something for Saturday`,
  },
  {
    age: 14 * DAY,
    text: `# Talk outline: local-first sync

1. What "local-first" buys you
2. CRDTs without the math
3. Every editor is a device
4. Demo: two windows, one agent`,
  },
  { age: 40 * DAY, text: 'Gift ideas\n\n- the good notebook\n- concert tickets' },
  { age: 9 * DAY, state: 'archived', text: '# Conference travel\n\nFlights booked, hotel confirmed. Expenses filed.' },
  { age: 60 * DAY, state: 'archived', text: 'Old apartment checklist\n\n- return keys\n- forward mail' },
  { age: 2 * DAY, state: 'trashed', text: 'test paste from the terminal' },
  { age: 6 * HOUR, state: 'trashed', text: 'meeting at 3? no, 4' },
];

let dir: string;
let env: Record<string, string>;
let app: ElectronApplication;

function run(...args: string[]) {
  return execFileSync(cli, args, { env, encoding: 'utf8' });
}

/** A bare protocol client, for seeding drafts with past timestamps. */
function daemonCall(method: string, params: object): Promise<any> {
  return new Promise((resolveCall, reject) => {
    const sock = createConnection(env.SCRATCHPAD_SOCKET);
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const msg = JSON.parse(buf.slice(0, nl));
      sock.end();
      if (msg.error) reject(new Error(msg.error.message));
      else resolveCall(msg.result);
    });
    sock.on('error', reject);
    sock.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
  });
}

/** Creates a draft, then stamps it as if it were written `age` ago. */
async function seed({ text, age, state }: (typeof DRAFTS)[number]) {
  const { id } = await daemonCall('drafts.create', { text });
  if (state) await daemonCall('drafts.setState', { id, state });
  const opened = await daemonCall('doc.open', { id });
  const doc = new LoroDoc();
  doc.import(Buffer.from(opened.data, 'base64'));
  const before = doc.oplogVersion();
  const t = Date.now() - age;
  const meta = doc.getMap('meta');
  meta.set('createdAt', t);
  meta.set('modifiedAt', t);
  if (state === 'trashed') meta.set('trashedAt', t);
  doc.commit();
  const update = Buffer.from(doc.export({ mode: 'update', from: before })).toString('base64');
  await daemonCall('doc.push', { id, update });
  return id as string;
}

async function windowOf(kind: string): Promise<Page> {
  await expect.poll(() => app.windows().some((w) => w.url().includes(`kind=${kind}`))).toBe(true);
  return app.windows().find((w) => w.url().includes(`kind=${kind}`))!;
}

async function resize(kind: string, width: number, height: number) {
  await app.evaluate(
    ({ BrowserWindow }, { kind, width, height }) => {
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes(`kind=${kind}`))
        ?.setSize(width, height);
    },
    { kind, width, height },
  );
}

async function shot(page: Page, name: string, scheme: 'light' | 'dark' = 'light') {
  await page.emulateMedia({ colorScheme: scheme });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(out!, `${name}.png`) });
}

/** Puts the cursor at the end of the paragraph containing `text`, so live preview hides syntax elsewhere. */
async function cursorAtEndOf(page: Page, text: string) {
  const line = page.locator('.cm-line', { hasText: text }).first();
  const box = (await line.boundingBox())!;
  await line.click({ position: { x: box.width - 4, y: box.height - 6 } });
}

test.describe.serial('design screenshots', () => {
  test.beforeAll(async () => {
    mkdirSync(out!, { recursive: true });
    dir = mkdtempSync(join(tmpdir(), 'scratchpad-shots-'));
    // A daemon wrapper that refuses to start while a block file exists, so
    // the offline state can be held long enough to photograph.
    const wrapper = join(dir, 'daemon');
    writeFileSync(wrapper, `#!/bin/sh\n[ -e "${dir}/block" ] && exit 1\nexec "${join(binDir, 'scratchpadd')}"\n`);
    chmodSync(wrapper, 0o755);
    env = {
      ...(process.env as Record<string, string>),
      SCRATCHPAD_DATA_DIR: join(dir, 'data'),
      SCRATCHPAD_SOCKET: join(dir, 'daemon.sock'),
      SCRATCHPAD_APP_STATE_DIR: join(dir, 'app'),
      SCRATCHPAD_DAEMON: wrapper,
    };
    run('daemon', 'start');
    app = await launch(env);
  });

  test.afterAll(async () => {
    if (app) {
      const proc = app.process();
      const exited = new Promise((r) => proc.once('exit', r));
      await app.evaluate(({ app }) => app.quit()).catch(() => {});
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
    }
    try {
      run('daemon', 'stop');
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  test('every window and state', async () => {
    await resize('main', 1280, 820);
    const main = await windowOf('main');
    await expect(main.locator('.empty')).toBeVisible();
    await shot(main, '01-empty-inbox');

    for (const d of DRAFTS) await seed(d);
    await main.keyboard.press('ControlOrMeta+1');
    await expect
      .poll(() => main.locator('.item-title').allInnerTexts())
      .toEqual(['Q4 planning notes', 'Reply to Sam about the offsite', 'Standup, Tuesday', 'Why I keep a scratchpad', 'Groceries', 'Talk outline: local-first sync', 'Gift ideas']);

    // The hero: a structured draft, rendered.
    await main.locator('#sidebar .item-title', { hasText: 'Q4 planning notes' }).click();
    await cursorAtEndOf(main, 'Three things to settle');
    await shot(main, '02-main-window');
    await shot(main, '03-main-window-dark', 'dark');

    // Live preview reveals markdown where the cursor is: inside the table.
    await main.locator('.cm-table-wrap td', { hasText: 'iOS capture' }).click();
    await shot(main, '04-editing-a-table-raw-markdown');
    await cursorAtEndOf(main, 'Three things to settle');

    // Long-form writing, sidebar hidden.
    await main.locator('#sidebar .item-title', { hasText: 'Why I keep a scratchpad' }).click();
    await cursorAtEndOf(main, 'So the rule is simple');
    await main.keyboard.press('ControlOrMeta+\\');
    await shot(main, '05-focused-writing-no-sidebar');
    await main.keyboard.press('ControlOrMeta+\\');

    // Filtering the sidebar shows snippets around the match.
    await main.locator('.filter').fill('sync');
    await expect(main.locator('.item-snippet').first()).toBeVisible();
    await shot(main, '06-sidebar-filter-with-snippets');
    await main.locator('.filter').fill('');
    await main.locator('.filter').press('Escape');

    // The quick switcher.
    await main.locator('#sidebar .item-title', { hasText: 'Q4 planning notes' }).click();
    await cursorAtEndOf(main, 'Three things to settle');
    await main.keyboard.press('ControlOrMeta+k');
    await main.keyboard.type('offsite');
    await expect(main.locator('.switcher-item').first()).toBeVisible();
    await shot(main, '07-quick-switcher');
    await shot(main, '08-quick-switcher-dark', 'dark');
    await main.keyboard.press('Escape');

    // Find in the draft (CodeMirror's panel, unstyled so far).
    await cursorAtEndOf(main, 'Three things to settle');
    await main.keyboard.press('ControlOrMeta+f');
    await main.keyboard.type('sync');
    await shot(main, '09-find-in-draft');
    await main.keyboard.press('Escape');

    // Copy as rich text, and its toast.
    await cursorAtEndOf(main, 'Three things to settle');
    await main.keyboard.press('ControlOrMeta+Shift+C');
    await expect(main.locator('#toast')).toBeVisible();
    await shot(main, '10-copied-as-rich-text-toast');
    await expect(main.locator('#toast')).toBeHidden({ timeout: 5000 });

    // Get Info.
    await main.keyboard.press('ControlOrMeta+i');
    await expect(main.locator('.info-box')).toBeVisible();
    await shot(main, '17-get-info');
    await main.keyboard.press('Escape');

    // A highlighted code block.
    await cursorAtEndOf(main, 'Send the summary');
    await main.locator('.cm-line', { hasText: 'Keep the summary' }).evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await shot(main, '21-code-highlighting');
    await shot(main, '22-code-highlighting-dark', 'dark');

    // A selection running into a code block, and a triple-clicked line.
    await cursorAtEndOf(main, 'Draft the sync milestones');
    await main.keyboard.press('Home');
    for (let i = 0; i < 6; i++) await main.keyboard.press('Shift+ArrowDown');
    await shot(main, '18-selection-into-code');
    await main.locator('.cm-line', { hasText: 'Ship sync before' }).click({ clickCount: 3 });
    await shot(main, '19-triple-clicked-line');

    // A pasted screenshot, then with the cursor on its line.
    const { name } = await daemonCall('attachments.add', {
      data: readFileSync(join(__dirname, '..', '..', 'docs', 'images', 'switcher.png')).toString('base64'),
    });
    await seed({
      age: 20 * 60 * 1000,
      text: `Switcher bug\n\nSearch results cover the toolbar when the window is short:\n![](attachment:${name})\nHappens at 600px tall or less.`,
    });
    await main.locator('#sidebar .item-title', { hasText: 'Switcher bug' }).click();
    await cursorAtEndOf(main, 'Happens at 600px');
    await expect.poll(() => main.locator('.cm-image img').evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    await shot(main, '23-pasted-image');
    await main.keyboard.press('ArrowUp');
    await shot(main, '24-pasted-image-editing-dark', 'dark');

    // A tooltip.
    await main.locator('.toolbar .tool[data-action="float"]').hover();
    await expect(main.locator('.tip')).toBeVisible();
    await shot(main, '20-tooltip');
    await main.mouse.move(600, 500);

    // The Trash, with a trashed draft open.
    await main.keyboard.press('ControlOrMeta+3');
    await main.locator('#sidebar .item-title', { hasText: 'meeting at 3' }).click();
    await expect(main.locator('.badge', { hasText: 'In Trash' })).toBeVisible();
    await shot(main, '11-trash-tab-with-badge');
    await main.keyboard.press('ControlOrMeta+1');

    // Offline: the daemon went away and can't come back yet.
    await main.locator('#sidebar .item-title', { hasText: 'Reply to Sam' }).click();
    await cursorAtEndOf(main, 'I can bring the draft milestones');
    writeFileSync(join(dir, 'block'), '');
    run('daemon', 'stop');
    await expect(main.locator('.badge.warn')).toBeVisible();
    await shot(main, '12-offline-badge');
    rmSync(join(dir, 'block'));
    await expect(main.locator('.badge.warn')).toHaveCount(0, { timeout: 15_000 });

    // The capture window: empty, then in use with pin and float on.
    // Right after the offline shots the app may still be reconnecting to
    // the daemon, and capture fails until it has.
    await expect
      .poll(() => {
        try {
          run('capture', '--new');
          return true;
        } catch {
          return false;
        }
      })
      .toBe(true);
    const capture = await windowOf('capture');
    await resize('capture', 560, 380);
    await expect(capture.locator('.cm-placeholder')).toBeVisible();
    await shot(capture, '13-capture-window-empty');
    await capture.locator('.cm-content').click();
    await capture.keyboard.type('Idea: the capture window should remember its size per monitor\n\n');
    await capture.keyboard.type('- ask Priya whether KWin exposes that');
    await capture.keyboard.press('ControlOrMeta+Shift+P');
    await capture.waitForTimeout(2200); // let the pin toast clear
    await shot(capture, '14-capture-window-pinned-and-floating');
    await shot(capture, '15-capture-window-dark', 'dark');
    await capture.keyboard.press('Escape');

    // A draft in its own window, archived.
    const archived = JSON.parse(run('--json', 'list', '--archived')).find((d: any) => d.title === 'Conference travel');
    run('open', archived.id);
    const own = await windowOf('draft');
    await resize('draft', 760, 560);
    await expect(own.locator('.badge', { hasText: 'Archived' })).toBeVisible();
    await cursorAtEndOf(own, 'Flights booked');
    await shot(own, '16-draft-window-archived');

    expect(existsSync(join(out!, '16-draft-window-archived.png'))).toBe(true);
  });
});

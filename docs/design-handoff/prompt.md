# Design brief: scratchpad

I'd like help polishing the UI of a desktop writing app I'm building. It works, and it's fast, but it was designed by an engineer: sensible defaults and nothing more. The screenshots attached show every window and state as they look today. I'm after a visual design I can implement directly in HTML and CSS, not a new product concept.

## What the app is

scratchpad (a working name) is a place where text starts. It's for the first version of things: a reply you're working out, meeting notes, a paragraph for a doc, a list. You write it here, shape it, then copy it somewhere else. It's modeled on the Mac app Drafts, and it exists because Drafts doesn't run on Linux and struggles with long documents.

The ideas that make it feel different from a notes app:

- **No filing.** There are no folders, file names, or tags. Every draft lives in one list, newest first, and its title is simply its first line. The only decision you ever make about a draft is whether you're done with it, which moves it from the **Inbox** to the **Archive**. The **Trash** empties itself after 30 days.
- **Markdown, shown as it will look.** You type markdown, and the editor renders it in place: headings get big, `**bold**` becomes bold, tables become tables. The markdown syntax appears only on the line, or inside the element, where your cursor is, so you can still edit it. The text is always plain markdown underneath, because it's going to be copied somewhere else.
- **Built to be summoned.** A global hotkey pops up a small floating **capture window** for dumping a thought, from anywhere, instantly. Esc hides it. Ctrl+Enter files what you wrote and clears it for next time. If you come back after 15 minutes idle, it opens on a fresh draft, unless you've **pinned** it to keep one draft up.
- **Copy as rich text.** One shortcut puts the draft on the clipboard as formatted HTML, so pasting into Slack, a doc, or email keeps the formatting.
- **Other editors are welcome.** AI agents and other devices can edit a draft while it's open. Their changes merge in live, and your cursor stays where it was.

## Who uses it, and how

One person, me, and I'm keyboard-first: I live in shortcuts and want the mouse to be optional. I use the app many times a day for short bursts, and occasionally for long-form writing. It should feel calm, quick, and a little disposable, more like a notepad on the desk than a filing cabinet. Obsidian and similar apps feel too permanent for this, and I'd like the design to stay clear of that feeling.

## The windows (see screenshots)

1. **Main window.** A sidebar on the left with Inbox / Archive / Trash tabs, a filter box, and the draft list (title and relative time). The editor is on the right, under a thin toolbar showing the draft's title and its actions: new, pin, float on top, copy as rich text, archive, trash, open in its own window. The sidebar can be hidden for focused writing.
2. **Capture window.** Small (560×380 by default) and floating. Just an editor and a slim toolbar: pin, float, copy, archive, trash, open in window, done.
3. **Draft window.** Any draft can be opened in its own window. It shows the editor and a toolbar, plus a badge if the draft is archived or in the Trash.

Overlays and states:
- the **quick switcher** (Ctrl+K), for finding any draft by title or text;
- **sidebar filtering**, with snippets around each match;
- **find in draft** (Ctrl+F);
- a **toast** when something happens, like "Copied as rich text";
- an **Offline** badge when the background service is unreachable (typing still works);
- **badges** for Archived and In Trash;
- **active states** for pin and float, currently just a blue icon;
- **empty states**.

Shortcuts, for context (Ctrl on Linux, Cmd on macOS):

| action | keys |
| --- | --- |
| New draft | Ctrl+N |
| Done: file it and start fresh | Ctrl+Enter |
| Quick switcher | Ctrl+K |
| Pin | Ctrl+Shift+P |
| Float on top | Ctrl+Shift+F |
| Copy as rich text | Ctrl+Shift+C |
| Archive | Ctrl+Shift+A |
| Trash | Ctrl+Shift+Backspace |
| Open in its own window | Ctrl+Shift+O |
| Toggle sidebar | Ctrl+\ |
| Switch tabs | Ctrl+1 / 2 / 3 |
| Find | Ctrl+F |
| Hide capture window | Esc |

## What I'd like from you

Mockups as HTML and CSS I can port directly, for:

1. The main window at 1280×820, in light and dark.
2. The capture window at 560×380, in light and dark.
3. A draft window, including the Archived badge.
4. The quick switcher, filtered sidebar results, and the find panel.
5. These states: pinned, floating, archived, in Trash, offline, empty Inbox, and a toast.
6. A token set as CSS custom properties: colors for light and dark, a type scale, spacing, radii. Also styles for the rendered markdown elements: headings, paragraphs, lists, task lists, quotes, code, tables, links, rules.
7. Icon choices for the toolbar actions. Float on top especially: today it's a stack-of-layers icon that doesn't say what it does.

If something about the layout itself is wrong, say so and propose an alternative. Just don't add structure I've deliberately left out (see below).

## Rough edges I already see

- **Paragraph rhythm.** Blank lines between paragraphs render as full empty lines, so gaps are uneven, especially above headings. I can style blank lines and headings individually, so a tighter, more even rhythm is possible.
- **Quotes** show a literal `>`, and the quote bar looks like an afterthought.
- **Search snippets** in the sidebar and switcher show raw markdown (`##`, `|`, `-`). I'll strip it, but the snippet styling could use care.
- **The find panel** is the editor library's unstyled default, with checkboxes and grey buttons.
- **The toolbar** is a row of equal-weight grey icons. Pin and float only show state as a color change. In the capture window, seven icons crowd a small space.
- **The sidebar list** is titles only. Would a line of preview text help, or is the density right?
- **Empty states, badges, and the toast** are placeholders.
- **The scrollbar** is the default.
- **There's no brand yet.** An optional extra: a direction for an app icon and a wordmark for the name "scratchpad".

## Constraints

- **Implementation.** Electron on desktop, so the design is HTML and CSS. The editor is CodeMirror 6. Rendered markdown is styled through classes on its lines and spans: `.cm-h1`–`.cm-h6`, `.cm-link-text`, `.cm-quote`, `.cm-codeblock`, `.cm-bullet`, `.cm-rule`, `.cm-table-wrap`. The markdown text stays the source of truth: no widgets that change what's in the document, and syntax stays visible on the line being edited.
- **Performance.** Typing has to keep up with a 240 Hz display on long documents. No blur, heavy shadows, or animation inside the editor. Subtle transitions on overlays are fine.
- **Window chrome.** The title bar is native (KDE Plasma on Linux) and isn't in the screenshots. Design the area inside the window. A custom title bar is possible later, but it isn't the goal now.
- **Small sizes.** The capture window must work down to 320×200.
- **Themes.** Light and dark, following the system setting.
- **Fonts.** The system font right now (Noto Sans on this machine). I'm open to bundling a font for the editor, since everything is local.
- **Platforms.** Linux first. macOS comes later with the same Electron app, then iOS, which will host this same editor inside a native shell. The editor and list styles should translate to a phone. The rest can stay desktop-specific.

## Leave room for, but don't design yet

Tags or saved searches as light organization; a sync status indicator; sort options; an actions menu for a draft. There's no folder or tag UI, and there shouldn't be one in this pass.

## Current tokens

From `app/src/style.css`, for reference:

```css
:root {
  --bg: #fbfaf7; --side: #f3f1ec; --panel: #f6f4ef; --fg: #1f1e1c;
  --muted: #8e8a83; --border: #e4e0d8; --hover: #ebe8e1; --selected: #e2ddd3;
  --accent: #2f62d9; --quote: #5f5b55; --code-bg: #f1eee8;
  --selection: rgba(47, 98, 217, 0.18); --warn: #b5462d;
  --sans: system-ui, sans-serif; --mono: ui-monospace, monospace;
  --editor-size: 16px;
}
/* dark */
:root {
  --bg: #1c1c1e; --side: #212124; --panel: #242427; --fg: #e6e3dd;
  --muted: #8b877f; --border: #323236; --hover: #2a2a2e; --selected: #34343a;
  --accent: #86a8ff; --quote: #aaa59c; --code-bg: #28282b;
  --selection: rgba(134, 168, 255, 0.24); --warn: #f08a6c;
}
```

Current layout: a 272 px sidebar, a 42 px toolbar, and 30 px icon buttons. The editor text column is capped at 46em, with 16 px text and 1.6 line height.

## Screenshots

All show test data. Light theme unless noted.

| file | shows |
| --- | --- |
| 01-empty-inbox | First launch: an empty Inbox and a new, unsaved draft |
| 02-main-window | The main window with a structured draft: headings, a table, lists, a quote, a link |
| 03-main-window-dark | The same, dark |
| 04-editing-a-table-raw-markdown | With the cursor inside the table, it shows as markdown so it can be edited |
| 05-focused-writing-no-sidebar | Long-form writing with the sidebar hidden |
| 06-sidebar-filter-with-snippets | Filtering the sidebar for "sync" |
| 07-quick-switcher | The Ctrl+K switcher searching for "offsite" |
| 08-quick-switcher-dark | The same, dark |
| 09-find-in-draft | Ctrl+F, the editor library's default panel |
| 10-copied-as-rich-text-toast | The toast after copying (it also shows in 11 and 12, because of how fast the screenshots were taken) |
| 11-trash-tab-with-badge | The Trash tab with a trashed draft open |
| 12-offline-badge | The Offline badge while the background service is down |
| 13-capture-window-empty | The capture window, just summoned |
| 14-capture-window-pinned-and-floating | The capture window in use, with pin and float on (blue icons) |
| 15-capture-window-dark | The same, dark |
| 16-draft-window-archived | A draft in its own window, archived (the `#` shows because the cursor is on that line) |

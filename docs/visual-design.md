# Visual design

How scratchpad looks, why, and how to extend it without losing the thread. [`design.md`](design.md) covers what the app does; this covers what it looks like. The tokens and styles live in [`app/src/style.css`](../app/src/style.css), and the mockups and token tables are in the scratchpad design system artifact (https://claude.ai/artifact/3K32PAxx6RGUJ83ivbTZe7, private to its owner).

## What it should feel like

A notepad on the desk, not a filing cabinet. scratchpad is where the first version of something gets written before it's copied somewhere else, so it should feel calm, quick and a little disposable. Obsidian and apps like it feel permanent, and that's the feeling to stay away from.

Five principles follow from that, and every rule below serves one of them.

**The text is the loudest thing on screen.** The editor gets the bundled typeface, the full ink color and the room. Chrome uses the system font, muted colors and resting icons that are only just visible, and it only asserts itself when something is on or needs attention.

**The keyboard always has the shorter path.** Every action has a shortcut, and the interface teaches it where it's used: in tooltips, in keycaps next to the Done button, in the switcher's footer, in empty states. The mouse is optional; nothing should require it.

**No filing.** There are no folders, tags or names to manage, and the design must not grow places to put things. The only decision about a draft is whether you're done with it (Inbox or Archive). New structure needs a reason stronger than tidiness.

**State reads by more than color.** Anything that can be on or off shows it by shape, color and, where there's room, a word. A pressed toggle fills part of its icon as well as turning blue; Archived and In Trash are badges with icons; Offline has a dot and a word.

**Nothing moves inside the editor.** Typing has to keep up with a 240 Hz display on a 100k-word document. No transitions, shadows, blur or animation in the editor. Overlays (the switcher, the toast) may fade and move a few pixels, and nothing else does.

## Color

The palette is four materials: paper, graphite ink, a ballpoint pen and a highlighter. One warning color covers what little can go wrong. The paper is white, not cream, and the greys are close to neutral, so the ballpoint reads crisply. An earlier pass used a warm cream and beige that read as dated, like an old beige computer; don't drift back toward it. Dark is plain graphite, not brown and not blue-grey.

- `--paper` is the page: the editor, every toolbar, the capture and draft windows. `--paper-side` sets the sidebar one step back. `--raised` is for things that sit on the page (the switcher, find fields). `--paper-sunk` is recessed: code, keycaps, neutral badges.
- Text is `--ink`. `--ink-2` is for quotes and badges, and `--ink-3` for everything muted: times, snippets, placeholders, the toolbar title, revealed markdown syntax. `--ink-4` is for marks, never words: resting icons, bullets, the quote bar, task boxes.
- `--accent` is the ballpoint. It marks where you are and what's on: the caret, links, focus rings, pressed toggles, the checked task box. Don't use it for decoration or large fills.
- `--highlight` is the highlighter: find matches and matched words in snippets. `--highlight-strong` is the current match. Nothing else is yellow.
- `--clay` is for states that need a second look but aren't errors: Offline, In Trash. There is no error red; failures are said in a toast.
- `--code-keyword`, `--code-string`, `--code-number` and `--code-type` color code in fenced blocks, and nothing else. They're muted on purpose, so code stays calm next to prose; comments are `--ink-3` italic, names are plain ink, and punctuation is `--ink-2`.
- `--hover` and `--selected` are translucent, so they work on every surface. Controls are flat fills: the active tab is `--selected`, and the resting filter field is `--hover`. Don't put white chips with shadows on tinted tracks.

Every text color meets 4.5:1 on every surface it's used on, in both themes, including hovered and selected rows; marks (`--ink-4`, icons, the focus ring) meet 3:1. A new color has to meet the same bar in light and dark before it goes in.

## Type

Two faces. The chrome uses the system face (Noto Sans on Plasma, SF on macOS) so it feels native. The editor uses **Atkinson Hyperlegible Next**, with **Commit Mono** for code, both bundled under `app/src/fonts` (OFL, licenses alongside). Atkinson was drawn to tell similar shapes apart (Il1, 0O, rn/m), which suits text full of names, times and codes that gets read at a glance. Its slashed zero and the tail on the q are features, not accidents. Code is set in Commit Mono because it's the least opinionated of the monospaced faces we tried: compact, even and quiet, where Atkinson Hyperlegible Mono felt wide and loosely spaced next to the prose.

Editor sizes are in em of `--editor-size` (16px, or 15px in the capture window), so the whole column scales from one variable. Body text is 1.6 line height. Headings are 1.5em, 1.25em and 1.1em, then body size for h4 to h6, told apart by weight, color and case. Headings are semibold (600), a step lighter than bold text in a paragraph (700), so they lead without shouting. Three real heading sizes are enough for a scratchpad.

## The editor

The markdown text is the only source of truth. The editor decorates it and keeps no state of its own. Syntax is hidden except in the element the cursor is in, and that's where it comes back, in `--ink-3`. The bullet dot and the rule only replace syntax visually. The task box does too, and clicking it checks or unchecks the item by editing its `[ ]` or `[x]` in the text, the same edit typing would make. On the line being edited, where the box shows as `[ ]`, clicking that text does the same.

Rhythm is where most of the calm comes from:

- A blank line the cursor isn't on gets `.cm-blank` and is `--rhythm-gap` tall (0.75em), not a full line, so paragraphs don't look double-spaced. When the cursor lands on it, it grows back so the caret isn't squashed. Blank lines inside fenced code keep their height.
- h1 to h3 get `--rhythm-heading` of padding above and nothing below, so a heading sits with the text it introduces.
- A bullet's dot sits in a fixed 0.6em box, so bullet text lines up with numbered text. Nested items step in by 0.85em per level (`.cm-list-2` to `.cm-list-4`) whatever indentation they were typed with, which puts a nested dot under its parent's text. The typed indentation shows again on the cursor's line.
- Quotes indent 1.35em from a 2px `--ink-4` bar and get 0.3em more room above and below. The `>` is hidden off the cursor's line; the bar is a background, so revealing it doesn't move anything.
- Code blocks are a `--paper-sunk` band with rounded ends, highlighted by the language named after the fence. Tables have rules between rows and none between columns, and align to the text edge.
- The selection is `--selection`, drawn over the text rather than under it, so code and inline code backgrounds can't hide it ([`editor/selection.ts`](../app/src/editor/selection.ts)). Each line's piece ends at its text, and a selected line break is a short block after it, so a triple-clicked line reads as that line alone. There's no caret while text is selected.
- A tab is about three monospaced characters wide in prose and four in code.

The text column is `--measure` (40em including side padding, about 70 characters). The capture window sets it to `none` and uses its width.

Line classes come from [`editor/livepreview.ts`](../app/src/editor/livepreview.ts) and inline classes from the HighlightStyle in [`editor/setup.ts`](../app/src/editor/setup.ts):

| class | from |
| --- | --- |
| `.cm-h1`–`.cm-h6`, `.cm-blank`, `.cm-quote` (+ `-first`, `-last`), `.cm-codeblock` (+ `-first`, `-last`), `.cm-list-2`–`4`, `.cm-task-done` | line decorations in livepreview.ts |
| `.cm-bullet`, `.cm-rule`, `.cm-task` (+ `.is-done`) | widgets in livepreview.ts; the task box is a clickable checkbox |
| `.cm-link-text` | the rendered text of a link, livepreview.ts |
| `.cm-strong`, `.cm-em`, `.cm-strike`, `.cm-inline-code`, `.cm-link`, `.cm-url`, `.cm-mark` | HighlightStyle in setup.ts |
| `.cm-code-keyword`, `-string`, `-number`, `-type`, `-comment`, `-function`, `-quiet` | HighlightStyle in setup.ts, for code in fenced blocks |
| `.cm-table-wrap`, and `.cm-searchMatch` in its cells while find is open | the table widget in tables.ts |

Two CodeMirror rules to keep in mind. CodeMirror mounts its own styles after `style.css`, so rules for line classes are written `.cm-editor .cm-line.cm-x` to outrank its default line padding, and anything else that fights its base theme goes in `EditorView.theme` in setup.ts. And use padding, never margins, on lines: CodeMirror measures line boxes, and margins throw that off.

## Layout

**Main window.** The sidebar (272px by default) is tabs, a filter and the list. Drag its edge to resize it, from 200px to 640px and never more than half the window; double-click the edge to go back to the default. Each row is the title, up to two lines of preview, and the time, the way Drafts lays out its list. With a line of its own, the time is spelled out: "12 minutes ago", "Yesterday at 3:04 PM", "Sep 12". The switcher keeps the short form ("12m"), where it shares a line with the title. The preview is the text after the title, stripped of markdown like a snippet; a draft that's only a title gets a shorter row. While filtering, the snippet around the match takes the preview's place, with matches highlighted. (An earlier pass showed titles only, on the theory that previews truncate to noise; in daily use the second and third lines were what told similar drafts apart.) The filter's placeholder names its tab ("Filter Trash") so its scope is clear next to the switcher, which searches Inbox and Archive together.

**Capture window.** The toolbar sits at the bottom, under the editor, so the first line of text starts right under the native title bar and the actions sit where a composer puts Send. It has no title, because the first line is right there. It must work down to 320×200: below 460px the toggle labels drop, below 400px the Done keycap drops, and no action is ever hidden.

**Draft window.** Like the main window without the sidebar, pin or new-draft button. The title and its state badge start the toolbar.

**Overlays.** The quick switcher is a `--raised` box over a flat `--scrim`, never a blur, with a keycap footer. Find is one slim row in CodeMirror's top panel slot ([`editor/find.ts`](../app/src/editor/find.ts)), with replace on a second row that opens only with Ctrl+H (⌘⌥F on macOS) or its toggle. A rendered table marks find's matches in its own cells, in the same `.cm-searchMatch` style; it matches the text as shown, so a match that's only syntax (`**`) is counted but not marked until the table opens. The toast is a pill at the bottom center, above the footer in the capture window.

## Toolbar

The main toolbar has two ends. The left holds what acts on the app (toggle sidebar, new draft). The right holds what acts on this draft, in groups separated by a 10px gap: pin and float (the window), copy (the output), archive and trash (its fate), and open in its own window. Groups are separated by space, not divider lines.

Pin, float, archive and trash are toggles with `aria-pressed`. Off, they look like every other tool: an `--ink-4` icon on nothing. On, they take `--accent-soft` and `--accent`, and the part of the icon marked `.i-fill` fills in. In the capture window, a pressed pin or float also shows its word ("Pinned", "On top"). Archive and trash stay archive and trash when a draft is archived or trashed: they show as pressed, pressing again undoes it, and the badge after the title names the state. The tooltip always says what pressing will do next, with the shortcut.

Tooltips are the app's own ([`tooltip.ts`](../app/src/tooltip.ts)), not `title` attributes, which Electron shows late or not at all on macOS. Anything with `data-tip` gets one, with `data-keys` ("Mod+Shift+P") shown as keycaps. They're a small `--toast-bg` pill that appears after a short hover or on keyboard focus, and at once when moving from one tool to the next.

## Iconography

One stroke set in [`icons.ts`](../app/src/icons.ts): a 24px grid, 1.75 stroke, round caps and joins, drawn at 18px in the toolbar. Icons are `--ink-4` at rest and `--ink` on hover. A toggle's icon marks the part that fills when it's on with `class="i-fill"`.

Float on top is a window with an up chevron, after Plasma's "Keep Above Others"; a stack of layers read as "layers", and a pin would collide with Pin. No emoji and no glyph icons. Keycaps are text in `.kbd` (`kbd()` in format.ts), one cap per key, with Ctrl shown as ⌘ on macOS.

## App icon

The icon is [`app/build/icon.svg`](../app/build/icon.svg): a sheet from a pad, glued edge in `--ink`, lying on graphite with a soft shadow, and on it a lowercase s and the caret. The s is Atkinson Hyperlegible Next at weight 540, drawn as an outline so the icon doesn't depend on the font. The caret is thinner than the s's stroke and set well apart, so the pair doesn't read as "sl", and it's the only color, the way the accent marks where you are in the app. The graphite is a step lighter than the glued edge, so the edge still reads at small sizes. `app/scripts/make-icons.py` cuts it to the macOS shape, adds the standard margin and shadow, and writes every size for macOS, Linux and this README.

## Words

Interface text is plain, short and sentence case, with no exclamation marks and no emoji. It names the thing and what happened to it: "Copied as rich text", "Moved to Trash", "Restored". The three places are Inbox, Archive and Trash, capitalized as names, and the things in them are drafts, not notes or files. A state is a short label; its explanation goes in the tooltip ("Reconnecting to scratchpadd. Your typing is kept."). Empty states are one line of fact and one line of help with a keycap: "Nothing in the Inbox" / "Ctrl N starts a draft". Never apologize or cheer.

## Motion

Overlays only. The switcher fades in over 120ms and its box drops in from 6px above; the toast rises 6px over 160ms. Everything else changes instantly, and `prefers-reduced-motion` turns these off too.

## Extending it

- Use the tokens. A raw color, size or radius in a component is a bug; if nothing fits, add a token with a usage note and check its contrast in both themes.
- Anything with on and off is a `.tool` with `aria-pressed`, and its icon marks an `.i-fill` part.
- A new markdown style is a class from livepreview.ts or the HighlightStyle, styled in style.css. Keep the syntax visible on the line being edited. A widget never holds state of its own; if clicking it changes something, it does so by editing the markdown.
- Check the capture window at 320×200 and both themes. `npm run screenshots` captures every window and state; point `SCRATCHPAD_SCREENSHOTS` somewhere else to keep the handoff set in `docs/design-handoff` as it is.

## Room left for later

These aren't designed yet, and each has a place reserved. A sync indicator takes the Offline badge's slot after the title. An actions menu for a draft goes at the right end of the toolbar, as a three-dot tool. Sort options go in the `.list-meta` line above the list. Tags or saved searches, if they come, go between the filter and the list. None of these should grow into folders.

## Known gaps

- The 16px app icon is the large one scaled down; it could use a hand-hinted version, and the wordmark in the design system is still a direction.

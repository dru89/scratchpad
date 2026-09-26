// The editor's extensions, shared by every window.

import { defaultKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import type { Extension } from '@codemirror/state';
import { drawSelection, EditorView, keymap, placeholder, type ViewUpdate } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { createFindPanel, openReplace } from './find';
import { livePreview } from './livepreview';
import { tables } from './tables';

// Classes rather than inline styles, so style.css owns the look. Heading
// weight and quote color come from the line classes in livepreview.ts.
const highlight = HighlightStyle.define([
  { tag: t.strong, class: 'cm-strong' },
  { tag: t.emphasis, class: 'cm-em' },
  { tag: t.strikethrough, class: 'cm-strike' },
  { tag: t.monospace, class: 'cm-inline-code' },
  { tag: t.link, class: 'cm-link' },
  { tag: t.url, class: 'cm-url' },
  // Revealed syntax: #, **, >, list numbers, link brackets.
  { tag: t.processingInstruction, class: 'cm-mark' },
]);

// What has to beat CodeMirror's base theme lives here; the markdown styles
// are in style.css.
const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--editor-size)', backgroundColor: 'var(--paper)', color: 'var(--ink)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-editor)', lineHeight: '1.6', overflow: 'auto' },
  '.cm-content': { maxWidth: 'var(--measure)', margin: '0 auto', padding: 'var(--editor-pad)', caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    background: 'var(--selection)',
  },
  '.cm-placeholder': { color: 'var(--ink-3)' },
  '.cm-panels': { backgroundColor: 'var(--paper)', color: 'var(--ink)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-searchMatch': { backgroundColor: 'var(--highlight)', borderRadius: '2px' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--highlight-strong)', color: 'var(--on-highlight-strong)' },
});

export function editorExtensions(opts: { placeholder: string; onUpdate: (u: ViewUpdate) => void }): Extension[] {
  return [
    drawSelection(),
    search({ top: true, createPanel: createFindPanel }),
    keymap.of([{ key: 'Mod-h', run: openReplace, scope: 'editor search-panel' }, ...searchKeymap, ...defaultKeymap]),
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(highlight),
    theme,
    livePreview,
    tables,
    EditorView.lineWrapping,
    placeholder(opts.placeholder),
    EditorView.updateListener.of(opts.onUpdate),
  ];
}

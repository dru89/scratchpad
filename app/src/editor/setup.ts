// The editor's extensions, shared by every window.

import { defaultKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import type { Extension } from '@codemirror/state';
import { drawSelection, EditorView, keymap, placeholder, type ViewUpdate } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { livePreview } from './livepreview';
import { tables } from './tables';

const highlight = HighlightStyle.define([
  { tag: [t.heading1, t.heading2], fontWeight: '700' },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: '600' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.monospace, fontFamily: 'var(--mono)', fontSize: '0.9em' },
  { tag: [t.url, t.processingInstruction], color: 'var(--muted)' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.quote, color: 'var(--quote)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--editor-size)', backgroundColor: 'var(--bg)', color: 'var(--fg)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--sans)', lineHeight: '1.6', overflow: 'auto' },
  '.cm-content': { maxWidth: '46em', margin: '0 auto', padding: 'var(--editor-pad)', caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    background: 'var(--selection)',
  },
  '.cm-placeholder': { color: 'var(--muted)' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--fg)', borderColor: 'var(--border)' },
  '.cm-searchMatch': { backgroundColor: 'var(--match)' },
});

export function editorExtensions(opts: { placeholder: string; onUpdate: (u: ViewUpdate) => void }): Extension[] {
  return [
    drawSelection(),
    search({ top: true }),
    keymap.of([...searchKeymap, ...defaultKeymap]),
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

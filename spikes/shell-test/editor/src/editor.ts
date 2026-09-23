import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { drawSelection, EditorView, keymap, placeholder } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { livePreview } from './livepreview';
import { tables } from './tables';

const style = HighlightStyle.define([
  { tag: t.heading1, fontWeight: '700' },
  { tag: t.heading2, fontWeight: '700' },
  { tag: t.heading3, fontWeight: '650' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '600' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.monospace, fontFamily: 'var(--mono)', fontSize: '0.9em' },
  { tag: [t.url, t.processingInstruction], color: 'var(--muted)' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.quote, color: 'var(--quote)' },
]);

const layout = EditorView.theme({
  '&': { height: '100%', fontSize: '16px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    lineHeight: '1.6',
    overflow: 'auto',
  },
  '.cm-content': {
    maxWidth: '46em',
    margin: '0 auto',
    padding: '48px 24px 40vh',
    caretColor: 'var(--accent)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    background: 'color-mix(in srgb, var(--accent) 22%, transparent)',
  },
});

export function createEditor(parent: HTMLElement, doc: string, opts: { placeholder?: string } = {}) {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        drawSelection(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(style),
        layout,
        livePreview,
        tables,
        EditorView.lineWrapping,
        opts.placeholder ? placeholder(opts.placeholder) : [],
      ],
    }),
  });
}

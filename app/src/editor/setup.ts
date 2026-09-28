// The editor's extensions, shared by every window.

import { defaultKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import type { Extension } from '@codemirror/state';
import { drawSelection, EditorView, keymap, placeholder, type ViewUpdate } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { createFindPanel, openReplace, REPLACE_KEY } from './find';
import { type ImageHost, imagePasting } from './images';
import { indentKeys } from './indent';
import { livePreview } from './livepreview';
import { selectionLayer } from './selection';
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
  // Code in fenced blocks, highlighted by the language named after the fence.
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier], class: 'cm-code-keyword' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], class: 'cm-code-string' },
  // Not t.atom: markdown uses it for a task's [ ].
  { tag: [t.number, t.bool, t.null, t.unit], class: 'cm-code-number' },
  { tag: [t.typeName, t.className, t.namespace], class: 'cm-code-type' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: 'cm-code-comment' },
  { tag: [t.function(t.variableName), t.function(t.definition(t.variableName)), t.definition(t.function(t.variableName))], class: 'cm-code-function' },
  { tag: [t.propertyName, t.attributeName, t.operator, t.punctuation, t.bracket, t.separator], class: 'cm-code-quiet' },
]);

// What has to beat CodeMirror's base theme lives here; the markdown styles
// are in style.css.
const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--editor-size)', backgroundColor: 'var(--paper)', color: 'var(--ink)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-editor)', lineHeight: '1.6', overflow: 'auto' },
  '.cm-content': { maxWidth: 'var(--measure)', margin: '0 auto', padding: 'var(--editor-pad)', caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  // The selection is drawn by selection.ts, above the text, not by
  // CodeMirror's layer under it.
  '.cm-selectionLayer': { display: 'none' },
  '.cm-sp-selection': { pointerEvents: 'none' },
  '.cm-sp-selection .cm-selectionBackground': { background: 'var(--selection)' },
  '.cm-placeholder': { color: 'var(--ink-3)' },
  '.cm-panels': { backgroundColor: 'var(--paper)', color: 'var(--ink)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-searchMatch': { backgroundColor: 'var(--highlight)', borderRadius: '2px' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--highlight-strong)', color: 'var(--on-highlight-strong)' },
});

export function editorExtensions(opts: {
  placeholder: string;
  onUpdate: (u: ViewUpdate) => void;
  images: ImageHost;
}): Extension[] {
  return [
    // No cursor while text is selected, as in most editors.
    drawSelection({ drawRangeCursor: false }),
    selectionLayer,
    search({ top: true, createPanel: createFindPanel }),
    indentUnit.of('\t'),
    keymap.of([...indentKeys, { ...REPLACE_KEY, run: openReplace, scope: 'editor search-panel' }, ...searchKeymap, ...defaultKeymap]),
    // Languages load when a fence names one (```python), not up front.
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    syntaxHighlighting(highlight),
    theme,
    livePreview,
    tables,
    imagePasting(opts.images),
    EditorView.lineWrapping,
    placeholder(opts.placeholder),
    EditorView.updateListener.of(opts.onUpdate),
  ];
}

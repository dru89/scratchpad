// Inline live preview: hide markdown syntax outside the element the cursor is
// in, and style headings, quotes, and code blocks. Only walks the visible
// ranges, which is what keeps this cheap on a 100k-word document.

import { syntaxTree } from '@codemirror/language';
import type { EditorState, Range } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';

const hide = Decoration.replace({});
const linkText = Decoration.mark({ class: 'cm-link-text' });
const lineClass = (cls: string) => Decoration.line({ class: cls });

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-bullet';
    el.textContent = '•';
    return el;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-rule';
    return el;
  }
}

const bullet = Decoration.replace({ widget: new BulletWidget() });
const rule = Decoration.replace({ widget: new RuleWidget() });

export function touches(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) if (r.from <= to && r.to >= from) return true;
  return false;
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const out: Range<Decoration>[] = [];
  const tree = syntaxTree(state);

  const lineRange = (from: number, to: number, cls: string, clipFrom: number, clipTo: number) => {
    const start = doc.lineAt(Math.max(from, clipFrom)).number;
    const end = doc.lineAt(Math.min(to, clipTo)).number;
    for (let n = start; n <= end; n++) out.push(lineClass(cls).range(doc.line(n).from));
  };

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        const name = node.name;
        if (name === 'Table') return false; // tables.ts owns these

        if (name.startsWith('ATXHeading')) {
          out.push(lineClass('cm-h' + name.slice(-1)).range(doc.lineAt(node.from).from));
          return;
        }

        switch (name) {
          case 'HeaderMark': {
            const parent = node.node.parent;
            if (parent && parent.name.startsWith('ATXHeading') && !touches(state, parent.from, parent.to)) {
              const end = doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
              out.push(hide.range(node.from, end));
            }
            return;
          }
          case 'EmphasisMark':
          case 'CodeMark':
          case 'StrikethroughMark': {
            const parent = node.node.parent;
            if (parent && !touches(state, parent.from, parent.to)) out.push(hide.range(node.from, node.to));
            return;
          }
          case 'Link': {
            if (touches(state, node.from, node.to)) return;
            const marks = [];
            for (let c = node.node.firstChild; c; c = c.nextSibling) if (c.name === 'LinkMark') marks.push(c);
            if (marks.length >= 2) {
              out.push(hide.range(marks[0].from, marks[0].to));
              if (marks[1].from > marks[0].to) out.push(linkText.range(marks[0].to, marks[1].from));
              out.push(hide.range(marks[1].from, node.to));
            }
            return;
          }
          case 'ListMark': {
            if (node.node.parent?.parent?.name !== 'BulletList') return;
            const line = doc.lineAt(node.from);
            if (!touches(state, line.from, line.to)) out.push(bullet.range(node.from, node.to));
            return;
          }
          case 'HorizontalRule':
            if (!touches(state, node.from, node.to)) out.push(rule.range(node.from, node.to));
            return false;
          case 'Blockquote':
            lineRange(node.from, node.to, 'cm-quote', from, to);
            return;
          case 'FencedCode':
            lineRange(node.from, node.to, 'cm-codeblock', from, to);
            return false;
        }
      },
    });
  }
  return Decoration.set(out, true);
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.selectionSet ||
        syntaxTree(u.startState) !== syntaxTree(u.state)
      ) {
        this.decorations = build(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

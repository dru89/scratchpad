// Inline live preview: hide markdown syntax outside the element the cursor is
// in, and give lines the classes style.css styles (docs/visual-design.md#the-editor).
// Only walks the visible ranges, which is what keeps this cheap on a
// 100k-word document.

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

/** A task's box. Display only: it doesn't toggle, so the text stays the only source of truth. */
class TaskWidget extends WidgetType {
  constructor(readonly done: boolean) {
    super();
  }
  eq(other: TaskWidget) {
    return other.done === this.done;
  }
  /** Clicking the box checks or unchecks it (toggleTask). */
  toDOM(view: EditorView) {
    const el = document.createElement('span');
    el.className = this.done ? 'cm-task is-done' : 'cm-task';
    el.setAttribute('role', 'checkbox');
    el.setAttribute('aria-checked', String(this.done));
    el.setAttribute('aria-label', this.done ? 'Done' : 'To do');
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleTask(view, view.posAtDOM(el));
    });
    return el;
  }
}

/**
 * Checks or unchecks the task whose box starts at or after `at` on its line,
 * by editing its [ ] or [x], the same edit typing would make.
 */
function toggleTask(view: EditorView, at: number) {
  const line = view.state.doc.lineAt(at);
  const box = /\[([ xX])\]/.exec(line.text.slice(at - line.from));
  if (!box) return;
  const pos = at + box.index + 1;
  view.dispatch({ changes: { from: pos, to: pos + 1, insert: box[1] === ' ' ? 'x' : ' ' }, userEvent: 'input.toggle' });
}

const bullet = Decoration.replace({ widget: new BulletWidget() });
const rule = Decoration.replace({ widget: new RuleWidget() });
const tasks = [false, true].map((done) => Decoration.replace({ widget: new TaskWidget(done) }));
/** The [ ] or [x] shown as text on the line being edited, which clicks toggle too. */
const rawTask = Decoration.mark({ class: 'cm-task-raw' });

/** Whether `pos` is inside a node named in `names`, looking to either side of it. */
export function insideNode(state: EditorState, pos: number, names: Set<string>): boolean {
  for (const side of [-1, 1] as const) {
    let node = syntaxTree(state).resolveInner(pos, side);
    for (;;) {
      if (names.has(node.name)) return true;
      if (!node.parent) break;
      node = node.parent;
    }
  }
  return false;
}

export function touches(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    // A selection that ends where a line starts, like a triple-clicked
    // line, doesn't reach into that line.
    const end = r.to > r.from && state.doc.lineAt(r.to).from === r.to ? r.to - 1 : r.to;
    if (r.from <= to && end >= from) return true;
  }
  return false;
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const out: Range<Decoration>[] = [];
  const tree = syntaxTree(state);
  // Fenced code keeps its blank lines at full height.
  const code: { from: number; to: number }[] = [];

  /** Classes every line of a block; with `edges`, also `<cls>-first` and `<cls>-last`. */
  const lineRange = (from: number, to: number, cls: string, clipFrom: number, clipTo: number, edges = false) => {
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    const start = doc.lineAt(Math.max(from, clipFrom)).number;
    const end = doc.lineAt(Math.min(to, clipTo)).number;
    for (let n = start; n <= end; n++) {
      let c = cls;
      if (edges && n === first) c += ` ${cls}-first`;
      if (edges && n === last) c += ` ${cls}-last`;
      out.push(lineClass(c).range(doc.line(n).from));
    }
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
          case 'ListItem': {
            // Nested items step in by a fixed amount per level instead of by
            // however many spaces they were typed with (style.css .cm-list-N).
            let depth = 0;
            for (let p = node.node.parent; p; p = p.parent) if (p.name === 'BulletList' || p.name === 'OrderedList') depth++;
            if (depth < 2) return;
            const line = doc.lineAt(node.from);
            if (touches(state, line.from, line.to) || !/^\s+$/.test(doc.sliceString(line.from, node.from))) return;
            out.push(lineClass(`cm-list-${Math.min(depth, 4)}`).range(line.from));
            out.push(hide.range(line.from, node.from));
            return;
          }
          case 'ListMark': {
            const item = node.node.parent;
            if (item?.parent?.name !== 'BulletList' || item.getChild('Task')) return; // TaskMarker handles tasks
            const line = doc.lineAt(node.from);
            if (!touches(state, line.from, line.to)) out.push(bullet.range(node.from, node.to));
            return;
          }
          case 'TaskMarker': {
            const line = doc.lineAt(node.from);
            const done = /x/i.test(doc.sliceString(node.from, node.to));
            if (done) out.push(lineClass('cm-task-done').range(line.from));
            if (touches(state, line.from, line.to)) {
              out.push(rawTask.range(node.from, node.to));
              return;
            }
            // In a bullet list the box replaces "- [ ]"; in a numbered one, just "[ ]".
            const item = node.node.parent?.parent;
            const mark = item?.parent?.name === 'BulletList' ? item.getChild('ListMark') : null;
            out.push(tasks[done ? 1 : 0].range(mark ? mark.from : node.from, node.to));
            return;
          }
          case 'HorizontalRule':
            if (!touches(state, node.from, node.to)) out.push(rule.range(node.from, node.to));
            return false;
          case 'Blockquote':
            lineRange(node.from, node.to, 'cm-quote', from, to, true);
            return;
          case 'QuoteMark': {
            const line = doc.lineAt(node.from);
            if (touches(state, line.from, line.to)) return;
            const end = doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
            out.push(hide.range(node.from, end));
            return;
          }
          case 'FencedCode':
            code.push({ from: node.from, to: node.to });
            lineRange(node.from, node.to, 'cm-codeblock', from, to, true);
            return false;
        }
      },
    });

    // A blank line the cursor isn't on is rhythm-gap tall, not a full line.
    for (let n = doc.lineAt(from).number, end = doc.lineAt(to).number; n <= end; n++) {
      const line = doc.line(n);
      if (line.length && !/^\s+$/.test(line.text)) continue;
      if (touches(state, line.from, line.to) || code.some((c) => c.from <= line.from && c.to >= line.to)) continue;
      out.push(lineClass('cm-blank').range(line.from));
    }
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
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(e, view) {
        const raw = (e.target as HTMLElement).closest<HTMLElement>('.cm-task-raw');
        if (!raw || e.button !== 0 || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return false;
        e.preventDefault();
        toggleTask(view, view.posAtDOM(raw));
        return true;
      },
    },
  },
);

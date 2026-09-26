// Table rendering, SilverBullet-style: a top-level GFM table renders as an
// HTML table while the selection is outside it and falls back to raw
// markdown when the selection enters. Clicking a cell puts the cursor at that
// cell's position in the source. Block decorations have to come from a
// StateField, not a ViewPlugin.

import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Range, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { touches } from './livepreview';

interface Cell {
  text: string;
  /** Offset of the cell's content relative to the table's first character. */
  offset: number;
}

type Align = 'left' | 'center' | 'right' | '';

interface TableModel {
  header: Cell[];
  aligns: Align[];
  rows: Cell[][];
}

interface Span {
  from: number;
  to: number;
}

interface TablesState {
  spans: Span[];
  decos: DecorationSet;
  activeKey: string;
}

function splitRow(line: string, lineOffset: number): Cell[] {
  const cells: Cell[] = [];
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (line[i] === '|') i++;
  let start = i;
  let inCode = false;
  for (; i <= line.length; i++) {
    const c = line[i];
    if (i === line.length || (c === '|' && !inCode)) {
      const raw = line.slice(start, i);
      const text = raw.trim();
      if (!(i === line.length && text === '')) {
        cells.push({ text, offset: lineOffset + start + (raw.length - raw.trimStart().length) });
      }
      start = i + 1;
    } else if (c === '\\') {
      i++;
    } else if (c === '`') {
      inCode = !inCode;
    }
  }
  return cells;
}

function parseAlign(cell: string): Align {
  const l = cell.startsWith(':');
  const r = cell.endsWith(':');
  return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
}

function parseTable(src: string): TableModel {
  const lines = src.split('\n');
  const offsets: number[] = [];
  let off = 0;
  for (const l of lines) {
    offsets.push(off);
    off += l.length + 1;
  }
  return {
    header: splitRow(lines[0], 0),
    aligns: splitRow(lines[1] ?? '', offsets[1] ?? 0).map((c) => parseAlign(c.text)),
    rows: lines.slice(2).map((l, i) => splitRow(l, offsets[i + 2])),
  };
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '<a>$1</a>');
}

const ROW_PX = 31;

class TableWidget extends WidgetType {
  constructor(
    readonly model: TableModel,
    readonly src: string,
  ) {
    super();
  }

  eq(other: TableWidget) {
    return other.src === this.src;
  }

  get estimatedHeight() {
    return (this.model.rows.length + 1) * ROW_PX + 12;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement('div');
    wrap.className = 'cm-table-wrap';
    const table = document.createElement('table');
    const { header, aligns, rows } = this.model;

    const make = (tag: 'th' | 'td', cell: Cell | undefined, col: number) => {
      const el = document.createElement(tag);
      if (cell) {
        el.innerHTML = inline(cell.text);
        el.dataset.offset = String(cell.offset);
      }
      if (aligns[col]) el.style.textAlign = aligns[col];
      return el;
    };

    const thead = table.createTHead().insertRow();
    header.forEach((c, i) => thead.appendChild(make('th', c, i)));
    const tbody = table.createTBody();
    for (const row of rows) {
      const tr = tbody.insertRow();
      for (let i = 0; i < header.length; i++) tr.appendChild(make('td', row[i], i));
    }

    wrap.appendChild(table);
    wrap.addEventListener('mousedown', (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-offset]');
      if (!target) return;
      e.preventDefault();
      const base = view.posAtDOM(wrap);
      view.dispatch({ selection: { anchor: base + Number(target.dataset.offset) } });
      view.focus();
    });
    return wrap;
  }
}

function findTables(state: EditorState): Span[] {
  const spans: Span[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === 'Document') return;
      if (node.name === 'Table') spans.push({ from: node.from, to: node.to });
      return false;
    },
  });
  return spans;
}

const modelCache = new Map<string, TableModel>();

function compute(state: EditorState, known?: Span[]): TablesState {
  const spans = known ?? findTables(state);
  const decos: Range<Decoration>[] = [];
  const active: number[] = [];
  spans.forEach((s, i) => {
    if (touches(state, s.from, s.to)) {
      active.push(i);
      return;
    }
    const src = state.doc.sliceString(s.from, s.to);
    let model = modelCache.get(src);
    if (!model) {
      if (modelCache.size > 2000) modelCache.clear();
      model = parseTable(src);
      modelCache.set(src, model);
    }
    decos.push(Decoration.replace({ widget: new TableWidget(model, src), block: true }).range(s.from, s.to));
  });
  return { spans, decos: Decoration.set(decos), activeKey: active.join(',') };
}

function activeKey(state: EditorState, spans: Span[]): string {
  const active: number[] = [];
  spans.forEach((s, i) => touches(state, s.from, s.to) && active.push(i));
  return active.join(',');
}

export const tables = StateField.define<TablesState>({
  create: (state) => compute(state),
  update(value, tr) {
    if (tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state)) return compute(tr.state);
    if (tr.selection && activeKey(tr.state, value.spans) !== value.activeKey) {
      return compute(tr.state, value.spans);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

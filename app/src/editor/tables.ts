// Table rendering, SilverBullet-style: a top-level GFM table renders as an
// HTML table while the selection is outside it and falls back to raw
// markdown when the selection enters. Clicking a cell puts the cursor at that
// cell's position in the source. Block decorations have to come from a
// StateField, not a ViewPlugin. While find is open, the widget marks matches
// in its cells, since CodeMirror's search highlighting can't reach inside it.

import { syntaxTree } from '@codemirror/language';
import { getSearchQuery, type SearchQuery, searchPanelOpen } from '@codemirror/search';
import { type EditorState, type Range, StateField, Text } from '@codemirror/state';
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
  query: SearchQuery | null;
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

/** The find query to mark in tables: set while find is open with something valid to look for. */
function activeQuery(state: EditorState): SearchQuery | null {
  const query = getSearchQuery(state);
  return searchPanelOpen(state) && query.search && query.valid ? query : null;
}

const sameQuery = (a: SearchQuery | null, b: SearchQuery | null) => a === b || (!!a && !!b && a.eq(b));

/**
 * Where `query` matches in a cell whose text is split across `texts` (its
 * text nodes): [text index, from, to] for each piece, one per text a match
 * touches. Matching runs on the rendered text, so a match that's all syntax
 * in the source is counted by find but not marked here.
 */
export function matchPieces(query: SearchQuery, texts: string[]): [number, number, number][] {
  const starts: number[] = [];
  let joined = '';
  for (const t of texts) {
    starts.push(joined.length);
    joined += t;
  }
  const pieces: [number, number, number][] = [];
  if (!joined) return pieces;
  const cursor = query.getCursor(Text.of(joined.split('\n')));
  for (let m = cursor.next(); !m.done; m = cursor.next()) {
    texts.forEach((t, i) => {
      const from = Math.max(m.value.from, starts[i]) - starts[i];
      const to = Math.min(m.value.to, starts[i] + t.length) - starts[i];
      if (from < to) pieces.push([i, from, to]);
    });
  }
  return pieces;
}

/** Marks matches of `query` in the table's cells, clearing the old marks first. */
function markMatches(wrap: HTMLElement, query: SearchQuery | null) {
  for (const mark of wrap.querySelectorAll('.cm-searchMatch')) mark.replaceWith(...mark.childNodes);
  wrap.normalize();
  if (!query) return;
  for (const cell of wrap.querySelectorAll('th, td')) {
    const nodes: globalThis.Text[] = [];
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as globalThis.Text);
    // Back to front, so wrapping one piece doesn't move the ones still to come.
    for (const [i, from, to] of matchPieces(query, nodes.map((n) => n.data)).reverse()) {
      const range = document.createRange();
      range.setStart(nodes[i], from);
      range.setEnd(nodes[i], to);
      const mark = document.createElement('span');
      mark.className = 'cm-searchMatch';
      range.surroundContents(mark);
    }
  }
}

const ROW_PX = 34;

/** The widget that drew each table, so updateDOM can tell whether only the marks changed. */
const drawnBy = new WeakMap<HTMLElement, TableWidget>();

class TableWidget extends WidgetType {
  constructor(
    readonly model: TableModel,
    readonly src: string,
    readonly query: SearchQuery | null,
  ) {
    super();
  }

  eq(other: TableWidget) {
    return other.src === this.src && sameQuery(other.query, this.query);
  }

  updateDOM(dom: HTMLElement) {
    if (drawnBy.get(dom)?.src !== this.src) return false;
    markMatches(dom, this.query);
    drawnBy.set(dom, this);
    return true;
  }

  get estimatedHeight() {
    return (this.model.rows.length + 1) * ROW_PX + 8;
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
    markMatches(wrap, this.query);
    drawnBy.set(wrap, this);
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
  const query = activeQuery(state);
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
    decos.push(Decoration.replace({ widget: new TableWidget(model, src, query), block: true }).range(s.from, s.to));
  });
  return { spans, decos: Decoration.set(decos), activeKey: active.join(','), query };
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
    if (
      (tr.selection && activeKey(tr.state, value.spans) !== value.activeKey) ||
      !sameQuery(activeQuery(tr.state), value.query)
    ) {
      return compute(tr.state, value.spans);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

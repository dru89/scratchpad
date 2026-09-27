// Tab and Shift-Tab. In a list, Tab makes each selected item a child of the
// item above it, and Shift-Tab moves it back out to its parent's level; an
// item's own children move with it. Anywhere else Tab inserts a tab, or
// indents every selected line, and Shift-Tab takes one level off.
//
// Items are re-indented with spaces, to the column where the parent's text
// starts ("- " is 2, "1. " is 3), because that's what makes markdown nest
// them. The editor shows every level at the same step whatever the spacing.

import { indentLess, indentMore, insertTab } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import type { ChangeSpec, EditorState, Line, StateCommand } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';

const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)/;
const TAB_COLUMNS = 4;

interface Item {
  line: Line;
  /** Columns before the marker. */
  indent: number;
  /** Columns from the marker to the item's text: where a child's marker goes. */
  width: number;
}

/** Leading whitespace in columns, and in characters. */
function leading(text: string): { columns: number; length: number } {
  let columns = 0;
  let length = 0;
  for (const ch of text) {
    if (ch === ' ') columns++;
    else if (ch === '\t') columns += TAB_COLUMNS - (columns % TAB_COLUMNS);
    else break;
    length++;
  }
  return { columns, length };
}

function inCode(state: EditorState, pos: number): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return true;
  }
  return false;
}

function itemAt(state: EditorState, line: Line): Item | null {
  const m = ITEM.exec(line.text);
  if (!m || inCode(state, line.from)) return null;
  return { line, indent: leading(m[1]).columns, width: m[2].length + Math.max(1, m[3].length) };
}

/** The lines the selection covers. A range ending at a line's start doesn't count that line. */
function selectedLines(state: EditorState): Line[] {
  const lines = new Map<number, Line>();
  for (const r of state.selection.ranges) {
    const last = r.to > r.from && state.doc.lineAt(r.to).from === r.to ? r.to - 1 : r.to;
    for (let pos = r.from; pos <= last; ) {
      const line = state.doc.lineAt(pos);
      lines.set(line.number, line);
      pos = line.to + 1;
    }
  }
  return [...lines.values()].sort((a, b) => a.number - b.number);
}

/**
 * The nearest list item above `item` whose indent satisfies `accept`,
 * looking past blank lines and anything indented deeper than `item`.
 */
function itemAbove(state: EditorState, item: Item, accept: (indent: number) => boolean): Item | null {
  for (let n = item.line.number - 1; n >= 1; n--) {
    const line = state.doc.line(n);
    if (!line.text.trim()) continue;
    const above = itemAt(state, line);
    const indent = above?.indent ?? leading(line.text).columns;
    if (indent > item.indent) continue;
    if (above && accept(above.indent)) return above;
    if (!above || indent < item.indent) return null;
  }
  return null;
}

/** How far Tab moves an item: under the item above it at its level, if there is one. */
function indentBy(state: EditorState, item: Item): number {
  const sibling = itemAbove(state, item, (indent) => indent === item.indent);
  return sibling ? sibling.width : 0;
}

/** How far Shift-Tab moves an item: out to its parent's level, or to the margin. */
function outdentBy(state: EditorState, item: Item): number {
  if (item.indent === 0) return 0;
  const parent = itemAbove(state, item, (indent) => indent < item.indent);
  return (parent?.indent ?? 0) - item.indent;
}

function shiftItems(state: EditorState, items: Item[], by: (item: Item) => number): ChangeSpec[] {
  const delta = new Map<number, number>();
  for (const item of items) {
    if (delta.has(item.line.number)) continue;
    const d = by(item);
    if (!d) continue;
    delta.set(item.line.number, d);
    // Its children come too: the lines after it indented deeper than it.
    for (let n = item.line.number + 1; n <= state.doc.lines; n++) {
      const line = state.doc.line(n);
      if (!line.text.trim()) continue;
      if (leading(line.text).columns <= item.indent) break;
      if (!delta.has(n)) delta.set(n, d);
    }
  }
  return [...delta].map(([n, d]) => {
    const line = state.doc.line(n);
    const { columns, length } = leading(line.text);
    return { from: line.from, to: line.from + length, insert: ' '.repeat(Math.max(0, columns + d)) };
  });
}

function listCommand(by: (state: EditorState, item: Item) => number, otherwise: StateCommand): StateCommand {
  return (target) => {
    const { state } = target;
    const items = selectedLines(state)
      .map((line) => itemAt(state, line))
      .filter((item): item is Item => item !== null);
    if (!items.length) return otherwise(target);
    const changes = shiftItems(state, items, (item) => by(state, item));
    // An item that can't move still takes the key, so focus stays put.
    if (changes.length) target.dispatch(state.update({ changes, scrollIntoView: true, userEvent: 'input.indent' }));
    return true;
  };
}

const plainTab: StateCommand = (target) =>
  target.state.selection.ranges.every((r) => r.empty) ? insertTab(target) : indentMore(target);

export const indentKeys = [
  { key: 'Tab', run: listCommand(indentBy, plainTab), shift: listCommand(outdentBy, indentLess) },
];

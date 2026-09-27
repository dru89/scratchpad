import { markdown } from '@codemirror/lang-markdown';
import { indentUnit } from '@codemirror/language';
import { EditorSelection, EditorState, type Transaction } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { indentKeys } from './indent';

const [{ run: tab, shift: shiftTab }] = indentKeys;

/** Runs a command on `doc`, where « and » mark the selection, or | a cursor. */
function press(command: typeof tab, doc: string): { text: string; handled: boolean } {
  const from = doc.search(/[|«]/);
  const to = doc.includes('»') ? doc.indexOf('»') - 1 : from;
  const text = doc.replace(/[|«»]/g, '');
  let state = EditorState.create({
    doc: text,
    selection: EditorSelection.range(from, to),
    extensions: [markdown(), indentUnit.of('\t')],
  });
  const handled = command({ state, dispatch: (tr: Transaction) => (state = tr.state) });
  return { text: state.doc.toString(), handled };
}

describe('Tab in a list', () => {
  it('makes an item a child of the one above', () => {
    expect(press(tab, '- a\n- b|').text).toBe('- a\n  - b');
    expect(press(tab, '1. a\n2. b|').text).toBe('1. a\n   2. b');
    expect(press(tab, '- [ ] a\n- [ ] b|').text).toBe('- [ ] a\n  - [ ] b');
  });

  it('brings the item’s children along', () => {
    expect(press(tab, '- a\n- b|\n  - c\n- d').text).toBe('- a\n  - b\n    - c\n- d');
  });

  it('indents every selected item once', () => {
    expect(press(tab, '- a\n- «b\n- c»').text).toBe('- a\n  - b\n  - c');
    expect(press(tab, '- a\n- «b\n  - c»').text).toBe('- a\n  - b\n    - c');
  });

  it('keeps the key when the first item can’t go deeper', () => {
    expect(press(tab, '- a|\n- b')).toEqual({ text: '- a\n- b', handled: true });
  });
});

describe('Shift-Tab in a list', () => {
  it('moves an item out to its parent’s level, children and all', () => {
    expect(press(shiftTab!, '- a\n  - b|\n    - c').text).toBe('- a\n- b\n  - c');
    expect(press(shiftTab!, '1. a\n   - b|').text).toBe('1. a\n- b');
  });
});

describe('Tab elsewhere', () => {
  it('inserts a tab at the cursor', () => {
    expect(press(tab, 'hello|').text).toBe('hello\t');
  });

  it('indents every selected line', () => {
    expect(press(tab, '«one\ntwo»').text).toBe('\tone\n\ttwo');
    expect(press(shiftTab!, '«\tone\n\ttwo»').text).toBe('one\ntwo');
  });

  it('treats list-like lines in code as code', () => {
    expect(press(tab, '```\n- a\n- b|\n```').text).toBe('```\n- a\n- b\t\n```');
  });
});

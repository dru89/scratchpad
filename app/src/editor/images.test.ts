import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { imageInsert, imageLineRanges, imagePasting } from './images';

const A = '0123456789abcdef0123456789abcdef.png';
const B = 'fedcba9876543210fedcba9876543210.jpg';
/** The length of ![](attachment:<name>). */
const L = 52;
const host = { add: async () => A, failed: () => {} };
const state = (doc: string) => EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), imagePasting(host)] });

describe('image lines', () => {
  it('finds lines that are only an attachment image', () => {
    const s = state(`# Shots\n![](attachment:${A})\n  ![alt](attachment:${B} "title")  \ntext ![](attachment:${A})\n![](https://example.com/x.png)`);
    expect(imageLineRanges(s).map(([, , name]) => name)).toEqual([A, B]);
  });

  it('keeps up with edits without rescanning everything', () => {
    let s = state(`one\n![](attachment:${A})\nthree`);
    expect(imageLineRanges(s)).toEqual([[4, 4 + L, A]]);
    // Typing above moves it.
    s = s.update({ changes: { from: 0, insert: 'zero\n' } }).state;
    expect(imageLineRanges(s)).toEqual([[9, 9 + L, A]]);
    // Text on its line makes it an ordinary line.
    s = s.update({ changes: { from: 9 + L, insert: ' more' } }).state;
    expect(imageLineRanges(s)).toEqual([]);
    s = s.update({ changes: { from: 9 + L, to: 9 + L + 5 } }).state;
    expect(imageLineRanges(s)).toEqual([[9, 9 + L, A]]);
    // A new one appears where it's typed.
    const end = s.doc.length;
    s = s.update({ changes: { from: end, insert: `\n![](attachment:${B})` } }).state;
    expect(imageLineRanges(s).map(([, , name]) => name)).toEqual([A, B]);
  });
});

describe('imageInsert', () => {
  const apply = (doc: string, pos: number, names: string[]) => {
    const s = EditorState.create({ doc });
    const t = s.update(imageInsert(s, pos, names));
    return [t.state.doc.toString(), t.state.selection.main.head] as const;
  };

  it('puts images on lines of their own and the cursor after them', () => {
    expect(apply('', 0, [A])).toEqual([`![](attachment:${A})\n`, L + 1]);
    expect(apply('see this', 8, [A])).toEqual([`see this\n![](attachment:${A})\n`, 8 + 1 + L + 1]);
    expect(apply('see this', 4, [A, B])).toEqual([`see \n![](attachment:${A})\n![](attachment:${B})\nthis`, 4 + 1 + 2 * (L + 1)]);
    expect(apply('above\n\nbelow', 6, [A])).toEqual([`above\n![](attachment:${A})\n\nbelow`, 6 + L + 1]);
  });
});

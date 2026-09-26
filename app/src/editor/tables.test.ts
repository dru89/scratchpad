import { SearchQuery } from '@codemirror/search';
import { describe, expect, it } from 'vitest';
import { matchPieces } from './tables';

describe('matchPieces', () => {
  it('finds matches in one text', () => {
    expect(matchPieces(new SearchQuery({ search: 'sync' }), ['Sync server, sync client'])).toEqual([
      [0, 0, 4],
      [0, 13, 17],
    ]);
  });

  it('splits a match across the texts it spans', () => {
    // "needs **more** work": the <strong> splits the cell into three texts.
    expect(matchPieces(new SearchQuery({ search: 's more w' }), ['needs ', 'more', ' work'])).toEqual([
      [0, 4, 6],
      [1, 0, 4],
      [2, 0, 2],
    ]);
  });

  it('follows the query options', () => {
    const texts = ['Sync, resync'];
    expect(matchPieces(new SearchQuery({ search: 'sync', caseSensitive: true }), texts)).toEqual([[0, 8, 12]]);
    expect(matchPieces(new SearchQuery({ search: 'sync', wholeWord: true }), texts)).toEqual([[0, 0, 4]]);
    expect(matchPieces(new SearchQuery({ search: 're?sync$', regexp: true }), texts)).toEqual([[0, 6, 12]]);
  });

  it('handles empty cells', () => {
    expect(matchPieces(new SearchQuery({ search: 'x' }), [])).toEqual([]);
  });
});

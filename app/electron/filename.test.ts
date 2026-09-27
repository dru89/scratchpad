import { describe, expect, it } from 'vitest';
import { fileStem } from './filename';

describe('fileStem', () => {
  // The same cases as file_stem in crates/core/src/export.rs.
  it('makes titles safe to use as file names', () => {
    expect(fileStem('Q4 planning notes')).toBe('Q4 planning notes');
    expect(fileStem('a/b: c? "d" <e>|f*')).toBe('a b c d e f');
    expect(fileStem('...hidden')).toBe('hidden');
    expect(fileStem('   ')).toBe('Untitled');
    expect(fileStem('New draft')).toBe('Untitled');
    expect(fileStem('con')).toBe('con_');
    expect([...fileStem('word '.repeat(40))].length).toBe(79);
  });
});

import { describe, expect, it } from 'vitest';
import { kbd, localTitle, markMatches, relativeTime, searchTerms } from './format';
import { shouldRollOver } from './idle';

describe('localTitle', () => {
  it('strips headings and inline syntax like the daemon', () => {
    expect(localTitle('# Title')).toBe('Title');
    expect(localTitle('**Idea:** thing')).toBe('Idea: thing');
    expect(localTitle('A [link](https://example.com) and `code`')).toBe('A link and code');
    expect(localTitle('~~old~~ _new_ \\*literal\\*')).toBe('old new *literal*');
  });

  it('strips block markers and skips lines without text', () => {
    expect(localTitle('> - # nested')).toBe('nested');
    expect(localTitle('- [ ] buy milk')).toBe('buy milk');
    expect(localTitle('\n\n---\n\nAfter the rule')).toBe('After the rule');
    expect(localTitle('| a | b |\n| --- | --- |')).toBe('a | b');
  });

  it('leaves hashtags and snake_case alone', () => {
    expect(localTitle('#idea for later')).toBe('#idea for later');
    expect(localTitle('rename some_var_name')).toBe('rename some_var_name');
  });

  it('is empty for empty drafts and cuts long lines', () => {
    expect(localTitle('  \n ')).toBe('');
    expect(localTitle('word '.repeat(40)).endsWith('…')).toBe(true);
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-09-26T12:00:00').getTime();
  it('counts minutes and hours', () => {
    expect(relativeTime(now - 20_000, now)).toBe('now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h');
  });
});

describe('searchTerms', () => {
  it('keeps quoted phrases whole, like the daemon', () => {
    expect(searchTerms('sync "rich copy" table')).toEqual(['sync', 'rich copy', 'table']);
    expect(searchTerms('  "unterminated phrase')).toEqual(['unterminated phrase']);
    expect(searchTerms('   ')).toEqual([]);
  });
});

describe('markMatches', () => {
  it('marks every term, ignoring case, and escapes the rest', () => {
    expect(markMatches('Sync <b> and resync', ['sync'])).toBe('<mark>Sync</mark> &lt;b&gt; and re<mark>sync</mark>');
    expect(markMatches('rich copy works', ['rich copy', 'copy'])).toBe('<mark>rich copy</mark> works');
    expect(markMatches('nothing here', [])).toBe('nothing here');
  });
});

describe('kbd', () => {
  it('makes one keycap per key, with glyphs for Enter and Backspace', () => {
    expect(kbd('Mod+Enter', false)).toBe('<kbd class="kbd">Ctrl</kbd><kbd class="kbd">↵</kbd>');
    expect(kbd('Mod+Enter', true)).toBe('<kbd class="kbd">⌘</kbd><kbd class="kbd">↵</kbd>');
  });

  it('uses macOS glyphs in menu order on macOS', () => {
    const caps = (html: string) => [...html.matchAll(/<kbd class="kbd">([^<]*)<\/kbd>/g)].map((m) => m[1]).join(' ');
    expect(caps(kbd('Mod+Shift+P', true))).toBe('⇧ ⌘ P');
    expect(caps(kbd('Mod+Alt+F', true))).toBe('⌥ ⌘ F');
    expect(caps(kbd('Mod+Shift+P', false))).toBe('Ctrl Shift P');
    expect(kbd('Shift+Backspace')).toBe('<kbd class="kbd">Shift</kbd><kbd class="kbd">⌫</kbd>');
  });
});

describe('shouldRollOver', () => {
  const base = { pinned: false, hasDraft: true, now: 100_000, loadedAt: 0, modifiedAt: 0, lastLocalEdit: 0, idleMs: 60_000 };
  it('rolls over an idle draft', () => expect(shouldRollOver(base)).toBe(true));
  it('never rolls over a pinned window or a new draft', () => {
    expect(shouldRollOver({ ...base, pinned: true })).toBe(false);
    expect(shouldRollOver({ ...base, hasDraft: false })).toBe(false);
  });
  it('counts the latest of load, stamp, and local edit', () => {
    expect(shouldRollOver({ ...base, loadedAt: 50_000 })).toBe(false);
    expect(shouldRollOver({ ...base, modifiedAt: 50_000 })).toBe(false);
    expect(shouldRollOver({ ...base, lastLocalEdit: 50_000 })).toBe(false);
  });
});

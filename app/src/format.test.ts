import { describe, expect, it } from 'vitest';
import { localTitle, relativeTime } from './format';
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

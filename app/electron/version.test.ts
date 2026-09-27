import { describe, expect, it } from 'vitest';
import { isOlder } from './version';

describe('isOlder', () => {
  it('compares versions by number', () => {
    expect(isOlder('0.1.9', '0.1.10')).toBe(true);
    expect(isOlder('0.1.2', '1.0.0')).toBe(true);
    expect(isOlder('0.1.2', '0.1.2')).toBe(false);
    expect(isOlder('0.2.0', '0.1.9')).toBe(false);
  });
});

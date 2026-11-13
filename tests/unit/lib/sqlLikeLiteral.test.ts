import { describe, it, expect } from 'vitest';
import { containsLikePattern, escapeLikeLiteral } from '@/lib/sqlLikeLiteral';

describe('escapeLikeLiteral', () => {
  it('escapes %, _ and backslash so the term is a literal substring', () => {
    expect(escapeLikeLiteral('50% off_x\\y')).toBe('50\\% off\\_x\\\\y');
  });
  it('passes undefined through and leaves plain text alone', () => {
    expect(escapeLikeLiteral(undefined)).toBeUndefined();
    expect(escapeLikeLiteral('Makro 100')).toBe('Makro 100');
  });
});

describe('containsLikePattern', () => {
  it('wraps the escaped term in %…%', () => {
    expect(containsLikePattern('a_b')).toBe('%a\\_b%');
    expect(containsLikePattern('50%')).toBe('%50\\%%');
  });
  it('is null for an absent or empty term, so the clause is disabled', () => {
    expect(containsLikePattern(undefined)).toBeNull();
    expect(containsLikePattern('')).toBeNull();
  });
});

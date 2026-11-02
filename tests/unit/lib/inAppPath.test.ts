/**
 * isInAppPath (budgets P5, review round 2): a notification link is a path on this site. A URL
 * parser strips tab, LF and CR, so '/<TAB>/evil.com' navigates to //evil.com: any control
 * character or white space anywhere is refused, as migration 954's CHECK refuses it.
 */
import { describe, expect, it } from 'vitest';
import { isInAppPath } from '@/lib/inAppPath';

describe('isInAppPath', () => {
  it.each([
    ['tab', '/\t/evil.com'], ['LF', '/\n/evil.com'], ['CR', '/\r/evil.com'], ['NUL', '/\u0000/evil.com'],
    ['space', '/ /evil.com'], ['DEL', '/\u007f/evil.com'], ['C1 control', '/a\u0085b'], ['no-break space', '/a b'],
    ['trailing LF', '/accounting\n'], ['protocol-relative', '//evil.com'], ['backslash host', '/\\evil.com'],
    ['scheme', 'https://evil.com'], ['javascript', 'javascript:alert(1)'], ['relative', 'accounting'], ['empty', ''],
  ])('refuses %s', (_n, href) => {
    expect(isInAppPath(href)).toBe(false);
  });

  it('refuses a path over 500 characters', () => {
    expect(isInAppPath(`/${'a'.repeat(499)}`)).toBe(true);
    expect(isInAppPath(`/${'a'.repeat(500)}`)).toBe(false);
  });

  it.each(['/', '/accounting/budgets', '/accounting/budgets?tab=alerts&x=%20#top', '/a/b\\c'])('accepts %s', (href) => {
    expect(isInAppPath(href)).toBe(true);
  });
});

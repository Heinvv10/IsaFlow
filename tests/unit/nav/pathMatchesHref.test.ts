import { describe, it, expect } from 'vitest';
import { pathMatchesHref, isLinkActive } from '@/components/accounting/navSections/activeTab';

describe('pathMatchesHref', () => {
  const cases: Array<[string, string, string, boolean]> = [
    ['exact path', '/a/b', '/a/b', true],
    ['child path', '/a/b', '/a/b/c', true],
    ['sibling sharing a prefix', '/a/b', '/a/bc', false],
    ['hyphenated sibling', '/accounting/customers', '/accounting/customers-x', false],
    ['fragment on the page', '/a/b', '/a/b#frag', true],
    ['fragment on the href', '/a/b#frag', '/a/b', true],
    ['fragment does not leak into a sibling', '/a/b', '/a/bc#frag', false],
    ['query on the page, none on the href', '/a/b', '/a/b?x=1', true],
    ['query subset', '/s?tab=a', '/s?tab=a&page=2', true],
    ['query value is not a substring match', '/s?tab=general', '/s?tab=generalx', false],
    ['query key is not a substring match', '/s?tab=a', '/s?subtab=a', false],
    ['missing query param', '/s?tab=a', '/s', false],
    ['query then fragment', '/s?tab=a', '/s?tab=a#top', true],
    ['repeated param', '/s?tab=a', '/s?tab=b&tab=a', true],
    ['valueless param', '/s?x', '/s?x', true],
    ['different path, same query', '/s?tab=a', '/t?tab=a', false],
    ['root href only matches root', '/', '/accounting', false],
  ];
  it.each(cases)('%s', (_name, href, asPath, expected) => {
    expect(pathMatchesHref(href, asPath)).toBe(expected);
  });

  it('isLinkActive is the same predicate', () => {
    expect(isLinkActive('/accounting/customers', '/accounting/customers-x')).toBe(false);
    expect(isLinkActive('/s?tab=general', '/s?tab=generalx')).toBe(false);
  });
});

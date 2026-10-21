import { describe, expect, it } from 'vitest';
import { searchPages } from '@/modules/accounting/services/core/pageSearch';

describe('searchPages — the top-bar search finds pages, not only records', () => {
  it('finds the Sage import from "sage"', () => {
    expect(searchPages('sage', 5)[0]).toMatchObject({ type: 'page', url: '/accounting/migration/sage', title: 'Import from Sage' });
  });

  it('finds the import pages from "import", "migrate" and "pastel"', () => {
    for (const q of ['import', 'Import', 'migrate', 'pastel']) {
      expect(searchPages(q, 5).map((r) => r.url)).toContain('/accounting/migration');
    }
  });

  it('ranks a title match above a keyword-only match', () => {
    const urls = searchPages('trial balance', 5).map((r) => r.url);
    expect(urls[0]).toBe('/accounting/trial-balance');
  });

  it('respects the limit and returns nothing for an unrelated word', () => {
    expect(searchPages('a', 2).length).toBeLessThanOrEqual(2);
    expect(searchPages('zzqx', 5)).toEqual([]);
  });
});

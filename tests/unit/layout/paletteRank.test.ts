import { describe, expect, it } from 'vitest';
import { TABS } from '@/components/accounting/accountingNavConfig';
import { buildNavIndex } from '@/components/accounting/navSections/navIndex';
import { filterActions, PALETTE_ACTIONS } from '@/components/layout/commandActions';
import { buildSections, pageResult, rankPages, type SearchResult } from '@/components/layout/paletteRank';

const index = buildNavIndex(TABS, true);
const rec = (over: Partial<SearchResult>): SearchResult => ({
  type: 'customer', id: 'c1', title: 'Acme', subtitle: '', url: '/accounting/customers?id=c1', icon: 'users', ...over,
});

describe('rankPages', () => {
  it('"vat" puts VAT201 first', () => {
    expect(rankPages(index, 'vat', 6)[0]?.label).toBe('VAT201');
  });
  it('every ranked page keeps the trail that leads to it', () => {
    const [first] = rankPages(index, 'trial balance', 3);
    expect(first?.label).toBe('Trial Balance');
    expect(first?.trail.length).toBeGreaterThan(0);
  });
  it('matches a section name through the trail, and the initials people say aloud', () => {
    expect(rankPages(index, 'payroll', 20).some((e) => e.trail[0] === 'Payroll')).toBe(true);
    expect(rankPages(index, 'tb', 5).map((e) => e.label)).toContain('Trial Balance');
    expect(rankPages(index, 'acme', 5)).toEqual([]);
  });
  it('returns nothing for an empty query or a zero limit', () => {
    expect(rankPages(index, '  ', 5)).toEqual([]);
    expect(rankPages(index, 'vat', 0)).toEqual([]);
  });
});

describe('actions', () => {
  it('lists the seven actions and no key hint that is not registered', () => {
    expect(PALETTE_ACTIONS.map((a) => a.label)).toEqual([
      'New invoice', 'New bill', 'New employee', 'New pay run', 'Import bank statement', 'Switch theme', 'Keyboard shortcuts',
    ]);
    expect(JSON.stringify(PALETTE_ACTIONS)).not.toMatch(/Ctrl\+Shift/);
  });
  it('filters by label first, then by keyword', () => {
    expect(filterActions('new inv')[0]?.id).toBe('new-invoice');
    expect(filterActions('dark mode').map((a) => a.id)).toEqual(['switch-theme']);
    expect(filterActions('zzzz')).toEqual([]);
  });
});

describe('buildSections', () => {
  it('empty query: Recent, then Actions, then Pages, and a recent page is not repeated under Pages', () => {
    const page = pageResult(index.find((e) => e.trail.length === 1) as NonNullable<typeof index[number]>);
    const sections = buildSections({ query: '', index, recent: [rec({}), page], server: [] });
    expect(sections.map((s) => s.id)).toEqual(['recent', 'actions', 'pages']);
    const pageUrls = sections[2]!.rows.map((r) => (r.kind === 'item' ? r.item.url : ''));
    expect(pageUrls).not.toContain(page.url);
  });
  it('a recent that is also a server hit appears once', () => {
    const r = rec({});
    const sections = buildSections({ query: 'acme', index, recent: [r], server: [r] });
    const urls = sections.flatMap((s) => s.rows).map((x) => (x.kind === 'item' ? x.item.url : x.action.id));
    expect(urls.filter((u) => u === r.url)).toHaveLength(1);
  });
  it('every page row carries the trail of its nav entry', () => {
    const pages = buildSections({ query: 'trial balance', index, recent: [], server: [] }).find((x) => x.id === 'pages');
    const row = pages?.rows[0];
    const entry = rankPages(index, 'trial balance', 1)[0]!;
    expect(entry.trail.length).toBeGreaterThan(0);
    expect(row && row.kind === 'item' && row.item.trail).toEqual(entry.trail);
  });
  it('a query: actions, pages, records in that order; records carry no trail', () => {
    const sections = buildSections({ query: 'new', index, recent: [], server: [rec({ title: 'Newco' })] });
    expect(sections.map((s) => s.id)).toEqual(['actions', 'pages', 'records']);
  });
  it('a server page hit gets the trail of the nav entry that owns its URL', () => {
    const owned = index.find((e) => e.trail.length > 0)!;
    const hit = rec({ type: 'page', url: owned.href, title: owned.label });
    const rows = buildSections({ query: 'zzzqq', index, recent: [], server: [hit] }).flatMap((s) => s.rows);
    const row = rows[0];
    expect(row && row.kind === 'item' && row.item.trail).toEqual(owned.trail);
  });
});

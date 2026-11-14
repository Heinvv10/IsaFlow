/**
 * The shared `detail: "summary"` / `group_by` contract (summaryMode.ts): what each argument combination means, what
 * is refused, and the wire shape of a summary.
 */
import { describe, it, expect } from 'vitest';
import { groupFields, parseSummaryRequest, summaryBody } from '@/lib/mcp/tools/summaryMode';
import type { GroupedSummary } from '@/modules/accounting/services/shared/groupedSummary';

const G = ['account', 'month'] as const;
const text = (r: { ok: false; error: { content: Array<{ text: string }> } }): string => r.error.content[0]!.text;

describe('parseSummaryRequest', () => {
  it('no new arguments: rows, exactly as before', () => {
    expect(parseSummaryRequest({}, G)).toEqual({ ok: true, summary: false, groupBy: null });
    expect(parseSummaryRequest({ limit: 5, cursor: 'c', offset: 3 }, G)).toEqual({ ok: true, summary: false, groupBy: null });
    expect(parseSummaryRequest({ detail: 'standard' }, G)).toEqual({ ok: true, summary: false, groupBy: null });
    expect(parseSummaryRequest({ detail: null, group_by: null }, G)).toEqual({ ok: true, summary: false, groupBy: null });
  });

  it('detail summary alone is totals; group_by alone implies summary', () => {
    expect(parseSummaryRequest({ detail: 'summary' }, G)).toEqual({ ok: true, summary: true, groupBy: null });
    expect(parseSummaryRequest({ group_by: 'month' }, G)).toEqual({ ok: true, summary: true, groupBy: 'month' });
    expect(parseSummaryRequest({ detail: 'summary', group_by: 'account' }, G)).toEqual({ ok: true, summary: true, groupBy: 'account' });
  });

  it('refuses an unknown group_by, naming the choices, and a non-string one', () => {
    const bad = parseSummaryRequest({ group_by: 'planet' }, G);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(text(bad)).toBe('group_by must be one of: account, month');
    expect(parseSummaryRequest({ group_by: 7 }, G).ok).toBe(false);
    expect(parseSummaryRequest({ group_by: ['month'] }, G).ok).toBe(false);
  });

  it('refuses group_by together with row detail', () => {
    expect(parseSummaryRequest({ group_by: 'month', detail: 'standard' }, G).ok).toBe(false);
    expect(parseSummaryRequest({ group_by: 'month', detail: 'full' }, G, true).ok).toBe(false);
  });

  it('a tool that gains detail refuses an unknown value; one that already had it keeps its fallback', () => {
    expect(parseSummaryRequest({ detail: 'everything' }, G).ok).toBe(false);
    expect(parseSummaryRequest({ detail: 5 }, G).ok).toBe(false);
    expect(parseSummaryRequest({ detail: 'everything' }, G, true)).toEqual({ ok: true, summary: false, groupBy: null });
    expect(parseSummaryRequest({ detail: 'full' }, G, true)).toEqual({ ok: true, summary: false, groupBy: null });
  });

  it('a summary covers the whole set: cursor and offset are refused, limit is ignored', () => {
    const withCursor = parseSummaryRequest({ detail: 'summary', cursor: 'abc' }, G);
    expect(withCursor.ok).toBe(false);
    if (!withCursor.ok) expect(text(withCursor)).toContain('omit cursor and offset');
    expect(parseSummaryRequest({ group_by: 'month', offset: 0 }, G).ok).toBe(false);
    expect(parseSummaryRequest({ detail: 'summary', limit: 1 }, G).ok).toBe(true);
  });
});

describe('summary wire shape', () => {
  const result: GroupedSummary = {
    totals: { count: 3, net: 30 },
    groups: [{ key: 'a', label: 'A', values: { count: 2, net: 20 } }, { key: 'b', label: null, values: { count: 1, net: 10 } }],
    groupsTotal: 2,
    other: null,
  };

  it('totals only', () => {
    expect(summaryBody({ ...result, groups: [], groupsTotal: 0 }, null, { period: 'x' })).toEqual({
      detail: 'summary', group_by: null, period: 'x', totals: { count: 3, net: 30 },
    });
  });

  it('with groups: each group flattens its measures next to key and label', () => {
    expect(summaryBody(result, 'account')).toEqual({
      detail: 'summary', group_by: 'account', totals: { count: 3, net: 30 },
      groups: [{ key: 'a', label: 'A', count: 2, net: 20 }, { key: 'b', label: null, count: 1, net: 10 }],
      groups_total: 2, groups_returned: 2, other: null,
    });
    expect(groupFields(result, 'account').groups_returned).toBe(2);
  });
});

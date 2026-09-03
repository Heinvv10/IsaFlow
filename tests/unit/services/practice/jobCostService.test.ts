/**
 * Where unbilled effort is actually stuck.
 *
 * The finding this exists for: `wip_report` counts only approved, billable,
 * unbilled time and returns 24 entries worth R42,455 on these books — while
 * 2,013 entries worth R2,448,850 sit in `submitted`, logged and sent for
 * approval and never approved. A practice reading WIP alone is out by R2.4m.
 * Showing every status side by side is what makes the blockage visible.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];
let rows: unknown[] = [];

vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ sql: strings.join('?'), values });
    return Promise.resolve(rows);
  },
}));

import { getJobCostReport } from '@/modules/accounting/services/practice/jobCostService';

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CLIENT = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const bucket = (over: Record<string, unknown>) => ({
  group_id: CLIENT, group_name: 'Weszak Beleggings',
  status: 'submitted', billable: true,
  hours: 10, value: 8500, entries: 5,
  posted_through: '2026-08-01T10:00:00Z',
  ...over,
});

beforeEach(() => {
  sqlCalls.length = 0;
  rows = [];
});

describe('getJobCostReport — every status side by side', () => {
  it('keeps each status in its own bucket instead of collapsing them', async () => {
    rows = [
      bucket({ status: 'approved', hours: 2, value: 1700, entries: 1 }),
      bucket({ status: 'submitted', hours: 100, value: 85000, entries: 50 }),
      bucket({ status: 'draft', hours: 3, value: 2550, entries: 2 }),
    ];
    const rep = await getJobCostReport(COMPANY, { groupBy: 'client' });
    const row = rep.rows[0]!;

    expect(row.byStatus.approved!.value).toBe(1700);
    expect(row.byStatus.submitted!.value).toBe(85000);
    expect(row.byStatus.draft!.value).toBe(2550);
    // R85,000 of work one approval away from being billable is the number a
    // WIP report cannot show.
    expect(row.totalValue).toBe(89250);
  });

  it('counts unbilled effort at ANY approval status, not only approved', async () => {
    rows = [
      bucket({ status: 'approved', hours: 2, value: 1700 }),
      bucket({ status: 'submitted', hours: 100, value: 85000 }),
    ];
    const rep = await getJobCostReport(COMPANY, { groupBy: 'client' });
    expect(rep.rows[0]!.unbilledValue).toBe(86700);
    expect(rep.totals.unbilledValue).toBe(86700);
  });

  it('excludes already-billed and non-chargeable time from unbilled', async () => {
    rows = [
      bucket({ status: 'submitted', hours: 10, value: 8500 }),
      bucket({ status: 'billed', hours: 4, value: 3400 }),
      bucket({ status: 'invoiced', hours: 4, value: 3400 }),
      bucket({ status: 'not_billable', hours: 4, value: 3400, billable: false }),
      bucket({ status: 'leave', hours: 8, value: 0, billable: false }),
    ];
    const rep = await getJobCostReport(COMPANY, { groupBy: 'client' });
    expect(rep.rows[0]!.unbilledValue).toBe(8500);
    // But the total still accounts for all of it.
    expect(rep.rows[0]!.totalValue).toBe(18700);
  });

  it('never counts non-billable time as unbilled even at an unbilled status', async () => {
    rows = [bucket({ status: 'submitted', hours: 8, value: 6800, billable: false })];
    const rep = await getJobCostReport(COMPANY, { groupBy: 'client' });
    expect(rep.rows[0]!.unbilledValue).toBe(0);
  });

  it('orders by unbilled value, so the biggest blockage is first', async () => {
    rows = [
      // Names chosen so ALPHABETICAL and unbilled-value order disagree — with
      // 'Big'/'Small' both orderings give the same answer and the assertion
      // proves nothing.
      bucket({ group_id: 'g1', group_name: 'Acme', status: 'submitted', value: 100 }),
      bucket({ group_id: 'g2', group_name: 'Zenith', status: 'submitted', value: 90000 }),
    ];
    const rep = await getJobCostReport(COMPANY, { groupBy: 'client' });
    expect(rep.rows.map((r) => r.groupName)).toEqual(['Zenith', 'Acme']);
  });
});

describe('getJobCostReport — completeness', () => {
  it('reports entries with no group as an exclusion carrying their value', async () => {
    rows = [
      bucket({ status: 'submitted', value: 8500 }),
      bucket({ group_id: null, group_name: null, status: 'draft', value: 1200, entries: 3 }),
    ];
    const rep = await getJobCostReport(COMPANY, { groupBy: 'client' });
    const ex = rep.excluded[0]!;

    expect(ex.reason).toBe('no_client');
    expect(ex.amount).toBe(1200);
    expect(ex.detail).toContain('3');
    // And it is outside the totals, not silently inside them.
    expect(rep.totals.value).toBe(8500);
    expect(rep.rowsTotal + rep.excluded.length).toBe(rep.universeTotal);
  });

  it('names the exclusion reason after the grouping that was asked for', async () => {
    rows = [bucket({ group_id: null, group_name: null, value: 500 })];
    const byItem = await getJobCostReport(COMPANY, { groupBy: 'work_item' });
    expect(byItem.excluded[0]!.reason).toBe('no_work_item');
  });

  it('pins posted_through to the latest entry consumed, never now()', async () => {
    rows = [
      bucket({ posted_through: '2026-01-01T10:00:00Z' }),
      bucket({ group_id: 'g2', posted_through: '2026-08-01T10:00:00Z' }),
    ];
    const rep = await getJobCostReport(COMPANY, { groupBy: 'client' });
    expect(rep.postedThrough).toBe('2026-08-01T10:00:00.000Z');
  });

  it('scopes the query by company and keeps every restricting predicate in WHERE', async () => {
    rows = [];
    await getJobCostReport(COMPANY, {
      groupBy: 'client', dateFrom: '2026-01-01', dateTo: '2026-12-31', practiceClientId: CLIENT,
    });
    const q = sqlCalls[0]!;
    expect(q.values).toContain(COMPANY);
    expect(q.values).toContain(CLIENT);
    // The three joins are for LABELS. A predicate in an outer join's ON clause
    // restricts nothing — kpiChartsService summed every transaction in the
    // company that way, and the total still looked plausible.
    const where = q.sql.slice(q.sql.indexOf('WHERE te.'));
    expect(where).toContain('te.company_id');
    expect(where).toContain('te.entry_date');
    expect(where).toContain('te.practice_client_id');
  });
});

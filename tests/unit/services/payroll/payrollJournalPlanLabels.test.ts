/**
 * The approve dialog's cost-centre labels (follow-up B of PR #1065): one
 * company-scoped read naming every CC1 on the plan's, the posted and the
 * replaced journal's lines — inactive centres included, since a posted line
 * may name one — and no read at all when no line carries a CC1.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: Array<{ text: string; values: unknown[] }> = [];
let rows: unknown[] = [];
vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => { calls.push({ text: strings.join('?'), values }); return Promise.resolve(rows); },
}));

import { withCostCentreLabels } from '@/modules/accounting/services/payroll/payrollJournalPlanLabels';

const line = (cc1Id: string | null) => ({ glAccountId: 'g', accountCode: '5210', accountName: 'Site', debit: 1, credit: 0, cc1Id });
const preview = (plan: unknown[], posted: unknown[] | null = null, replaces: unknown[] | null = null) => ({
  plan: { lines: plan }, posted: posted && { lines: posted }, replaces: replaces && { lines: replaces }, blocker: null, planHash: 'h',
}) as never;

beforeEach(() => { calls.length = 0; rows = []; });

describe('withCostCentreLabels', () => {
  it('reads every CC1 of the plan, posted and replaced lines once, scoped to the company, with no is_active filter', async () => {
    rows = [{ id: 'A', code: 'CC-A', name: 'Atlantic' }, { id: 'B', code: 'CC-B', name: 'Boland' }];
    const out = await withCostCentreLabels('co-1', preview([line('A'), line(null)], [line('B'), line('A')], [line('C')]));
    expect(out.costCentres).toEqual({ A: { code: 'CC-A', name: 'Atlantic' }, B: { code: 'CC-B', name: 'Boland' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.values).toEqual(['co-1', ['A', 'B', 'C']]);
    expect(calls[0]!.text).toContain('company_id');
    expect(calls[0]!.text).not.toContain('is_active');
  });

  it('asks nothing when no line carries a CC1', async () => {
    const out = await withCostCentreLabels('co-1', preview([line(null)]));
    expect(out.costCentres).toEqual({});
    expect(calls).toHaveLength(0);
  });
});

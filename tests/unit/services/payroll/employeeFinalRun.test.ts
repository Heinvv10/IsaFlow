/** Wave 5 UXP: "has a line on a final run" is one company-scoped EXISTS over the one finality predicate. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({ employee: true, hasFinal: false, queries: [] as string[], values: [] as unknown[][] }));

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('?');
    st.queries.push(q);
    st.values.push(values);
    if (q.includes('FROM payroll_employees')) return st.employee ? [{ '?column?': 1 }] : [];
    if (q.includes('EXISTS')) return [{ has_final: st.hasFinal }];
    throw new Error(`unexpected query ${q.slice(0, 60)}`);
  }),
}));

import { employeeHasFinalRun } from '@/modules/accounting/services/payroll/employeeFinalRun';

const C = '00000000-0000-4000-8000-000000000001';
const E = '11111111-1111-4111-8111-111111111111';
beforeEach(() => { st.employee = true; st.hasFinal = false; st.queries = []; st.values = []; });

describe('employeeHasFinalRun', () => {
  it('is null for an employee the company does not have, and reads no runs', async () => {
    st.employee = false;
    expect(await employeeHasFinalRun(C, E)).toBeNull();
    expect(st.queries.some(q => q.includes('EXISTS'))).toBe(false);
  });
  it('is the EXISTS answer, true and false', async () => {
    st.hasFinal = true;
    expect(await employeeHasFinalRun(C, E)).toBe(true);
    st.hasFinal = false;
    expect(await employeeHasFinalRun(C, E)).toBe(false);
  });
  it('asks for the one finality predicate, scoped to the company, with no row cap', async () => {
    await employeeHasFinalRun(C, E);
    const q = st.queries.find(x => x.includes('EXISTS'))!;
    expect(q).toContain("prh.status IN ('approved', 'paid')");
    expect(q).toContain('COALESCE(prh.approved_at, prh.approval_grandfathered_at) IS NOT NULL');
    expect(q).toContain('prh.company_id =');
    expect(q).not.toContain('LIMIT');
  });
});

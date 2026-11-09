/** Wave 5 UXP: "has a line on a final run" is one EXISTS answer, null for an unknown employee. The predicate and scoping are proved in the integration test. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({ employee: true, hasFinal: false, queries: [] as string[] }));

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    const q = strings.join('?');
    st.queries.push(q);
    if (q.includes('FROM payroll_employees')) return st.employee ? [{ '?column?': 1 }] : [];
    if (q.includes('EXISTS')) return [{ has_final: st.hasFinal }];
    throw new Error(`unexpected query ${q.slice(0, 60)}`);
  }),
}));

import { employeeHasFinalRun } from '@/modules/accounting/services/payroll/employeeFinalRun';

const C = '00000000-0000-4000-8000-000000000001';
const E = '11111111-1111-4111-8111-111111111111';
beforeEach(() => { st.employee = true; st.hasFinal = false; st.queries = []; });

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
});

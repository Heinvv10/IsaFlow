/** Wave 5 UXP: "has a line on a final run" is one EXISTS answer, null for an unknown employee. The predicate and scoping are proved in the integration test. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({ employee: true, hasFinal: false, queries: [] as string[] }));

vi.mock('@/lib/neon', () => ({
  sql: Object.assign(vi.fn(async (strings: TemplateStringsArray) => {
    st.queries.push(strings.join('?'));
    return st.employee ? [{ has_bank: false, has_final: st.hasFinal, latest: null }] : [];
  }), { unsafe: (text: string) => ({ unsafe: text }) }),
}));

import { employeeHasFinalRun } from '@/modules/accounting/services/payroll/employeeFinalRun';

const C = '00000000-0000-4000-8000-000000000001';
const E = '11111111-1111-4111-8111-111111111111';
beforeEach(() => { st.employee = true; st.hasFinal = false; st.queries = []; });

describe('employeeHasFinalRun', () => {
  it('is null for an employee the company does not have, and answers from one query', async () => {
    st.employee = false;
    expect(await employeeHasFinalRun(C, E)).toBeNull();
    expect(st.queries.length).toBe(1);
  });
  it('is the EXISTS answer, true and false', async () => {
    st.hasFinal = true;
    expect(await employeeHasFinalRun(C, E)).toBe(true);
    st.hasFinal = false;
    expect(await employeeHasFinalRun(C, E)).toBe(false);
  });
});

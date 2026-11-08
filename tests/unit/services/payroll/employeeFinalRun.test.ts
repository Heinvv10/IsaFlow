/** Wave 5 UXP: "has a line on a final run", short-circuiting, company-scoped, judged by the R-035 guard only. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({ employee: true, runs: [] as string[], final: new Set<string>(), judged: [] as string[] }));

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    const q = strings.join('?');
    if (q.includes('FROM payroll_employees')) return st.employee ? [{ '?column?': 1 }] : [];
    if (q.includes('FROM payroll_run_lines')) return st.runs.map(run_id => ({ run_id }));
    throw new Error(`unexpected query ${q.slice(0, 60)}`);
  }),
}));
vi.mock('@/modules/accounting/services/payroll/payslipFinal', () => ({
  isPayRunFinal: vi.fn(async (_c: string, runId: string) => { st.judged.push(runId); return st.final.has(runId); }),
}));

import { employeeHasFinalRun } from '@/modules/accounting/services/payroll/employeeFinalRun';

const C = '00000000-0000-4000-8000-000000000001';
const E = '11111111-1111-4111-8111-111111111111';
beforeEach(() => { st.employee = true; st.runs = []; st.final = new Set(); st.judged = []; });

describe('employeeHasFinalRun', () => {
  it('is null for an employee the company does not have', async () => {
    st.employee = false;
    expect(await employeeHasFinalRun(C, E)).toBeNull();
  });
  it('is false with no runs', async () => {
    expect(await employeeHasFinalRun(C, E)).toBe(false);
  });
  it('is false when every run is a draft (an approved row the guard has not cleared is not final)', async () => {
    st.runs = ['r2', 'r1'];
    expect(await employeeHasFinalRun(C, E)).toBe(false);
    expect(st.judged).toEqual(['r2', 'r1']);
  });
  it('stops at the first final run, newest first', async () => {
    st.runs = ['r3', 'r2', 'r1'];
    st.final = new Set(['r3', 'r1']);
    expect(await employeeHasFinalRun(C, E)).toBe(true);
    expect(st.judged).toEqual(['r3']);
  });
});

/**
 * Wave 5 FS: `isPayRunFinal` reads the approval stamp (`payslips_final_at`), nothing else.
 * It is final only while the run is approved or paid and stamped; a failed read (a TypeError,
 * a dropped connection, a Postgres error) is re-thrown, never a slip that silently says DRAFT.
 * The stamp itself (approve sets it, reopen clears it, the backfill) and the inverted wave-4
 * "known limit" are proven against real Postgres in tests/integration/fs-payslip-final.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({ rows: [] as unknown[], failWith: null as unknown, queries: [] as string[], params: [] as unknown[][] }));

vi.mock('@/lib/neon', () => ({
  withSavepoint: vi.fn(),
  sql: vi.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    if (st.failWith) throw st.failWith;
    st.queries.push(strings.join('?'));
    st.params.push(vals);
    return st.rows;
  }),
}));

import { isPayRunFinal } from '@/modules/accounting/services/payroll/payslipFinal';

beforeEach(() => { st.rows = []; st.failWith = null; st.queries = []; st.params = []; });

describe('isPayRunFinal: the stamp decides', () => {
  it('a stamped approved/paid run is final; no row (not stamped, not approved, other company) is DRAFT', async () => {
    st.rows = [{ '?column?': 1 }];
    expect(await isPayRunFinal('c', 'r')).toBe(true);
    st.rows = [];
    expect(await isPayRunFinal('c', 'r')).toBe(false);
  });

  it('reads one company-scoped statement on the stamp and the status, never the approval guard', async () => {
    await isPayRunFinal('co-1', 'run-1');
    expect(st.queries).toHaveLength(1);
    expect(st.queries[0]).toContain('payslips_final_at IS NOT NULL');
    expect(st.queries[0]).toContain("status IN ('approved', 'paid')");
    expect(st.params[0]).toEqual(['run-1', 'co-1']);
  });

  it('a TypeError is re-thrown, not DRAFT', async () => {
    st.failWith = new TypeError('Cannot read properties of undefined');
    await expect(isPayRunFinal('c', 'r')).rejects.toBeInstanceOf(TypeError);
  });

  it('a dropped connection with no SQLSTATE (ECONNRESET) is re-thrown', async () => {
    st.failWith = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', errno: -104, syscall: 'read' });
    await expect(isPayRunFinal('c', 'r')).rejects.toThrow('ECONNRESET');
  });

  it('a Postgres error is re-thrown', async () => {
    st.failWith = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014', severity: 'ERROR' });
    await expect(isPayRunFinal('c', 'r')).rejects.toThrow('statement timeout');
  });
});

/**
 * Wave 5 FS: `isPayRunFinal` reads the run header only: approved or paid with an approval time
 * (`COALESCE(approved_at, approval_grandfathered_at)`), never the R-035 guard. A failed read (a TypeError,
 * a dropped connection, a Postgres error) is re-thrown, never a slip that silently says DRAFT.
 * Approve, reopen and the inverted wave-4 "known limit" are proven against real Postgres in tests/integration/fs-payslip-final.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({ rows: [] as unknown[], failWith: null as unknown, queries: [] as string[], params: [] as unknown[][] }));

type Unsafe = { unsafe: string };
vi.mock('@/lib/neon', () => {
  const isUnsafe = (v: unknown): v is Unsafe => typeof v === 'object' && v !== null && 'unsafe' in v;
  return {
    withSavepoint: vi.fn(),
    // A spliced fragment (sql.unsafe, the one final-run rule payRunFinalSql) is inlined in the recorded text.
    sql: Object.assign(vi.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
      if (st.failWith) throw st.failWith;
      st.queries.push(strings.reduce((t, part, i) => t + part + (i < vals.length ? (isUnsafe(vals[i]) ? vals[i].unsafe : '?') : ''), ''));
      st.params.push(vals.filter((v) => !isUnsafe(v)));
      return st.rows;
    }), { unsafe: (text: string): Unsafe => ({ unsafe: text }) }),
  };
});

import { isPayRunFinal } from '@/modules/accounting/services/payroll/payslipFinal';

beforeEach(() => { st.rows = []; st.failWith = null; st.queries = []; st.params = []; });

describe('isPayRunFinal: the approval time decides', () => {
  it('an approved/paid run with an approval time is final; no row (no approval time, not approved, other company) is DRAFT', async () => {
    st.rows = [{ '?column?': 1 }];
    expect(await isPayRunFinal('c', 'r')).toBe(true);
    st.rows = [];
    expect(await isPayRunFinal('c', 'r')).toBe(false);
  });

  it('reads one company-scoped statement on status and approval time, never the approval guard', async () => {
    await isPayRunFinal('co-1', 'run-1');
    expect(st.queries).toHaveLength(1);
    expect(st.queries[0]).toContain('COALESCE(payroll_run_headers.approved_at, payroll_run_headers.approval_grandfathered_at) IS NOT NULL');
    expect(st.queries[0]).toContain("payroll_run_headers.status IN ('approved', 'paid')");
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

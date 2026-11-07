/**
 * Wave 4 PS: `isPayRunFinal` turns ONLY the R-035 guard's own refusals into DRAFT
 * (`PayRunNotApprovedError`, `ApprovalRequiredError`). Anything else — a bug (TypeError),
 * a dropped connection with no SQLSTATE (ECONNRESET), a Postgres error — is re-thrown,
 * so a failed read is a 500 and never a slip that quietly says DRAFT.
 *
 * Known limit, pinned (coordinator decision, wave 5 item): finality is judged against
 * TODAY's enforcement and rules. A run approved and paid while pay-run enforcement was
 * off turns DRAFT once enforcement is switched on, and drops out of later year-to-date
 * figures. The fix (stamp the clearance at approval) needs a migration and an approval
 * gate edit, outside wave 4. If this test goes red, the limit was fixed: update the
 * PR body's "Known limit" and payroll/.claude.md.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({
  enforced: false,
  failWith: null as unknown,
  ytdRows: [] as unknown[],
}));

vi.mock('@/lib/neon', () => ({
  withSavepoint: vi.fn(),
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    const q = strings.join('?');
    if (st.failWith) throw st.failWith;
    if (q.includes('prl.taxable_income')) return st.ytdRows;
    if (q.includes('FROM payroll_run_headers')) {
      return [{ status: 'paid', period_month: 7, period_year: 2026, total_gross: 50000, approval_grandfathered_at: null, approved_plan_hash: 'plan-h' }];
    }
    if (q.includes('FROM approval_requests ar')) return []; // no approval was ever recorded: enforcement was off
    throw new Error(`unexpected query ${q.slice(0, 80)}`);
  }),
}));
vi.mock('@/modules/accounting/services/gl/approvalEnforcement', () => ({ isEnforced: vi.fn(async () => st.enforced) }));
vi.mock('@/modules/accounting/services/gl/approvalMatching', () => ({
  checkApproval: vi.fn(async () => ({ matchedRule: { approverRole: 'admin', name: 'Payroll' }, existingRequest: null })),
}));
vi.mock('@/modules/accounting/services/payroll/payrollApprovalGate', () => ({ judgePayrollApproval: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { isPayRunFinal } from '@/modules/accounting/services/payroll/payslipFinal';
import { payslipYearToDate } from '@/modules/accounting/services/payroll/payslipYearToDate';

beforeEach(() => { st.enforced = false; st.failWith = null; st.ytdRows = []; });

describe('isPayRunFinal: only the guard\'s refusals are DRAFT', () => {
  it('a paid run with enforcement off is final; with enforcement on and no approval it is DRAFT (ApprovalRequiredError)', async () => {
    expect(await isPayRunFinal('c', 'r')).toBe(true);
    st.enforced = true;
    expect(await isPayRunFinal('c', 'r')).toBe(false);
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

describe('Known limit (pinned): finality is re-judged against today\'s enforcement', () => {
  it('a July run approved and paid with enforcement off turns DRAFT when enforcement is switched on, and leaves the year to date', async () => {
    st.ytdRows = [
      { run_id: 'jul', employee_id: 'e', gross_pay: '1000.00', taxable_income: '1000.00', paye: '100.00', uif_employee: '10.00', net_pay: '890.00' },
      { run_id: 'nov', employee_id: 'e', gross_pay: '2000.00', taxable_income: '2000.00', paye: '200.00', uif_employee: '20.00', net_pay: '1780.00' },
    ];
    const nov = { id: 'nov', periodMonth: 11, periodYear: 2026 };
    expect((await payslipYearToDate('c', nov, ['e'])).get('e')!.grossPay).toBe(3000); // July counted while it is final
    st.enforced = true; // the company turns on pay-run approvals in November
    expect(await isPayRunFinal('c', 'jul')).toBe(false);
    expect((await payslipYearToDate('c', nov, ['e'])).get('e')!.grossPay).toBe(2000); // July is gone, IRP5 still counts it
  });
});

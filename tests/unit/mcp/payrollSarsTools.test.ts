/**
 * MCP tools: emp201_status and irp5_data.
 *
 * emp201_status must NOT re-derive the declaration. `generateEMP201`'s status
 * filter was `'calculated'` until recently — 1 of 86 production pay runs — so
 * the monthly PAYE/UIF/SDL declaration was built from a single run. The fix
 * belongs in that service and a second implementation here would be free to
 * drift from it.
 *
 * irp5_data must agree with it about which runs happened. A certificate and a
 * monthly declaration that disagree are worse than either being missing,
 * because nothing says which one is wrong.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/reports/emp201Service', () => ({
  generateEMP201: vi.fn(),
}));
vi.mock('@/modules/accounting/services/payroll/irp5DataService', () => ({
  getIrp5EmployeeTotals: vi.fn(),
}));

import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import { getIrp5EmployeeTotals } from '@/modules/accounting/services/payroll/irp5DataService';
import { emp201StatusTool, irp5DataTool } from '@/lib/mcp/tools/payrollSars';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = '22222222-2222-2222-2222-222222222222';
const OTHER = '99999999-9999-9999-9999-999999999999';
const EMPLOYEE = '55555555-5555-5555-5555-555555555555';

const ctx: McpToolContext = {
  userId: '33333333-3333-3333-3333-333333333333',
  companyId: COMPANY,
  scopes: ['read:payroll'],
  tokenJti: 'j',
  oauthAppId: null,
};

const json = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

const EMP201 = {
  periodStart: '2026-01-01',
  periodEnd: '2026-03-31',
  totalPAYE: 63360.94,
  totalETI: 4000,
  payePayable: 59360.94,
  totalUIF_employee: 1624.84,
  totalUIF_employer: 1624.84,
  totalUIF: 3249.68,
  totalSDL: 3358,
  employeeCount: 10,
  totalTaxableRemuneration: 335800,
  totalDeductions: 69968.62,
  payrollRuns: [{
    id: 'r1', runDate: '2026-01-01', employeeCount: 10,
    grossPay: 335800, paye: 63360.94, eti: 4000, uif: 3249.68, sdl: 3358,
  }],
};

const IRP5 = {
  taxYear: 2026,
  periodStart: '2025-03-01',
  periodEnd: '2026-02-28',
  rows: [{
    employeeId: 'e1', employeeNumber: 'EMP001', firstName: 'Thandi', lastName: 'Mokoena',
    idNumber: '*********0089', taxNumber: '******6789', identityNumbersMasked: true,
    grossSalary: 480000, taxableIncome: 470000, paye: 96000,
    uifEmployee: 2124, uifEmployer: 2124, sdl: 4800, eti: 0, netPay: 381876,
    runsIncluded: 12,
  }],
  rowsTotal: 1,
  universeTotal: 2,
  excluded: [{
    id: 'non_declarable_runs', reason: 'run_not_declarable',
    detail: '3 payroll runs fall in this tax year but are not declarable', amount: 335800,
  }],
  postedThrough: '2026-02-28T10:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generateEMP201).mockResolvedValue(EMP201);
  vi.mocked(getIrp5EmployeeTotals).mockResolvedValue(IRP5);
});

describe('registration', () => {
  it('both are registered, mirrored, and read-only on read:payroll', () => {
    for (const n of ['emp201_status', 'irp5_data']) {
      expect(MCP_TOOLS.map((t) => t.name)).toContain(n);
      expect(CLIENT_MCP_TOOL_NAMES).toContain(n);
    }
    for (const t of [emp201StatusTool, irp5DataTool]) {
      expect(t.write).toBe(false);
      expect(t.scope).toBe('read:payroll');
    }
  });
});

describe('emp201_status', () => {
  it('reports PAYE withheld, the ETI offset, and PAYE actually payable as three numbers', async () => {
    const env = json(await emp201StatusTool.handler(
      { period_start: '2026-01-01', period_end: '2026-03-31' }, ctx,
    ));
    // Collapsing these to one figure is how a company either over-remits or
    // claims an incentive it cannot evidence.
    expect(env.paye_withheld).toBe(63360.94);
    expect(env.eti_claimed).toBe(4000);
    expect(env.paye_payable).toBe(59360.94);
  });

  it('splits UIF and says the split is an approximation', async () => {
    const env = json(await emp201StatusTool.handler(
      { period_start: '2026-01-01', period_end: '2026-03-31' }, ctx,
    ));
    expect(env.uif_employee).toBe(1624.84);
    expect(env.uif_employer).toBe(1624.84);
    // The header stores one combined total, so a genuinely uneven split — an
    // employee over the ceiling, or UIF-excluded — comes out wrong.
    expect(env.uif_split_is_approximate).toBe(true);
  });

  it('returns the runs each figure came from, so the reader can check them', async () => {
    const env = json(await emp201StatusTool.handler(
      { period_start: '2026-01-01', period_end: '2026-03-31' }, ctx,
    ));
    expect(env.rows[0].run_id).toBe('r1');
    expect(env.rows[0].eti).toBe(4000);
  });

  it('does not re-derive the declaration — the service owns it', async () => {
    await emp201StatusTool.handler({ period_start: '2026-01-01', period_end: '2026-03-31' }, ctx);
    expect(generateEMP201).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateEMP201).mock.calls[0]![0]).toBe(COMPANY);
  });

  it('takes the company from the context, never from args', async () => {
    await emp201StatusTool.handler(
      { period_start: '2026-01-01', period_end: '2026-03-31', company_id: OTHER }, ctx,
    );
    expect(vi.mocked(generateEMP201).mock.calls[0]![0]).toBe(COMPANY);
  });

  it('refuses an inverted range and an impossible date before a cast', async () => {
    for (const args of [
      { period_start: '2026-03-31', period_end: '2026-01-01' },
      { period_start: '2026-02-31', period_end: '2026-03-31' },
    ]) {
      const res = await emp201StatusTool.handler(args, ctx);
      expect(res.isError).toBe(true);
    }
    expect(generateEMP201).not.toHaveBeenCalled();
  });
});

describe('irp5_data', () => {
  it('returns per-employee annual totals over the SA tax year, not the calendar year', async () => {
    const env = json(await irp5DataTool.handler({ tax_year: 2026 }, ctx));
    expect(env.period_start).toBe('2025-03-01');
    expect(env.period_end).toBe('2026-02-28');
    expect(env.as_at).toBe('2026-02-28');
    expect(env.rows[0].gross_salary).toBe(480000);
    expect(env.rows[0].runs_included).toBe(12);
  });

  it('masks identity numbers by default and reveals them only on request', async () => {
    await irp5DataTool.handler({ tax_year: 2026 }, ctx);
    expect(vi.mocked(getIrp5EmployeeTotals).mock.calls[0]![2]!.revealIdentityNumbers).toBe(false);
    vi.clearAllMocks();
    vi.mocked(getIrp5EmployeeTotals).mockResolvedValue(IRP5);
    await irp5DataTool.handler({ tax_year: 2026, reveal_identity_numbers: true }, ctx);
    expect(vi.mocked(getIrp5EmployeeTotals).mock.calls[0]![2]!.revealIdentityNumbers).toBe(true);
  });

  it('carries the non-declarable runs through as an exclusion with their remuneration', async () => {
    const env = json(await irp5DataTool.handler({ tax_year: 2026 }, ctx));
    expect(env.excludedRows[0].reason).toBe('run_not_declarable');
    expect(env.excludedRows[0].amount).toBe(335800);
    expect(env.rowsTotal + env.excludedRows.length).toBe(2);
    expect(env.completenessFault).toBeUndefined();
  });

  it('refuses a tax year that is not a whole four-digit year', async () => {
    for (const tax_year of [2026.5, 'abc', 12, undefined]) {
      const res = await irp5DataTool.handler({ tax_year }, ctx);
      expect(res.isError).toBe(true);
    }
    expect(getIrp5EmployeeTotals).not.toHaveBeenCalled();
  });

  it('refuses a malformed employee_id before it reaches a cast', async () => {
    const res = await irp5DataTool.handler({ tax_year: 2026, employee_id: 'abc' }, ctx);
    expect(res.isError).toBe(true);
    expect(getIrp5EmployeeTotals).not.toHaveBeenCalled();
  });

  it('takes the company from the context, never from args', async () => {
    await irp5DataTool.handler({ tax_year: 2026, company_id: OTHER }, ctx);
    expect(vi.mocked(getIrp5EmployeeTotals).mock.calls[0]![0]).toBe(COMPANY);
  });
});

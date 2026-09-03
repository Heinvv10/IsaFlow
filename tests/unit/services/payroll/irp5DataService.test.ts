/**
 * Per-employee annual totals for an IRP5.
 *
 * Nothing assembled these before. `irp5Service#buildIRP5Certificate` takes an
 * IRP5EmployeeData and the only caller of that module, sars/emp501.ts,
 * aggregates `payroll_runs` and `payslips` — two tables dropped in migration
 * 384 — so it throws 42P01 on every call.
 *
 * The two properties that matter here are the tenant boundary and the status
 * vocabulary. `payroll_run_lines` has NO company_id, so the join to the header
 * IS the scope; and the declarable statuses have to be the same ones the EMP201
 * uses, or a company's certificates and its monthly declarations disagree about
 * which runs happened.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];
let mockImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);

vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ sql: strings.join('?'), values });
    return mockImpl(strings, ...values);
  },
}));

import {
  getIrp5EmployeeTotals,
  saTaxYearBounds,
} from '@/modules/accounting/services/payroll/irp5DataService';
import { EMP201_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const EMPLOYEE = {
  id: 'e1', employee_number: 'EMP001', first_name: 'Thandi', last_name: 'Mokoena',
  id_number: '9001015800089', tax_number: '0123456789',
  gross_pay: 480000, taxable_income: 470000, paye: 96000,
  uif_employee: 2124, uif_employer: 2124, sdl: 4800, eti: 0, net_pay: 381876,
  runs_included: 12, posted_through: '2026-02-28T10:00:00Z',
};

function routeMock(over: { employees?: unknown[]; nonDeclarable?: unknown[] } = {}) {
  mockImpl = (strings) => {
    const q = strings.join('?');
    // The exclusion query is now per EMPLOYEE, so it returns employee rows.
    if (q.includes('NOT (prh.status = ANY')) {
      return Promise.resolve(over.nonDeclarable ?? []);
    }
    return Promise.resolve(over.employees ?? [EMPLOYEE]);
  };
}

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
});

describe('saTaxYearBounds — the SA tax year is not the calendar year', () => {
  it('runs 1 March of the prior year to the last day of February', () => {
    expect(saTaxYearBounds(2026)).toEqual({ start: '2025-03-01', end: '2026-02-28' });
  });

  it('ends on the 29th in a leap year', () => {
    // A hardcoded '-02-28' loses a day of remuneration every fourth year.
    expect(saTaxYearBounds(2028).end).toBe('2028-02-29');
  });

  it('handles the century rule', () => {
    expect(saTaxYearBounds(2100).end).toBe('2100-02-28');
    expect(saTaxYearBounds(2000).end).toBe('2000-02-29');
  });
});

describe('getIrp5EmployeeTotals — tenant scope and status vocabulary', () => {
  it('scopes through payroll_run_headers, which is the only tenant column there is', async () => {
    routeMock();
    await getIrp5EmployeeTotals(COMPANY, 2026);
    const q = sqlCalls.find((c) => c.sql.includes('payroll_run_lines'))!;
    // payroll_run_lines has NO company_id. The join to the header IS the scope,
    // so it must be INNER and the predicate must be in WHERE — in an outer
    // join's ON clause it would restrict nothing.
    expect(q.sql).toContain('JOIN payroll_run_headers');
    expect(q.sql).not.toMatch(/LEFT JOIN payroll_run_headers/);
    const where = q.sql.slice(q.sql.indexOf('WHERE prh.'));
    expect(where).toContain('prh.company_id');
    expect(where).toContain('e.company_id');
    expect(q.values).toContain(COMPANY);
  });

  it('uses the SAME declarable statuses as the EMP201', async () => {
    routeMock();
    await getIrp5EmployeeTotals(COMPANY, 2026);
    const q = sqlCalls.find((c) => c.sql.includes('payroll_run_lines'))!;
    // If a certificate and a monthly declaration disagree about which runs
    // happened, one of them is wrong and nothing says which.
    expect(q.values).toContainEqual([...EMP201_DECLARABLE_STATUSES]);
  });

  it('sums a full year of run lines per employee', async () => {
    routeMock();
    const ds = await getIrp5EmployeeTotals(COMPANY, 2026);
    const row = ds.rows[0]!;
    expect(row.grossSalary).toBe(480000);
    expect(row.paye).toBe(96000);
    expect(row.uifEmployee).toBe(2124);
    expect(row.uifEmployer).toBe(2124);
    expect(row.runsIncluded).toBe(12);
    expect(ds.periodStart).toBe('2025-03-01');
    expect(ds.periodEnd).toBe('2026-02-28');
  });
});

describe('getIrp5EmployeeTotals — POPIA and completeness', () => {
  it('masks the SA ID and tax number by default', async () => {
    routeMock();
    const ds = await getIrp5EmployeeTotals(COMPANY, 2026);
    expect(ds.rows[0]!.idNumber).toBe('*********0089');
    expect(ds.rows[0]!.taxNumber).toBe('******6789');
    expect(ds.rows[0]!.identityNumbersMasked).toBe(true);
  });

  it('reveals them only on an explicit request', async () => {
    routeMock();
    const ds = await getIrp5EmployeeTotals(COMPANY, 2026, { revealIdentityNumbers: true });
    expect(ds.rows[0]!.idNumber).toBe('9001015800089');
    expect(ds.rows[0]!.identityNumbersMasked).toBe(false);
  });

  it('names each employee whose runs were never declarable, with what they carry', async () => {
    routeMock({
      nonDeclarable: [
        { id: 'e2', employee_number: 'EMP002', first_name: 'Sipho', last_name: 'Dlamini', gross: 200000, runs: 3 },
        { id: 'e3', employee_number: 'EMP003', first_name: 'Naledi', last_name: 'Khumalo', gross: 135800, runs: 3 },
      ],
    });
    const ds = await getIrp5EmployeeTotals(COMPANY, 2026);

    // "This employee earned nothing" and "this employee's runs were never
    // approved" are different facts.
    expect(ds.excluded).toHaveLength(2);
    expect(ds.excluded.every(e => e.reason === 'run_not_declarable')).toBe(true);
    expect(ds.excluded.map(e => e.id)).toEqual(['e2', 'e3']);
    expect(ds.excluded.map(e => e.amount)).toEqual([200000, 135800]);
    expect(ds.excluded[0]!.detail).toContain('Sipho Dlamini');
    expect(ds.excluded[0]!.detail).toContain('3');

    // Both sides count EMPLOYEES. An aggregate row standing for N of them made
    // this arithmetic pass while under-reporting the universe.
    expect(ds.excludedTotal).toBe(2);
    expect(ds.rowsTotal + ds.excludedTotal).toBe(ds.universeTotal);
    expect(ds.universeTotal).toBe(3);
  });

  // Above the sample cap, `excluded.length` and `excludedTotal` diverge, and
  // universeTotal must follow the COUNT rather than the list — otherwise the
  // universe silently shrinks to the cap.
  it('reports the full excluded count when the list is capped at 200', async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      id: `x${i}`, employee_number: `E${i}`, first_name: 'A', last_name: `B${i}`,
      gross: 1000, runs: 1,
    }));
    routeMock({ nonDeclarable: many });
    const ds = await getIrp5EmployeeTotals(COMPANY, 2026);

    expect(ds.excluded).toHaveLength(200);
    expect(ds.excludedTotal).toBe(250);
    expect(ds.universeTotal).toBe(251);
    expect(ds.rowsTotal + ds.excludedTotal).toBe(ds.universeTotal);
  });

  it('pins posted_through to the latest run line consumed, never now()', async () => {
    routeMock();
    const ds = await getIrp5EmployeeTotals(COMPANY, 2026);
    expect(ds.postedThrough).toBe('2026-02-28T10:00:00.000Z');
  });
});

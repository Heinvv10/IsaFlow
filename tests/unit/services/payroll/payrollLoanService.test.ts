import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];
let mockImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);

vi.mock('@/lib/neon', () => {
  const fakeStrings = (text: string): TemplateStringsArray =>
    Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray;
  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ sql: strings.join('?'), values });
    return mockImpl(strings, ...values);
  };
  (sqlFn as unknown as { unsafe: (text: string, values?: unknown[]) => unknown }).unsafe = (
    text: string,
    values: unknown[] = [],
  ) => {
    sqlCalls.push({ sql: text, values });
    return mockImpl(fakeStrings(text), ...values);
  };
  (sqlFn as unknown as { transaction: (fn: unknown) => Promise<unknown> }).transaction = async (
    fn: unknown,
  ) => {
    if (typeof fn === 'function') {
      const list = (fn as (tx: unknown) => unknown[])(sqlFn);
      return Promise.all(list.map(q => (q as Promise<unknown>)));
    }
    return [];
  };
  return { sql: sqlFn };
});

import {
  buildSchedule,
  createLoan,
  applyLoanToRun,
  closeLoan,
  LoanNotFoundError,
  LoanClosedError,
} from '@/modules/accounting/services/payroll/payrollLoanService';

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const EMPLOYEE_ID = 'e0000001-0000-0000-0000-000000000001';
const LOAN_ID = 'l0000001-0000-0000-0000-000000000001';
const USER_ID = 'user-1';
const RUN_ID = 'r0000001-0000-0000-0000-000000000001';

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
});

describe('buildSchedule', () => {
  it('declining_balance: interest on opening balance, equal total installment', () => {
    const schedule = buildSchedule({
      principal: 12_000,
      annualInterestRate: 0.12,
      termMonths: 12,
      method: 'declining_balance',
      firstPeriodYear: 2026,
      firstPeriodMonth: 1,
    });

    expect(schedule).toHaveLength(12);
    const first = schedule[0]!;
    expect(first.sequence).toBe(1);
    expect(first.openingBalance).toBeCloseTo(12_000, 2);
    expect(first.interest).toBeCloseTo(120, 2);
    expect(first.installment).toBeCloseTo(first.principal + first.interest, 2);
    expect(first.duePeriodYear).toBe(2026);
    expect(first.duePeriodMonth).toBe(1);

    const last = schedule[11]!;
    expect(last.closingBalance).toBeCloseTo(0, 2);

    const totalInstallments: number = schedule.reduce(
      (sum: number, r) => sum + r.installment,
      0 as number,
    );
    expect(totalInstallments).toBeGreaterThan(12_000);
  });

  it('straight_line: equal principal, reducing interest', () => {
    const schedule = buildSchedule({
      principal: 12_000,
      annualInterestRate: 0.12,
      termMonths: 12,
      method: 'straight_line',
      firstPeriodYear: 2026,
      firstPeriodMonth: 1,
    });

    expect(schedule).toHaveLength(12);
    expect(schedule[0]!.principal).toBeCloseTo(1000, 2);
    expect(schedule[11]!.principal).toBeCloseTo(1000, 2);
    expect(schedule[0]!.interest).toBeGreaterThan(schedule[11]!.interest);
    expect(schedule[11]!.closingBalance).toBeCloseTo(0, 2);
  });

  it('interest_free: principal only, zero interest each row', () => {
    const schedule = buildSchedule({
      principal: 6_000,
      annualInterestRate: 0,
      termMonths: 6,
      method: 'interest_free',
      firstPeriodYear: 2026,
      firstPeriodMonth: 1,
    });

    expect(schedule).toHaveLength(6);
    for (const row of schedule) expect(row.interest).toBe(0);
    expect(schedule[0]!.principal).toBeCloseTo(1000, 2);
    expect(schedule[5]!.closingBalance).toBeCloseTo(0, 2);
  });

  it('rolls period month across year boundary', () => {
    const schedule = buildSchedule({
      principal: 1_200,
      annualInterestRate: 0,
      termMonths: 3,
      method: 'interest_free',
      firstPeriodYear: 2026,
      firstPeriodMonth: 11,
    });
    expect(schedule[0]!.duePeriodMonth).toBe(11);
    expect(schedule[0]!.duePeriodYear).toBe(2026);
    expect(schedule[1]!.duePeriodMonth).toBe(12);
    expect(schedule[2]!.duePeriodMonth).toBe(1);
    expect(schedule[2]!.duePeriodYear).toBe(2027);
  });
});

describe('createLoan', () => {
  it('inserts loan + schedule rows inside a transaction', async () => {
    const loanRow = {
      id: LOAN_ID,
      company_id: COMPANY_ID,
      employee_id: EMPLOYEE_ID,
      loan_number: 'L-0001',
      description: 'Bridging loan',
      principal: '12000.00',
      annual_interest_rate: '0.12',
      term_months: 12,
      method: 'declining_balance',
      start_date: new Date('2026-01-01'),
      first_deduction_period_year: 2026,
      first_deduction_period_month: 1,
      status: 'active',
      outstanding_balance: '12000.00',
      total_interest_charged: '0',
      total_principal_paid: '0',
      notes: null,
      created_by: USER_ID,
      created_at: new Date(),
      updated_at: new Date(),
      settled_at: null,
    };

    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employees')) return Promise.resolve([{ id: EMPLOYEE_ID }]);
      if (q.includes('INSERT INTO payroll_loans')) return Promise.resolve([loanRow]);
      if (q.includes('INSERT INTO payroll_loan_schedule')) return Promise.resolve([]);
      return Promise.resolve([]);
    };

    const loan = await createLoan({
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      loanNumber: 'L-0001',
      description: 'Bridging loan',
      principal: 12_000,
      annualInterestRate: 0.12,
      termMonths: 12,
      method: 'declining_balance',
      startDate: new Date('2026-01-01'),
      firstPeriodYear: 2026,
      firstPeriodMonth: 1,
      userId: USER_ID,
    });

    expect(loan.id).toBe(LOAN_ID);
    expect(loan.outstandingBalance).toBe(12_000);

    const scheduleInserts = sqlCalls.filter(c => c.sql.includes('INSERT INTO payroll_loan_schedule'));
    expect(scheduleInserts.length).toBeGreaterThan(0);
  });

  it('rejects when employee not in company', async () => {
    mockImpl = () => Promise.resolve([]);
    await expect(
      createLoan({
        companyId: COMPANY_ID,
        employeeId: EMPLOYEE_ID,
        loanNumber: 'L-0001',
        description: 'x',
        principal: 1000,
        annualInterestRate: 0,
        termMonths: 6,
        method: 'interest_free',
        startDate: new Date('2026-01-01'),
        firstPeriodYear: 2026,
        firstPeriodMonth: 1,
        userId: USER_ID,
      }),
    ).rejects.toThrow(/not found in company/i);
  });
});

describe('applyLoanToRun', () => {
  it('returns the due schedule row, records a payment, and decrements outstanding balance', async () => {
    const loanRow = {
      id: LOAN_ID,
      company_id: COMPANY_ID,
      employee_id: EMPLOYEE_ID,
      status: 'active',
      outstanding_balance: '12000.00',
      total_interest_charged: '0',
      total_principal_paid: '0',
      method: 'declining_balance',
      annual_interest_rate: '0.12',
    };
    const scheduleRow = {
      id: 's1',
      loan_id: LOAN_ID,
      sequence: 1,
      opening_balance: '12000.00',
      interest: '120.00',
      principal: '940.00',
      installment: '1060.00',
      closing_balance: '11060.00',
      paid_flag: false,
    };

    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_loans')) return Promise.resolve([loanRow]);
      if (q.includes('FROM payroll_loan_schedule')) return Promise.resolve([scheduleRow]);
      if (q.includes('INSERT INTO payroll_loan_payments')) return Promise.resolve([{ id: 'pmt-1' }]);
      if (q.includes('UPDATE payroll_loan_schedule')) return Promise.resolve([]);
      if (q.includes('UPDATE payroll_loans')) return Promise.resolve([]);
      return Promise.resolve([]);
    };

    const result = await applyLoanToRun({
      loanId: LOAN_ID,
      companyId: COMPANY_ID,
      runId: RUN_ID,
      periodYear: 2026,
      periodMonth: 1,
      officialRate: 0.085,
    });

    expect(result).not.toBeNull();
    expect(result!.interest).toBeCloseTo(120, 2);
    expect(result!.principal).toBeCloseTo(940, 2);
    expect(result!.fringeBenefit).toBe(0);

    expect(sqlCalls.some(c => c.sql.includes('INSERT INTO payroll_loan_payments'))).toBe(true);
    expect(sqlCalls.some(c => c.sql.includes('UPDATE payroll_loans'))).toBe(true);
  });

  it('records fringe benefit when loan rate < official rate', async () => {
    const loanRow = {
      id: LOAN_ID,
      company_id: COMPANY_ID,
      employee_id: EMPLOYEE_ID,
      status: 'active',
      outstanding_balance: '12000.00',
      total_interest_charged: '0',
      total_principal_paid: '0',
      method: 'interest_free',
      annual_interest_rate: '0',
    };
    const scheduleRow = {
      id: 's1',
      loan_id: LOAN_ID,
      sequence: 1,
      opening_balance: '12000.00',
      interest: '0',
      principal: '1000.00',
      installment: '1000.00',
      closing_balance: '11000.00',
      paid_flag: false,
    };

    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_loans')) return Promise.resolve([loanRow]);
      if (q.includes('FROM payroll_loan_schedule')) return Promise.resolve([scheduleRow]);
      return Promise.resolve([]);
    };

    const result = await applyLoanToRun({
      loanId: LOAN_ID,
      companyId: COMPANY_ID,
      runId: RUN_ID,
      periodYear: 2026,
      periodMonth: 1,
      officialRate: 0.085,
    });

    expect(result!.fringeBenefit).toBeCloseTo((0.085 * 12_000) / 12, 2);
  });

  it('returns null when loan is not active', async () => {
    const loanRow = {
      id: LOAN_ID,
      status: 'settled',
      company_id: COMPANY_ID,
      employee_id: EMPLOYEE_ID,
      outstanding_balance: '0',
      total_interest_charged: '0',
      total_principal_paid: '12000',
      method: 'declining_balance',
      annual_interest_rate: '0.12',
    };
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_loans')) return Promise.resolve([loanRow]);
      return Promise.resolve([]);
    };

    const result = await applyLoanToRun({
      loanId: LOAN_ID,
      companyId: COMPANY_ID,
      runId: RUN_ID,
      periodYear: 2026,
      periodMonth: 1,
      officialRate: 0.085,
    });
    expect(result).toBeNull();
  });

  it('returns null when no schedule row due for the period', async () => {
    const loanRow = {
      id: LOAN_ID,
      status: 'active',
      company_id: COMPANY_ID,
      employee_id: EMPLOYEE_ID,
      outstanding_balance: '12000',
      total_interest_charged: '0',
      total_principal_paid: '0',
      method: 'declining_balance',
      annual_interest_rate: '0.12',
    };
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_loans')) return Promise.resolve([loanRow]);
      if (q.includes('FROM payroll_loan_schedule')) return Promise.resolve([]);
      return Promise.resolve([]);
    };

    const result = await applyLoanToRun({
      loanId: LOAN_ID,
      companyId: COMPANY_ID,
      runId: RUN_ID,
      periodYear: 2026,
      periodMonth: 1,
      officialRate: 0.085,
    });
    expect(result).toBeNull();
  });
});

describe('closeLoan', () => {
  it('settles an active loan and stamps settled_at', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_loans')) return Promise.resolve([{ id: LOAN_ID, status: 'active' }]);
      if (q.includes('UPDATE payroll_loans')) return Promise.resolve([]);
      return Promise.resolve([]);
    };

    await closeLoan(COMPANY_ID, LOAN_ID, 'settled', USER_ID);
    expect(sqlCalls.some(c => c.sql.includes('UPDATE payroll_loans') && c.values.includes('settled'))).toBe(true);
  });

  it('throws LoanNotFoundError on company mismatch', async () => {
    mockImpl = () => Promise.resolve([]);
    await expect(closeLoan(COMPANY_ID, LOAN_ID, 'settled', USER_ID)).rejects.toBeInstanceOf(LoanNotFoundError);
  });

  it('throws LoanClosedError when loan is already settled', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_loans')) return Promise.resolve([{ id: LOAN_ID, status: 'settled' }]);
      return Promise.resolve([]);
    };
    await expect(closeLoan(COMPANY_ID, LOAN_ID, 'settled', USER_ID)).rejects.toBeInstanceOf(LoanClosedError);
  });
});

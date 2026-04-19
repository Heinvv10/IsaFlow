import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- SQL mock ---
const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];
let mockSql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);

vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ sql: strings.join('?'), values });
    return mockSql(strings, ...values);
  },
}));

// --- getPayrollRun mock ---
const getPayrollRunMock = vi.fn();
vi.mock('@/modules/accounting/services/payroll/payrollRunService', () => ({
  getPayrollRun: (...args: unknown[]) => getPayrollRunMock(...args),
}));

// --- postPayrollRunToGL mock ---
const postGlMock = vi.fn().mockResolvedValue('je-123');
vi.mock('@/modules/accounting/services/payroll/payrollGlPostingService', () => ({
  postPayrollRunToGL: (...args: unknown[]) => postGlMock(...args),
}));

// --- reverseJournalEntry mock ---
const reverseJeMock = vi.fn().mockResolvedValue({ id: 'reversal-1' });
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({
  reverseJournalEntry: (...args: unknown[]) => reverseJeMock(...args),
}));

import {
  approvePayrollRun,
  markPaid,
  cancelPayrollRun,
} from '@/modules/accounting/services/payroll/payrollLifecycleService';

const COMPANY_ID = 'company-uuid-1';
const USER_ID = 'user-uuid-1';
const RUN_ID = 'run-uuid-1';

function makeRun(status: string, extras: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    companyId: COMPANY_ID,
    status,
    periodStart: '2024-01-01',
    periodEnd: '2024-01-31',
    totalGross: 10000,
    totalNet: 8000,
    totalTax: 2000,
    employeeCount: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extras,
  };
}

beforeEach(() => {
  sqlCalls.length = 0;
  getPayrollRunMock.mockReset();
  postGlMock.mockReset().mockResolvedValue('je-123');
  reverseJeMock.mockReset().mockResolvedValue({ id: 'reversal-1' });
  mockSql = () => Promise.resolve([]);
});

// =============================================================================
// approvePayrollRun
// =============================================================================
describe('approvePayrollRun', () => {
  it('calculated → approved: calls postPayrollRunToGL, UPDATEs with approved_by + approved_at', async () => {
    const calculatedRun = makeRun('calculated');
    const approvedRun = makeRun('approved');
    getPayrollRunMock
      .mockResolvedValueOnce(calculatedRun)  // initial load
      .mockResolvedValueOnce(approvedRun);   // post-UPDATE reload

    const result = await approvePayrollRun(COMPANY_ID, USER_ID, RUN_ID);

    expect(postGlMock).toHaveBeenCalledWith(COMPANY_ID, USER_ID, RUN_ID);
    expect(result.status).toBe('approved');

    const updateCall = sqlCalls.find(c => c.sql.includes('UPDATE payroll_run_headers'));
    expect(updateCall).toBeDefined();
    expect(updateCall?.sql).toContain('approved_by');
    expect(updateCall?.sql).toContain('approved_at');
  });

  it('throws when run not found', async () => {
    getPayrollRunMock.mockResolvedValueOnce(null);
    await expect(approvePayrollRun(COMPANY_ID, USER_ID, RUN_ID)).rejects.toThrow(
      `Payroll run ${RUN_ID} not found`,
    );
    expect(postGlMock).not.toHaveBeenCalled();
  });

  it('throws when status is draft', async () => {
    getPayrollRunMock.mockResolvedValueOnce(makeRun('draft'));
    await expect(approvePayrollRun(COMPANY_ID, USER_ID, RUN_ID)).rejects.toThrow(
      'Cannot approve run with status: draft',
    );
    expect(postGlMock).not.toHaveBeenCalled();
  });

  it('throws when status is paid', async () => {
    getPayrollRunMock.mockResolvedValueOnce(makeRun('paid'));
    await expect(approvePayrollRun(COMPANY_ID, USER_ID, RUN_ID)).rejects.toThrow(
      'Cannot approve run with status: paid',
    );
    expect(postGlMock).not.toHaveBeenCalled();
  });
});

// =============================================================================
// markPaid
// =============================================================================
describe('markPaid', () => {
  it('approved → paid: UPDATEs with paid_at, does NOT call GL functions', async () => {
    const approvedRun = makeRun('approved');
    const paidRun = makeRun('paid');
    getPayrollRunMock
      .mockResolvedValueOnce(approvedRun)
      .mockResolvedValueOnce(paidRun);

    const result = await markPaid(COMPANY_ID, USER_ID, RUN_ID);

    expect(postGlMock).not.toHaveBeenCalled();
    expect(reverseJeMock).not.toHaveBeenCalled();
    expect(result.status).toBe('paid');

    const updateCall = sqlCalls.find(c => c.sql.includes('UPDATE payroll_run_headers'));
    expect(updateCall).toBeDefined();
    expect(updateCall?.sql).toContain('paid_at');
  });

  it('throws when status is not approved', async () => {
    getPayrollRunMock.mockResolvedValueOnce(makeRun('calculated'));
    await expect(markPaid(COMPANY_ID, USER_ID, RUN_ID)).rejects.toThrow(
      'Cannot mark paid run with status: calculated',
    );
    expect(postGlMock).not.toHaveBeenCalled();
  });
});

// =============================================================================
// cancelPayrollRun
// =============================================================================
describe('cancelPayrollRun', () => {
  it('from approved: reads posted_je_id, calls reverseJournalEntry, UPDATEs with cancelled_by/at + clears posted_journal_entry_id', async () => {
    const approvedRun = makeRun('approved');
    const cancelledRun = makeRun('cancelled');
    getPayrollRunMock
      .mockResolvedValueOnce(approvedRun)
      .mockResolvedValueOnce(cancelledRun);

    // The SELECT for posted_journal_entry_id returns a row
    mockSql = () => Promise.resolve([{ posted_journal_entry_id: 'je-abc' }]);

    const result = await cancelPayrollRun(COMPANY_ID, USER_ID, RUN_ID);

    expect(reverseJeMock).toHaveBeenCalledWith(COMPANY_ID, 'je-abc', USER_ID);
    expect(result.status).toBe('cancelled');

    const updateCall = sqlCalls.find(c => c.sql.includes('UPDATE payroll_run_headers'));
    expect(updateCall).toBeDefined();
    expect(updateCall?.sql).toContain('cancelled_by');
    expect(updateCall?.sql).toContain('cancelled_at');
    expect(updateCall?.sql).toContain('posted_journal_entry_id');
  });

  it('from draft: does NOT call reverseJournalEntry', async () => {
    const draftRun = makeRun('draft');
    const cancelledRun = makeRun('cancelled');
    getPayrollRunMock
      .mockResolvedValueOnce(draftRun)
      .mockResolvedValueOnce(cancelledRun);

    await cancelPayrollRun(COMPANY_ID, USER_ID, RUN_ID);

    expect(reverseJeMock).not.toHaveBeenCalled();
  });

  it('from calculated: does NOT call reverseJournalEntry', async () => {
    const calculatedRun = makeRun('calculated');
    const cancelledRun = makeRun('cancelled');
    getPayrollRunMock
      .mockResolvedValueOnce(calculatedRun)
      .mockResolvedValueOnce(cancelledRun);

    await cancelPayrollRun(COMPANY_ID, USER_ID, RUN_ID);

    expect(reverseJeMock).not.toHaveBeenCalled();
  });

  it('throws when status is paid', async () => {
    getPayrollRunMock.mockResolvedValueOnce(makeRun('paid'));
    await expect(cancelPayrollRun(COMPANY_ID, USER_ID, RUN_ID)).rejects.toThrow(
      'Cannot cancel run with status: paid',
    );
    expect(reverseJeMock).not.toHaveBeenCalled();
  });
});

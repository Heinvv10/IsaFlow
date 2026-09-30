/**
 * Shared fixtures for the pay-run page RTL tests (W3-01). Shapes mirror the
 * real routes: GET /api/payroll/runs/[id], GET …/journal-plan (the approval
 * gate: plan, posted, blocker, planHash) and POST …/approve.
 */
export const RUN_ID = '11111111-1111-4111-8111-111111111111';
export const RUN_URL = `/api/payroll/runs/${RUN_ID}`;
export const PLAN_URL = `/api/payroll/runs/${RUN_ID}/journal-plan`;
export const APPROVE_URL = `/api/payroll/runs/${RUN_ID}/approve`;
export const PLAN_HASH = 'plan-hash-1';

export type Warning = { code: string; severity: 'warning'; message: string; deepLink?: string };
type Note = { code: string; detail: string };

export function line(id: string, name: string, warnings: Warning[] = [], over: Record<string, number> = {}) {
  return {
    id, runId: RUN_ID, employeeId: `e-${id}`, employeeNumber: `E00${id}`, employeeName: name,
    // Gross 75 000 − PAYE 19 966.33 − UIF 177.12 − net 41 681.55 = R13 175 of other deductions.
    grossPay: 75000, taxableIncome: 75000, paye: 19966.33, uifEmployee: 177.12, uifEmployer: 177.12,
    sdl: 750, eti: 0, netPay: 41681.55, validationResults: warnings, ...over,
  };
}

export function runBody(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID, companyId: 'c1', periodMonth: 9, periodYear: 2026, status: 'calculated',
    totalGross: 75000, totalPaye: 19966.33, totalUif: 354.24, totalSdl: 750, totalEti: 0,
    totalNet: 41681.55, employeeCount: 1, journalEntryId: null,
    lines: [line('1', 'Riaan Smit')],
    ...overrides,
  };
}

function planLine(accountCode: string, accountName: string, debit: number, credit: number) {
  return { glAccountId: `gl-${accountCode}`, accountCode, accountName, debit, credit, description: accountName, inactiveAccount: false };
}

export const PLAN_LINES = [
  planLine('5200', 'Salaries & Wages', 75927.12, 0),
  planLine('2140', 'PAYE Payable', 0, 19966.33),
  planLine('2150', 'UIF Payable', 0, 354.24),
  planLine('2160', 'SDL Payable', 0, 750),
  planLine('1110', 'Bank', 0, 41681.55),
  planLine('2175', 'Other Employee Deductions Payable', 0, 13175),
];

export function planBody(
  blocker: Note | null = null,
  opts: { plan?: Record<string, unknown>; posted?: Record<string, unknown> | null } = {},
) {
  return {
    blocker,
    planHash: PLAN_HASH,
    posted: opts.posted ?? null,
    plan: {
      runId: RUN_ID, status: 'calculated', periodMonth: 9, periodYear: 2026, employeeCount: 1,
      alreadyPostedJournalId: null, entryDate: '2026-09-30', description: 'Payroll run 2026-09', reference: 'PAY-2026-09',
      lines: PLAN_LINES,
      totalDebit: 75927.12, totalCredit: 75927.12,
      totals: { gross: 75000, paye: 19966.33, uif: 354.24, sdl: 750, eti: 0, etiUsed: 0, net: 41681.55, employerUif: 177.12, otherDeductions: 13175 },
      blockers: blocker ? [blocker] : [],
      advisories: [],
      ...opts.plan,
    },
  };
}

/** The journal a reopened run already carries, as the gate reads it back from the GL. */
export function postedJournal(journalEntryId: string) {
  return {
    journalEntryId, entryNumber: 'JE-000042', status: 'posted',
    lines: PLAN_LINES.map(({ glAccountId, accountCode, accountName, debit, credit }) => ({ glAccountId, accountCode, accountName, debit, credit })),
    totalDebit: 75927.12, totalCredit: 75927.12,
  };
}

export const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
export const fail = (status: number, message: string) =>
  new Response(JSON.stringify({ success: false, error: { code: status === 409 ? 'CONFLICT' : 'BAD_REQUEST', message } }), { status });
export const approvedResult = (journalEntryId: string) =>
  ok({ ...runBody({ status: 'approved' }), journalEntryId, advisories: [] });

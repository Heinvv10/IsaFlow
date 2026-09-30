/**
 * W3-01 (PAY-01, PAY-06, PAY-08, PAY-24): a calculated pay run can be
 * approved from its page, the confirmation shows the journal approval will
 * post, a refused approval says why and never claims success, and the run
 * links to the journal it posted.
 *
 * `fetch` is stubbed, not `apiFetch`: the real apiFetch/apiJson/assertOk run,
 * so a 4xx that apiFetch resolves on is proven to reach the operator.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('next/router', () => ({
  useRouter: () => ({ isReady: true, query: { id: '11111111-1111-4111-8111-111111111111' }, push: vi.fn() }),
}));

import PayrollRunDetailPage from '@/../pages/payroll/runs/[id]';
import PayrollRunsListPage from '@/../pages/payroll/runs/index';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const RUN_URL = `/api/payroll/runs/${RUN_ID}`;
const PLAN_URL = `/api/payroll/runs/${RUN_ID}/journal-plan`;
const APPROVE_URL = `/api/payroll/runs/${RUN_ID}/approve`;

type Warning = { code: string; severity: 'warning'; message: string; deepLink?: string };

function line(id: string, name: string, warnings: Warning[] = []) {
  return {
    id, runId: RUN_ID, employeeId: `e-${id}`, employeeNumber: `E00${id}`, employeeName: name,
    // Gross 75 000 − PAYE 19 966.33 − UIF 177.12 − net 41 681.55 = R13 175 of other deductions.
    grossPay: 75000, taxableIncome: 75000, paye: 19966.33, uifEmployee: 177.12, uifEmployer: 177.12,
    sdl: 750, eti: 0, netPay: 41681.55, validationResults: warnings,
  };
}

function runBody(overrides: Record<string, unknown> = {}) {
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

function planBody(blocker: { code: string; detail: string } | null = null) {
  return {
    blocker,
    plan: {
      runId: RUN_ID, status: 'calculated', periodMonth: 9, periodYear: 2026, employeeCount: 1,
      alreadyPostedJournalId: null, entryDate: '2026-09-30', description: 'Payroll run 2026-09', reference: 'PAY-2026-09',
      lines: [
        planLine('5200', 'Salaries & Wages', 75927.12, 0),
        planLine('2140', 'PAYE Payable', 0, 19966.33),
        planLine('2150', 'UIF Payable', 0, 354.24),
        planLine('2160', 'SDL Payable', 0, 750),
        planLine('1110', 'Bank', 0, 41681.55),
        planLine('2175', 'Other Employee Deductions Payable', 0, 13175),
      ],
      totalDebit: 75927.12, totalCredit: 75927.12,
      totals: { gross: 75000, paye: 19966.33, uif: 354.24, sdl: 750, eti: 0, etiUsed: 0, net: 41681.55, employerUif: 177.12, otherDeductions: 13175 },
      blockers: blocker ? [blocker] : [],
      advisories: [],
    },
  };
}

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const fail = (status: number, message: string) =>
  new Response(JSON.stringify({ success: false, error: { code: 'CONFLICT', message } }), { status });

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function approveCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url) === APPROVE_URL);
}

async function openApproveDialog() {
  render(<PayrollRunDetailPage />);
  fireEvent.click(await screen.findByRole('button', { name: /review & approve/i }));
  return screen.findByRole('dialog');
}

describe('payroll run page — approve (PAY-01)', () => {
  it('a calculated run offers Review & approve, shows the journal, and confirming POSTs /approve', async () => {
    let approved = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === APPROVE_URL && init?.method === 'POST') {
        approved = true;
        return ok({ ...runBody({ status: 'approved' }), journalEntryId: 'je-123', advisories: [] });
      }
      if (url === PLAN_URL) return ok(planBody());
      if (url === RUN_URL) return ok(runBody(approved ? { status: 'approved', journalEntryId: 'je-123' } : {}));
      throw new Error(`unexpected fetch ${url}`);
    });

    const dialog = await openApproveDialog();
    // The journal comes from the plan builder, line for line.
    expect(await within(dialog).findByText('Other Employee Deductions Payable')).toBeTruthy();
    expect(within(dialog).getAllByText(/75[\s ]927,12/).length).toBeGreaterThan(0);

    fireEvent.click(within(dialog).getByRole('button', { name: /approve and post journal/i }));

    await waitFor(() => expect(approveCalls()).toHaveLength(1));
    expect(approveCalls()[0]![1]).toMatchObject({ method: 'POST' });
    // PAY-24: the returned journal is linked.
    const link = await screen.findByRole('link', { name: /view journal/i });
    expect(link.getAttribute('href')).toBe('/accounting/journal-entries/je-123');
  });

  it('a refused approval (409) shows the server message and does not claim success', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === APPROVE_URL && init?.method === 'POST') return fail(409, 'Payroll run changed while you were reviewing it');
      if (url === PLAN_URL) return ok(planBody());
      if (url === RUN_URL) return ok(runBody());
      throw new Error(`unexpected fetch ${url}`);
    });

    const dialog = await openApproveDialog();
    await within(dialog).findByText('Other Employee Deductions Payable');
    fireEvent.click(within(dialog).getByRole('button', { name: /approve and post journal/i }));

    expect(await screen.findByText('Payroll run changed while you were reviewing it')).toBeTruthy();
    expect(approveCalls()).toHaveLength(1);
    expect(screen.queryByRole('link', { name: /view journal/i })).toBeNull();
    expect(screen.queryByText(/approved and journal posted/i)).toBeNull();
  });

  it('a plan blocker is shown and approval is not offered', async () => {
    const detail = "The fiscal period covering 2026-09-30 is 'closed', so the payroll journal cannot post into it.";
    fetchMock.mockImplementation(async (url: string) => {
      if (url === PLAN_URL) return ok(planBody({ code: 'closed_period', detail }));
      if (url === RUN_URL) return ok(runBody());
      throw new Error(`unexpected fetch ${url}`);
    });

    const dialog = await openApproveDialog();
    expect(await within(dialog).findByText(detail)).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: /approve and post journal/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(approveCalls()).toHaveLength(0);
  });

  it('a draft run has nothing to approve', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === RUN_URL) return ok(runBody({ status: 'draft', lines: [] }));
      throw new Error(`unexpected fetch ${url}`);
    });
    render(<PayrollRunDetailPage />);
    await screen.findByRole('button', { name: /^calculate$/i });
    expect(screen.queryByRole('button', { name: /review & approve/i })).toBeNull();
  });

  it('an approved run links the journal it posted (PAY-24)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === RUN_URL) return ok(runBody({ status: 'approved', journalEntryId: 'je-77' }));
      throw new Error(`unexpected fetch ${url}`);
    });
    render(<PayrollRunDetailPage />);
    const link = await screen.findByRole('link', { name: /view journal/i });
    expect(link.getAttribute('href')).toBe('/accounting/journal-entries/je-77');
  });
});

describe('payroll run page — explains its numbers (PAY-06)', () => {
  it('shows other deductions and splits UIF into employee and employer', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === RUN_URL) return ok(runBody());
      throw new Error(`unexpected fetch ${url}`);
    });
    render(<PayrollRunDetailPage />);
    await screen.findByText('Riaan Smit');
    expect(screen.getByText(/UIF \(employee\)/i)).toBeTruthy();
    expect(screen.getByText(/UIF \(employer\)/i)).toBeTruthy();
    // 75 000 − 19 966.33 − 177.12 − 41 681.55
    expect(screen.getAllByText(/13[\s ]175,00/).length).toBeGreaterThan(0);
    expect(screen.getByText(/^Totals$/i)).toBeTruthy();
  });
});

describe('payroll run page — grouped warnings (PAY-08)', () => {
  it('groups the same warning across employees and names every employee', async () => {
    const eti = (name: string, id: string): Warning => ({
      code: 'ETI_INDETERMINATE', severity: 'warning',
      message: `ETI eligibility could not be determined for ${name} — date of birth is missing. No Employment Tax Incentive has been claimed for this employee.`,
      deepLink: `/payroll/employees/${id}#date-of-birth`,
    });
    const payeZero: Warning = {
      code: 'PAYE_ZERO_ON_TAXABLE_INCOME', severity: 'warning',
      message: 'Employee has taxable income above the annual threshold but zero PAYE. Verify tax number and directive.',
    };
    fetchMock.mockImplementation(async (url: string) => {
      if (url === RUN_URL) {
        return ok(runBody({
          employeeCount: 2,
          lines: [line('1', 'Riaan Smit', [eti('Riaan Smit', 'e-1')]), line('2', 'Anika Botha', [eti('Anika Botha', 'e-2'), payeZero])],
        }));
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    render(<PayrollRunDetailPage />);
    const section = (await screen.findByRole('heading', { name: /warning/i })).closest('section')!;
    const s = within(section);
    // One ETI group, not one line per employee.
    expect(s.getAllByText(/ETI eligibility could not be determined/i)).toHaveLength(1);
    expect(s.getByText(/2 employees/i)).toBeTruthy();
    expect(s.getByRole('link', { name: 'Riaan Smit' }).getAttribute('href')).toBe('/payroll/employees/e-1#date-of-birth');
    // The zero-PAYE warning names its employee even though its message does not.
    const payeItem = s.getByText(/zero PAYE/i).closest('li')!;
    expect(within(payeItem).getByText('Anika Botha')).toBeTruthy();
  });
});

describe('payroll runs list — journal link (PAY-24)', () => {
  it('links a posted run to its journal', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/payroll/runs') {
        return ok([
          { ...runBody({ status: 'approved', journalEntryId: 'je-9' }), lines: undefined },
          { ...runBody({ id: 'r2', periodMonth: 10 }), lines: undefined },
        ]);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    render(<PayrollRunsListPage />);
    const links = await screen.findAllByRole('link', { name: /journal/i });
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('/accounting/journal-entries/je-9');
  });
});

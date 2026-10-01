/**
 * W3-01 (PAY-06, PAY-08, PAY-24): the run page explains its numbers, groups its
 * warnings, and the runs list links each posted run to its journal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, within } from '@testing-library/react';
import { RUN_ID, RUN_URL, line, runBody, ok, type Warning } from './payroll/payrollRunFixtures';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('next/router', () => ({
  useRouter: () => ({ isReady: true, query: { id: '11111111-1111-4111-8111-111111111111' }, push: vi.fn() }),
}));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'admin' }) }));

import PayrollRunDetailPage from '@/../pages/payroll/runs/[id]';
import PayrollRunsListPage from '@/../pages/payroll/runs/index';

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function serveRun(body: unknown) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === RUN_URL) return ok(body);
    throw new Error(`unexpected fetch ${url}`);
  });
}

const card = (label: string) => screen.getByText(label).parentElement!;

describe('payroll run page — explains its numbers (PAY-06)', () => {
  it('shows other deductions, a totals row, and UIF split into employee and employer', async () => {
    serveRun(runBody());
    render(<PayrollRunDetailPage />);
    await screen.findByText('Riaan Smit');
    expect(screen.getByText(/UIF \(employee\)/i)).toBeTruthy();
    expect(screen.getByText(/UIF \(employer\)/i)).toBeTruthy();
    // 75 000 − 19 966.33 − 177.12 − 41 681.55
    expect(screen.getAllByText(/13[\s ]175,00/).length).toBeGreaterThan(0);
    expect(screen.getByText(/^Totals$/i)).toBeTruthy();
  });

  // Review round 1, item 5: the cards show what the journal books. The journal
  // splits the header's combined UIF in half, so when the lines' employee and
  // employer UIF differ by a cent the cards follow the journal's 2175 figure.
  it('the stat cards carry the journal split, not the line sums, when the UIF halves differ', async () => {
    serveRun(runBody({ totalUif: 354.25, lines: [line('1', 'Riaan Smit', [], { uifEmployee: 177.12, uifEmployer: 177.13 })] }));
    render(<PayrollRunDetailPage />);
    await screen.findByText('Riaan Smit');
    // round2(354.25 / 2) = 177.13; 75 000 − 19 966.33 − 177.13 − 41 681.55 = 13 174.99 (the 2175 credit)
    expect(card('Other deductions').textContent).toMatch(/13[\s ]174,99/);
    expect(card('UIF (employee)').textContent).toMatch(/177,13/);
    expect(card('UIF (employer)').textContent).toMatch(/177,12/);
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
    serveRun(runBody({
      employeeCount: 2,
      lines: [line('1', 'Riaan Smit', [eti('Riaan Smit', 'e-1')]), line('2', 'Anika Botha', [eti('Anika Botha', 'e-2'), payeZero])],
    }));
    render(<PayrollRunDetailPage />);
    const section = (await screen.findByRole('heading', { name: /warning/i })).closest('section')!;
    const s = within(section);
    expect(s.getAllByText(/ETI eligibility could not be determined/i)).toHaveLength(1);
    expect(s.getByText(/2 employees/i)).toBeTruthy();
    expect(s.getByRole('link', { name: 'Riaan Smit' }).getAttribute('href')).toBe('/payroll/employees/e-1#date-of-birth');
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
          { ...runBody({ id: `${RUN_ID}-2`, periodMonth: 10 }), lines: undefined },
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

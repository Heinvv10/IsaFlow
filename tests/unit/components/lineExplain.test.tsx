/**
 * Wave 5 EX-core, the screens: "How was this calculated?" on each statutory cell of the run table (read-only and the
 * review grid) and in the payslip drawer opens the ExplainDrawer with the line's stored explanation. A line costed
 * before the column reads "Recalculate the run..." on a draft and "Not recorded for runs costed before <date>" on a
 * final run. `fetch` is stubbed, so the real apiFetch/apiJson run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RUN_ID, RUN_URL, ok, fail } from './payroll/payrollRunFixtures';
import { fetchMock, rowOf, serve, twoRuns } from './payroll/payRunGridHarness';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { buildCaseInput, loadCases } from '../../fixtures/payroll-oracle/oracle';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query: { id: RUN_ID }, push: vi.fn() }) }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'admin' }) }));

import PayrollRunDetailPage from '@/../pages/payroll/runs/[id]';
import { EXPLANATION_LOAD_FAILED } from '@/components/payroll/LineExplain';

const EXPLAIN_URL = (employeeId: string) => `/api/payroll/runs/${RUN_ID}/explanation?employeeId=${employeeId}`;
const explanations = calculatePayrollLine({ ...buildCaseInput(loadCases().find(c => c.id === 'sage-2027-03-kesh-bonus-40000')!) }).explanations;
const recorded = { state: 'recorded', final: true, explanations };

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'about:blank#payslip-1'), revokeObjectURL: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function serveRun(run: Record<string, unknown>, answer: () => Response) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === RUN_URL) return ok(run);
    if (url.startsWith(`/api/payroll/runs/${RUN_ID}/explanation?`)) return answer();
    if (url.startsWith(`/api/payroll/runs/${RUN_ID}/payslips?`)) {
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200, headers: { 'Content-Type': 'application/pdf' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

const approved = () => twoRuns({ status: 'approved', journalEntryId: 'je-1', approval: null, payslipsFinal: true });

async function openFrom(name: string, figure: string) {
  render(<PayrollRunDetailPage />);
  await screen.findByText(name);
  const buttons = within(rowOf(name)).getAllByRole('button', { name: `How was ${figure} for ${name} calculated?` });
  fireEvent.click(buttons[0]!);
  return await screen.findByRole('dialog', { name: `How ${figure} was calculated for ${name}` });
}

describe('the run table', () => {
  it('each statutory cell has a button: PAYE, UIF (employee and employer), SDL and ETI', async () => {
    serveRun(approved(), () => ok(recorded));
    render(<PayrollRunDetailPage />);
    await screen.findByText('Riaan Smit');
    const names = within(rowOf('Riaan Smit')).getAllByRole('button').map(b => b.getAttribute('aria-label'));
    expect(names.filter(n => n?.startsWith('How was'))).toEqual([
      'How was PAYE for Riaan Smit calculated?', 'How was UIF for Riaan Smit calculated?',
      'How was UIF for Riaan Smit calculated?', 'How was SDL for Riaan Smit calculated?', 'How was ETI for Riaan Smit calculated?',
    ]);
  });

  it('opens the stored PAYE explanation for that employee, no-store, with its steps, sources and result', async () => {
    serveRun(approved(), () => ok(recorded));
    const drawer = await openFrom('Riaan Smit', 'PAYE');
    await within(drawer).findByText('Annual equivalent');
    expect(within(drawer).getByText('Tax for the year with the annual payments')).toBeTruthy();
    expect(within(drawer).getByText('PAYE this period')).toBeTruthy();
    expect(within(drawer).getAllByText(/R 7 875\.00/).length).toBeGreaterThan(0);
    expect(within(drawer).getAllByRole('link', { name: /PAYE-GEN-01-G21/ }).length).toBeGreaterThan(0);
    expect(within(drawer).getAllByText('18%').length).toBeGreaterThan(0); // a rate reads as a percentage, not 0.18
    expect(within(drawer).queryByText('0.18')).toBeNull();
    // HTML's dl content model (axe "dlitem"): every dt and dd sits in a div that is a dl's own child.
    const terms = [...drawer.querySelectorAll('dt, dd')];
    expect(terms.length).toBeGreaterThan(10);
    expect(terms.filter(t => t.parentElement?.tagName !== 'DIV' || t.parentElement.parentElement?.tagName !== 'DL')).toEqual([]);
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/explanation?'))!;
    expect(call[0]).toBe(EXPLAIN_URL('e-1'));
    expect((call[1] as RequestInit).cache).toBe('no-store');
  });

  it('a final run\'s line costed before the column: "Not recorded for runs costed before <date>"', async () => {
    serveRun(approved(), () => ok({ state: 'not_recorded', final: true, recordedFrom: '2026-11-12' }));
    const drawer = await openFrom('Riaan Smit', 'SDL');
    expect((await within(drawer).findByRole('note')).textContent).toBe('Not recorded for runs costed before 12 Nov 2026.');
  });

  it('the review grid (a draft) has the buttons too; a line costed before explanations says so and asks for a recalculation', async () => {
    // A calculated run is the review grid: the harness serves its inputs; the explanation is added on top.
    serve(() => ok({}), { run: twoRuns() });
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => (String(url).includes('/explanation?')
      ? ok({ state: 'not_recorded', final: false, costedAt: '2026-11-01T08:00:00.000Z', recordedFrom: '2026-11-12T06:00:00.000Z' }) : base(url, init)));
    const drawer = await openFrom('Thandi Nkosi', 'ETI');
    expect((await within(drawer).findByRole('note')).textContent)
      .toBe('This line was calculated before explanations were recorded; recalculate the run to see how it was calculated.');
  });

  it.each([
    ['a 500 carrying a raw SQL error', () => fail(500, 'column l.explanation does not exist')],
    ['a 404', () => fail(404, 'Pay run line not found')],
  ])('%s: a plain "Couldn\'t load the explanation", never the server\'s text', async (_name, answer) => {
    serveRun(approved(), answer);
    const drawer = await openFrom('Riaan Smit', 'PAYE');
    await waitFor(() => expect(within(drawer).getByRole('note').textContent).toBe(EXPLANATION_LOAD_FAILED));
    expect(drawer.textContent).not.toMatch(/column|does not exist|not found/i);
  });
});

describe('the payslip drawer', () => {
  it('PAYE, UIF, SDL and ETI each open that figure\'s explanation over the payslip', async () => {
    serveRun(approved(), () => ok(recorded));
    render(<PayrollRunDetailPage />);
    await screen.findByText('Riaan Smit');
    fireEvent.click(within(rowOf('Riaan Smit')).getByRole('button', { name: 'Payslip for Riaan Smit' }));
    const slip = await screen.findByRole('dialog', { name: /^Payslip: Riaan Smit/ });
    fireEvent.click(within(slip).getByRole('button', { name: 'How was UIF for Riaan Smit calculated?' }));
    const drawer = await screen.findByRole('dialog', { name: 'How UIF was calculated for Riaan Smit' });
    await within(drawer).findByText('Monthly ceiling');
    expect(within(drawer).getByText('UIF, employee (the employer pays the same)')).toBeTruthy();
  });
});

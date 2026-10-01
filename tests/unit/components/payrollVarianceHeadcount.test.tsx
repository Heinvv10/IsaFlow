/**
 * W3-01 (PAY-09): the variance page rendered the employee headcount through
 * formatCurrency ("R 10,00", "prior R 10,00"), and compared a run with a prior
 * run years earlier without saying so.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('next/router', () => ({
  useRouter: () => ({ isReady: true, query: { id: 'run-1' }, push: vi.fn() }),
}));

import PayrollRunVariancePage from '@/../pages/payroll/runs/[id]/variance';

const zero = { current: 0, prior: 0, diff: 0, pct: 0 };

function variance(current: { month: number; year: number }, prior: { month: number; year: number }) {
  return {
    runId: 'run-1', priorRunId: 'run-0', currentPeriod: current, priorPeriod: prior,
    totals: {
      grossPay: zero, paye: zero, uif: zero, sdl: zero, netPay: zero,
      employeeCount: { current: 10, prior: 8, diff: 2, pct: 0.25 },
    },
    employees: [],
  };
}

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function serve(body: unknown) {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: true, data: body }), { status: 200 }));
}

describe('payroll variance page', () => {
  it('renders the headcount as a count, not as Rand', async () => {
    serve(variance({ month: 1, year: 2027 }, { month: 12, year: 2026 }));
    render(<PayrollRunVariancePage />);
    const card = (await screen.findByText('Employees')).parentElement!;
    expect(card.textContent).not.toMatch(/R/);
    expect(card.textContent).toContain('10');
    expect(card.textContent).toContain('prior 8');
    expect(card.textContent).toContain('+2');
  });

  it('warns when the prior run is not the previous month', async () => {
    serve(variance({ month: 1, year: 2031 }, { month: 12, year: 2026 }));
    render(<PayrollRunVariancePage />);
    expect(await screen.findByText(/not the previous month/i)).toBeTruthy();
  });

  it('does not warn when the prior run is the previous month across a year end', async () => {
    serve(variance({ month: 1, year: 2027 }, { month: 12, year: 2026 }));
    render(<PayrollRunVariancePage />);
    await screen.findByText('Employees');
    expect(screen.queryByText(/not the previous month/i)).toBeNull();
  });
});

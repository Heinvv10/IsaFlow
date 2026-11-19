/**
 * Wave 6 FQd, review #1622 L-K: the EMP501 page asks for the reconciliation of one period. Interim while the tax year is
 * running, annual after; an annual blocked by weekly or fortnightly runs is said plainly, naming the run, with a way to
 * the interim, never "Could not load".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/payroll/emp501/Emp501ReturnSection', () => ({ Emp501ReturnSection: () => null }));

import Emp501Page from '@/../pages/payroll/emp501/index';
import { defaultEmp501Kind } from '@/components/payroll/emp501/emp501Kind';

const WHY = 'tax year 2027 has 1 approved weekly or fortnightly run (the first: the weekly run for 7–13 Sep 2026), and IRP5 and '
  + 'EMP501 certificates cover monthly runs only in this release';
const row = (month: number, year: number) => ({ month, year, monthLabel: `M${month} ${year}`, emp201Paye: 100, irp5Paye: 100, variance: 0, status: 'balanced' });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fetchMock = vi.fn();
const urls = () => fetchMock.mock.calls.map(([u]) => String(u));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-19T10:00:00'));
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(async (url: string) => (String(url).includes('period=annual')
    ? json({ success: false, error: { code: 'CONFLICT', message: `This pay run cannot be certified on IRP5s by this version of IsaFlow: ${WHY}.`,
      details: { code: 'RUN_KIND_UNSUPPORTED', action: 'irp5', reasons: [{ clause: 'frequency', detail: WHY }] } } }, 409)
    : json({ success: true, data: { taxYear: 2027, rows: [row(3, 2026), row(4, 2026)], totalEmp201: 200, totalIrp5: 200, totalVariance: 0, runWarnings: [] } })));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('defaultEmp501Kind', () => {
  it('interim while the tax year runs (to the end of February), annual after', () => {
    expect(defaultEmp501Kind(2027, new Date('2026-11-19T10:00:00'))).toBe('interim');
    expect(defaultEmp501Kind(2026, new Date('2026-02-28T18:00:00'))).toBe('interim');
    expect(defaultEmp501Kind(2026, new Date('2026-03-01T08:00:00'))).toBe('annual');
  });
});

describe('the EMP501 page', () => {
  it('opens on the running year\'s interim and shows its months', async () => {
    render(<Emp501Page />);
    expect(await screen.findByText('M3 2026')).toBeTruthy();
    expect(urls()[0]).toContain('/api/payroll/emp501/reconciliation?taxYear=2027&period=interim');
    expect((screen.getByLabelText('Reconciliation period') as HTMLSelectElement).value).toBe('interim');
  });

  it('an annual blocked by weekly runs says so plainly, names the run, and leads to the interim', async () => {
    render(<Emp501Page />);
    await screen.findByText('M3 2026');
    fireEvent.change(screen.getByLabelText('Reconciliation period'), { target: { value: 'annual' } });
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('The annual EMP501 for 2026/2027 is blocked by weekly or fortnightly pay runs');
    expect(banner.textContent).toContain('the weekly run for 7–13 Sep 2026');
    expect(screen.queryByText(/Could not load/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show the interim' }));
    await waitFor(() => expect(screen.getByText('M3 2026')).toBeTruthy());
    expect(urls().at(-1)).toContain('period=interim');
  });
});

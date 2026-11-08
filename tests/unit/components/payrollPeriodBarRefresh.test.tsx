/** The period strip reads again when the run page reports a status change, so it does not stay on "Calculated" after approval. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';

vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));

import { PayrollPeriodBar } from '@/components/payroll/PayrollPeriodBar';
import { announcePayrollRunChanged } from '@/components/payroll/payrollRunEvents';

let status = 'calculated';
const fetchMock = vi.fn();
beforeEach(() => {
  status = 'calculated';
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: true, data: {
    companyName: 'Co', periodMonth: 9, periodYear: 2026, periodNumber: 7, periodsInTaxYear: 12, runId: 'r1', status, taxYearStartMonth: 3,
  } }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('PayrollPeriodBar', () => {
  it('shows the new status after the run page announces a change', async () => {
    render(<PayrollPeriodBar />);
    expect(await screen.findByText('Calculated')).toBeTruthy();
    status = 'approved';
    await act(async () => { announcePayrollRunChanged(); });
    expect(await screen.findByText('Approved')).toBeTruthy();
    expect(screen.queryByText('Calculated')).toBeNull();
  });
});

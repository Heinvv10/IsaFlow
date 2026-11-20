/**
 * Wave 6 FQd (review #1622 UI r2 L1): a calculate refused for a pay-frequency change shows the sentence once, in the
 * run page's card; the banner only points to it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RUN_ID, RUN_URL, runBody, ok } from './payroll/payrollRunFixtures';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query: { id: '11111111-1111-4111-8111-111111111111' }, push: vi.fn() }) }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'admin' }) }));

import PayrollRunDetailPage from '@/../pages/payroll/runs/[id]';
import { STRADDLE_POINTER } from '@/components/payroll/useRunDetail';

const SAYS = 'Sam Straddle was last paid weekly up to 1 Mar 2026, and this monthly run starts on 1 Mar 2026: 1 Mar 2026 would be paid '
  + 'twice. Settle that day with a once-off adjustment, then acknowledge the change on this run (an owner or admin).';
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === `${RUN_URL}/frequency-change`) {
      return ok({ straddles: [{ employeeId: 'e1', employeeName: 'Sam Straddle', kind: 'straddle', acknowledged: false, message: SAYS }] });
    }
    if (url === `${RUN_URL}/calculate` && init?.method === 'POST') {
      return new Response(JSON.stringify({ success: false, error: { code: 'CONFLICT', message: SAYS, details: { code: 'FREQUENCY_CHANGE_STRADDLE' } } }), { status: 409 });
    }
    if (url === RUN_URL) return ok(runBody({ id: RUN_ID, status: 'draft', lines: [] }));
    return ok({});
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('a calculate refused for a pay-frequency change', () => {
  it('shows the sentence once, in the card, and the banner points to it', async () => {
    render(<PayrollRunDetailPage />);
    expect(await screen.findByText(SAYS)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Calculate' }));
    expect(await screen.findByText(STRADDLE_POINTER)).toBeTruthy();
    expect(screen.getAllByText(SAYS)).toHaveLength(1);
  });
});

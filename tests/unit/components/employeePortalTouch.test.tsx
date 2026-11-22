// Employee portal home (phone-first audience): Sign out and every Download PDF link are 44px tap targets on phones.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/router', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn(), query: {}, asPath: '/', isReady: true }) }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('@/components/employeePortal/portalFetch', () => ({
  PortalCallError: class extends Error { status = 0; },
  portalCall: vi.fn(async (url: string) => {
    if (url.endsWith('/me')) return { employeeName: 'Thandi', employeeNumber: 'E1', employer: 'Acme' };
    if (url.endsWith('/payslips')) return [{ runId: 'r1', periodYear: 2026, periodMonth: 10, runDate: null, netPay: 100 }];
    if (url.endsWith('/leave')) return [{ leaveType: 'Annual', year: 2026, accrued: 15, taken: 5, pending: 0, balance: 10 }];
    return { payFrequency: 'monthly', certificates: [{ versionId: 'v1', taxYear: 2026, kind: 'annual', filedAt: null, certificateNumber: 'IRP5-1', income: [], deductions: [], tax: [] }] };
  }),
}));

import Page from '../../../pages/employee-portal/index';

afterEach(cleanup);
const TAP = ['max-lg:inline-flex', 'max-lg:items-center', 'max-lg:min-h-11'];

describe('Employee portal on touch', () => {
  it('makes Sign out 44px on phones', async () => {
    render(<Page />);
    await screen.findByText('Payslips');
    expect(screen.getByRole('button', { name: 'Sign out' }).className.split(' ')).toContain('max-lg:h-11');
  });

  it('makes the payslip Download PDF links 44px tap targets', async () => {
    render(<Page />);
    const link = await screen.findByRole('link', { name: /Download PDF for October 2026/ });
    for (const c of TAP) expect(link.className.split(' '), c).toContain(c);
  });

  it('makes the IRP5 Download PDF link 44px too', async () => {
    render(<Page />);
    const link = await screen.findByRole('link', { name: /IRP5 copy for tax year 2026/ });
    for (const c of TAP) expect(link.className.split(' '), c).toContain(c);
  });
});

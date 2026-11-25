// Employee portal home (phone-first audience): Sign out and every Download PDF link are 44px tap targets on phones.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// One stable router object: the page's effects depend on it, so a fresh object per render would refetch in a loop.
const router = vi.hoisted(() => ({ replace: () => undefined, push: () => undefined, query: {}, asPath: '/', isReady: true }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('@/components/employeePortal/portalFetch', () => ({
  PortalCallError: class extends Error { status = 0; },
  portalCall: vi.fn(async (url: string) => {
    if (url.endsWith('/me')) return { employeeName: 'Thandi', employeeNumber: 'E1', employer: 'Acme' };
    if (url.endsWith('/payslips')) return [{ runId: 'r1', periodYear: 2026, periodMonth: 10, runDate: null, netPay: 100 }];
    if (url.endsWith('/leave')) return [{ leaveType: 'Annual', year: 2026, accrued: 15, taken: 5, pending: 0, balance: 10 }];
    return { payFrequency: 'monthly', certificates: [{ versionId: 'v1', taxYear: 2026, kind: 'annual', filedAt: null, certificateNumber: 'IRP5-1', income: [{ code: '3601', label: 'Salary', amount: 100 }], deductions: [], tax: [] }] };
  }),
}));

import Page from '../../../pages/employee-portal/index';

afterEach(cleanup);
const TAP = ['max-lg:inline-flex', 'max-lg:items-center', 'max-lg:min-h-11'];

describe('Employee portal on touch', () => {
  it('makes Sign out 44px on phones', async () => {
    render(<Page />);
    await screen.findByText('Payslips');
    const cls = screen.getByRole('button', { name: 'Sign out' }).className.split(' ');
    expect(cls).toContain('max-lg:h-11');
    expect(cls).toContain('h-8'); // desktop keeps its height: the 44px is phone-only
  });

  it('makes the payslip Download PDF links 44px tap targets', async () => {
    render(<Page />);
    const link = await screen.findByRole('link', { name: /Download PDF for October 2026/ });
    for (const c of TAP) expect(link.className.split(' '), c).toContain(c);
    expect(link.className.split(' ')).toContain('underline');
  });

  it('makes the IRP5 Download PDF link 44px too', async () => {
    render(<Page />);
    const link = await screen.findByRole('link', { name: /IRP5 copy for tax year 2026/ });
    for (const c of TAP) expect(link.className.split(' '), c).toContain(c);
  });

  it('lets a long IRP5 lines table scroll inside its card on a 320px phone instead of crossing the border', async () => {
    render(<Page />);
    await screen.findByRole('link', { name: /IRP5 copy for tax year 2026/ });
    const wrap = screen.getByTestId('irp5-lines-scroll');
    expect(wrap.className.split(' ')).toContain('max-lg:overflow-x-auto');
    expect(wrap.querySelector('table')).not.toBeNull();
  });
});

// The FAR report and EEA2: both are wide matrices that stay horizontally scrollable by design; their small controls (FAR's error Retry, EEA2's Refresh) are 44px on phones.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ page: 'far' as 'far' | 'eea2', fail: false }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => {
    if (state.fail) return new Response(JSON.stringify({ success: false, error: { message: 'boom' } }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    const data = { asOf: '2026-11-23', levels: [], totals: { grandTotal: 0, disabilityCount: 0, foreignCount: 0 } };
    return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }),
}));

import FarPage from '../../../pages/accounting/assets/far-report';
import Eea2Page from '../../../pages/payroll/equity/eea2';

afterEach(() => { cleanup(); state.fail = false; });
const cls = (el: Element) => el.className.split(' ');

describe('Wide report pages on touch', () => {
  it('FAR report: the error Retry button is 44px', async () => {
    state.fail = true;
    render(<FarPage />);
    expect(cls(await screen.findByRole('button', { name: 'Retry' }))).toEqual(expect.arrayContaining(['max-lg:min-h-11', 'max-lg:inline-flex', 'max-lg:items-center']));
  });

  it('EEA2: Refresh is 44px and its row wraps', async () => {
    render(<Eea2Page />);
    const btn = await screen.findByRole('button', { name: 'Refresh' });
    expect(cls(btn)).toContain('max-lg:min-h-11');
    expect(cls(btn.parentElement!)).toContain('max-lg:flex-wrap');
  });
});

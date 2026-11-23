// Loan rate curves: the header, new-curve form and Upload CSV control are phone-sized and wrap (the two-column points table already fits).
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async (url: string) => new Response(JSON.stringify({ success: true, data: String(url).includes('/points') ? [{ effectiveDate: '2026-01-01', rate: 11.75 }] : [{ id: 'c1', name: 'SA Prime', pointCount: 1 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/loans/rate-curves';

afterEach(cleanup);
const cls = (el: Element) => el.className.split(' ');

describe('Loan rate curves on touch', () => {
  it('New Curve is 44px and the header wraps', async () => {
    render(<Page />);
    const btn = await screen.findByRole('button', { name: /New Curve/ });
    expect(cls(btn)).toContain('max-lg:min-h-11');
    expect(cls(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });

  it('the new-curve form wraps, with a flexible 44px name box and 44px Create and Cancel', async () => {
    render(<Page />);
    fireEvent.click(await screen.findByRole('button', { name: /New Curve/ }));
    const input = screen.getByPlaceholderText(/Curve name/);
    expect(cls(input)).toEqual(expect.arrayContaining(['max-lg:min-h-11', 'max-lg:flex-1', 'max-lg:min-w-0']));
    expect(cls(input.parentElement!)).toContain('max-lg:flex-wrap');
    for (const name of ['Create', 'Cancel']) expect(cls(screen.getByRole('button', { name })), name).toEqual(expect.arrayContaining(['max-lg:min-h-11', 'max-lg:inline-flex', 'max-lg:items-center']));
  });

  it('an expanded curve: the Upload CSV label is 44px and its row wraps', async () => {
    render(<Page />);
    fireEvent.click(await screen.findByRole('button', { name: /SA Prime/ }));
    const label = (await screen.findByText('Upload CSV')).closest('label')!;
    expect(cls(label)).toContain('max-lg:min-h-11');
    expect(cls(label.parentElement!)).toContain('max-lg:flex-wrap');
  });
});

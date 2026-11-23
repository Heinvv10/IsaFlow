// New loan form: every field, the skip-month toggles, Cancel, Create Loan and the Back link are phone-sized; the header wraps.
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), back: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: [{ id: 'c1', name: 'SA Prime' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/loans/new';

afterEach(cleanup);
const cls = (el: Element) => el.className.split(' ');
const MIN = 'max-lg:min-h-11';

describe('New loan form on touch', () => {
  it('every text field, number field and select is 44px (fixed-rate mode)', () => {
    const { container } = render(<Page />);
    const fields = [...container.querySelectorAll('form input:not([type="checkbox"]), form select')].filter((e) => !e.closest('[data-datefield]'));
    expect(fields.length).toBeGreaterThanOrEqual(10);
    const missing = fields.filter((f) => !cls(f).includes(MIN)).map((f) => f.getAttribute('placeholder') ?? f.tagName);
    // the shared DateField input carries its own max-lg:min-h-11, so it passes too
    expect(missing).toEqual([]);
  });

  it('prime mode reveals the margin, rate-curve and reprice fields, also 44px', async () => {
    const { container } = render(<Page />);
    const mode = [...container.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'PRIME_PLUS'))!;
    fireEvent.change(mode, { target: { value: 'PRIME_PLUS' } });
    expect(screen.getByPlaceholderText('2.0')).toBeTruthy();
    const missing = [...container.querySelectorAll('form input:not([type="checkbox"]), form select')].filter((f) => !cls(f).includes(MIN)).map((f) => f.getAttribute('placeholder') ?? f.tagName);
    expect(missing).toEqual([]);
  });

  it('the twelve skip-month toggles are 44px squares and wrap', () => {
    render(<Page />);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m) => screen.getByRole('button', { name: m }));
    for (const b of months) expect(cls(b), b.textContent ?? '').toEqual(expect.arrayContaining([MIN, 'max-lg:min-w-11', 'max-lg:inline-flex', 'max-lg:items-center', 'max-lg:justify-center']));
    expect(cls(months[0].parentElement!)).toContain('flex-wrap');
  });

  it('Back, Cancel and Create Loan are phone-sized; the header wraps', () => {
    const { container } = render(<Page />);
    const back = container.querySelector('a[href="/accounting/loans"]')!;
    expect(cls(back)).toEqual(expect.arrayContaining([MIN, 'max-lg:min-w-11', 'max-lg:inline-flex', 'max-lg:items-center', 'max-lg:justify-center']));
    expect(cls(screen.getByRole('link', { name: 'Cancel' }))).toEqual(expect.arrayContaining([MIN, 'max-lg:inline-flex', 'max-lg:items-center']));
    expect(cls(screen.getByRole('button', { name: 'Create Loan' }))).toContain(MIN);
    expect(cls(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });
});

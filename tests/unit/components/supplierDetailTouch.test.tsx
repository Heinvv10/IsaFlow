// Supplier detail header and record navigation: 44px phone targets, desktop sizing untouched.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({ default: ({ children, href, className }: { children: ReactNode; href: string; className?: string }) => <a href={href} className={className}>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query: { supplierId: 's1' }, push: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/suppliers/ContactsTab', () => ({ ContactsTab: () => null }));
vi.mock('@/components/accounting/suppliers/ActivityTab', () => ({ ActivityTab: () => null }));
vi.mock('@/components/accounting/suppliers/DrcFlagToggle', () => ({ DrcFlagToggle: () => null }));
vi.mock('@/components/accounting/suppliers/SupplierBankDetailsPanel', () => ({ SupplierBankDetailsPanel: () => null }));
vi.mock('@/components/accounting/entity-history/EntityHistoryTimeline', () => ({ EntityHistoryTimeline: () => null }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes('record-adjacent')
    ? { success: true, data: { prevId: 'p', nextId: 'n' } }
    : { success: true, data: { id: 's1', name: 'Acme', is_active: true, subject_to_drc_vat: false, created_at: '2026-01-01' } }), { status: 200 })),
}));

import SupplierDetailPage from '../../../pages/accounting/suppliers/[supplierId]';

afterEach(cleanup);
const has = (el: HTMLElement, c: string) => el.className.split(/\s+/).includes(c);

describe('supplier detail on touch', () => {
  it('gives the header links, buttons and tabs a 44px phone target', async () => {
    render(<SupplierDetailPage />);
    await screen.findByRole('heading', { name: 'Acme' });
    for (const el of [
      screen.getByRole('link', { name: /Back to Suppliers/ }), screen.getByRole('link', { name: /Edit/ }),
      screen.getByRole('button', { name: /Delete supplier/ }), screen.getByRole('button', { name: 'Overview' }),
      screen.getByRole('button', { name: 'Previous record' }), screen.getByRole('button', { name: 'Next record' }),
    ]) expect(has(el, 'max-lg:min-h-11'), el.textContent ?? '').toBe(true);
  });

  it('keeps desktop sizing: the phone height is the only new sizing class', async () => {
    render(<SupplierDetailPage />);
    await screen.findByRole('heading', { name: 'Acme' });
    const prev = screen.getByRole('button', { name: 'Previous record' });
    expect(has(prev, 'py-1.5')).toBe(true);
    expect(prev.className.split(/\s+/).filter(c => /^(lg:|min-h-)/.test(c))).toEqual([]);
  });
});

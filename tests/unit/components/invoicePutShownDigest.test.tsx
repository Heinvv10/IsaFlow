/**
 * PR S round twelve: each draft PUT sends the shown digest the page last had (`expectedShownDigest`): the one the load
 * carried (`shown_digest`), then each save's reply (`shownDigest`). The server refuses an edit made from a read that
 * another tab has since moved (409 STALE_VIEW); the body autosave compares stays the same body (the digest is added
 * as it is sent, so a new digest is never itself a change to save).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, bodyOf, DRAFT, ok, puts, routerEvents, serveInvoice, type } from '../helpers/invoiceAutosaveHarness';

const h = vi.hoisted(() => ({ events: null as null | ReturnType<typeof import('../helpers/invoiceAutosaveHarness').routerEvents> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/', isReady: true, events: h.events }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/customer-invoices/InvoicePdfPreview', () => ({ InvoicePdfPreview: () => null }));

import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';

useApiJsonOverMock();
beforeEach(() => { vi.useFakeTimers(); h.events = routerEvents(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.mocked(apiFetch).mockReset(); });

describe('a draft PUT carries the shown digest it was edited from', () => {
  it('the load\'s, then each reply\'s; a new digest alone is no change to save', async () => {
    let n = 0;
    serveInvoice((u, init) => (u.includes('customer-invoices-detail') && init?.method === 'PUT' ? ok({ updated: true, shownDigest: `after-${++n}` }) : undefined),
      { ...DRAFT, shown_digest: 'loaded' });
    render(<EditPage />);
    for (let i = 0; i < 8; i++) await advance(0);
    type(screen.getByLabelText('Notes'), 'One');
    await advance(1_500);
    type(screen.getByLabelText('Notes'), 'Two');
    await advance(1_500);
    expect(puts().map((c) => bodyOf(c).expectedShownDigest)).toEqual(['loaded', 'after-1']);
    await advance(5_000);
    expect(puts()).toHaveLength(2);
  });
});

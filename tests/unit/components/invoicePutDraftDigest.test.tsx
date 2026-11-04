/**
 * PR S rounds twelve and fifteen: each draft PUT sends the draft digest the page last had (`expectedDraftDigest`: the
 * invoice row and its lines only): the one the load carried (`draft_digest`), then each save's reply (`draftDigest`). The server refuses an edit made from a read that
 * another tab has since moved (409 STALE_VIEW); the body autosave compares stays the same body (the digest is added
 * as it is sent, so a new digest is never itself a change to save).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, bodyOf, calls, DRAFT, json, ok, puts, refused, routerEvents, serveInvoice, type } from '../helpers/invoiceAutosaveHarness';

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

describe('a draft PUT carries the draft digest it was edited from', () => {
  it('the load\'s, then each reply\'s; a new digest alone is no change to save', async () => {
    let n = 0;
    serveInvoice((u, init) => (u.includes('customer-invoices-detail') && init?.method === 'PUT' ? ok({ updated: true, shownDigest: `after-${++n}`, draftDigest: `draft-after-${n}` }) : undefined),
      { ...DRAFT, shown_digest: 'loaded', draft_digest: 'draft-loaded' });
    render(<EditPage />);
    for (let i = 0; i < 8; i++) await advance(0);
    type(screen.getByLabelText('Notes'), 'One');
    await advance(1_500);
    type(screen.getByLabelText('Notes'), 'Two');
    await advance(1_500);
    expect(puts().map((c) => bodyOf(c).expectedDraftDigest)).toEqual(['draft-loaded', 'draft-after-1']);
    await advance(5_000);
    expect(puts()).toHaveLength(2);
  });
});

describe('an autosave refused 409 STALE_VIEW (saved elsewhere since this page read it)', () => {
  it('reloads in place and says why: nothing is typed onto the stale view, and nothing is sent again', async () => {
    let gets = 0;
    serveInvoice((u, init) => {
      if (u.includes('customer-invoices-detail') && init?.method === 'PUT') return refused(409, 'Changed elsewhere: reload', { reason: 'STALE_VIEW' });
      if (u.includes('customer-invoices-detail?id=') && ++gets > 1) return ok({ ...DRAFT, notes: 'Saved in the other tab', shown_digest: 'theirs', draft_digest: 'theirs-draft' });
      return undefined;
    }, { ...DRAFT, shown_digest: 'mine', draft_digest: 'mine-draft' });
    render(<EditPage />);
    for (let i = 0; i < 8; i++) await advance(0);
    type(screen.getByLabelText('Notes'), 'Typed here');
    await advance(1_500);
    for (let i = 0; i < 8; i++) await advance(0);
    expect(puts()).toHaveLength(1);
    expect(calls('customer-invoices-detail?id=', 'GET').length).toBe(2); // reloaded
    expect((screen.getByLabelText('Notes') as HTMLTextAreaElement).value).toBe('Saved in the other tab');
    expect(screen.getByText('Changed elsewhere: reload')).toBeTruthy();
    await advance(5_000);
    expect(puts()).toHaveLength(1);
  });
});

describe('an autosave refused 409 for another reason', () => {
  it('does not reload: the refusal is shown and what was typed stays', async () => {
    serveInvoice((u, init) => (u.includes('customer-invoices-detail') && init?.method === 'PUT'
      ? json(409, { success: false, error: { code: 'CONFLICT', message: 'Reload the page and save again', details: { code: 'INVOICE_WIP_CLIENT_STALE' } } })
      : undefined));
    render(<EditPage />);
    for (let i = 0; i < 8; i++) await advance(0);
    type(screen.getByLabelText('Notes'), 'Typed here');
    await advance(1_500);
    for (let i = 0; i < 8; i++) await advance(0);
    expect(calls('customer-invoices-detail?id=', 'GET').length).toBe(1); // not reloaded
    expect((screen.getByLabelText('Notes') as HTMLTextAreaElement).value).toBe('Typed here');
    expect(screen.getAllByText(/Reload the page and save again/).length).toBeGreaterThan(0);
  });
});

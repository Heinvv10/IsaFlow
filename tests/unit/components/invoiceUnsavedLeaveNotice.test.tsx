/**
 * PR S, after the codex fixer's 168d90e1b4: a change sent as the edit page leaves (Back, a link) is PUT with no page
 * left to show a failure. The save registry (src/lib/pendingInvoiceSaves.ts) records that failure per invoice, and the
 * next page that reads the invoice (the invoice page, or the edit page again) says so: "Your last change to <number>
 * was not saved — it is shown as stored." Once, and only after a failure: a save that landed says nothing.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, description, DRAFT, json, ok, puts, routerEvents, serveInvoice, type } from '../helpers/invoiceAutosaveHarness';

const h = vi.hoisted(() => ({ query: { invoiceId: 'inv-1' } as Record<string, string>, events: null as null | ReturnType<typeof import('../helpers/invoiceAutosaveHarness').routerEvents> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: h.query, push: vi.fn(), replace: vi.fn(), pathname: '/', isReady: true, events: h.events }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/customer-invoices/InvoicePdfPreview', () => ({ InvoicePdfPreview: () => null }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/sars/MarkVatDeclaredElsewhereButton', () => ({ MarkVatDeclaredElsewhereButton: () => null }));

import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';
import ViewPage from '../../../pages/accounting/customer-invoices/[invoiceId]';

useApiJsonOverMock();
beforeEach(() => { vi.useFakeTimers(); h.events = routerEvents(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.mocked(apiFetch).mockReset(); sessionStorage.clear(); });

const settle = async () => { for (let i = 0; i < 8; i++) await advance(0); };
const NOTICE = /Your last change to INV-AUTO was not saved — it is shown as stored\./;
let n = 0;

/** The edit page of a fresh invoice: a change typed, then the page goes inside the autosave wait (its PUT is sent as it leaves). */
async function leaveWithChange(answer: () => Response): Promise<string> {
  const id = `inv-leave-${++n}`;
  h.query = { invoiceId: id };
  serveInvoice((u, init) => {
    if (u.includes('customer-invoices-detail') && init?.method === 'PUT') return answer();
    if (u.includes('adjacent')) return ok({ prevId: null, nextId: null });
    return undefined;
  }, { ...DRAFT, id, status: 'draft', client_name: 'Acme', subtotal: 100, tax_amount: 15, amount_paid: 0 });
  render(<EditPage />);
  await settle();
  type(description(), 'Typed, then Back');
  cleanup(); // Next unmounts the editor: the change is PUT as it goes
  await settle();
  expect(puts()).toHaveLength(1);
  return id;
}

describe('a change PUT as the edit page left', () => {
  it('refused: the invoice page that reads it next says it was not saved, once', async () => {
    await leaveWithChange(() => json(500, { success: false, error: { code: 'INTERNAL', message: 'boom' } }));
    const view = render(<ViewPage />);
    await settle();
    expect(screen.getByText(NOTICE)).toBeTruthy();
    view.unmount();
    render(<ViewPage />);
    await settle();
    expect(screen.queryByText(NOTICE)).toBeNull(); // said once
  });

  it('refused: the edit page opened again says it too', async () => {
    await leaveWithChange(() => json(500, { success: false, error: { code: 'INTERNAL', message: 'boom' } }));
    render(<EditPage />);
    await settle();
    expect(screen.getByText(NOTICE)).toBeTruthy();
  });

  it('taken: the next page says nothing', async () => {
    await leaveWithChange(() => ok({ updated: true }));
    render(<ViewPage />);
    await settle();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});

// M14: this suite does not provide the auth context or the comments route; the panel has its own tests (commentsPanel, commentsMounts).
vi.mock('@/components/accounting/comments/CommentsPanel', () => ({ CommentsPanel: () => null }));

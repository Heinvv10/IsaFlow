/**
 * PR S blind review, the edit page:
 * - a due date added on this visit and autosaved is stored: clearing it is refused like a date the page loaded with
 *   (the server keeps a date the body leaves out, so Saved would be untrue);
 * - another invoice opened in place takes its own VAT mode and starts with no refused dates;
 * - once approved the form stays disabled; a refusal on screen goes once autosave reports Saved.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, bodyOf, description, DRAFT, ok, puts, refused, routerEvents, serveInvoice, type } from '../helpers/invoiceAutosaveHarness';
import { typeDate } from '../helpers/dateFields';

const h = vi.hoisted(() => ({ push: vi.fn(), query: { invoiceId: 'inv-1' } as Record<string, string>, events: null as null | ReturnType<typeof import('../helpers/invoiceAutosaveHarness').routerEvents> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: h.query, push: h.push, replace: vi.fn(), pathname: '/', isReady: true, events: h.events }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/customer-invoices/InvoicePdfPreview', () => ({ InvoicePdfPreview: () => null }));

import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';

useApiJsonOverMock();
beforeEach(() => { vi.useFakeTimers(); h.events = routerEvents(); h.query = { invoiceId: 'inv-1' }; });
afterEach(() => { cleanup(); vi.useRealTimers(); h.push.mockReset(); vi.mocked(apiFetch).mockReset(); });

const settle = async () => { for (let i = 0; i < 6; i++) await advance(0); };
const statusText = () => screen.getAllByRole('status').map((e) => e.textContent).join(' | ');
const mode = () => screen.getByRole('combobox', { name: 'Amounts are' }).textContent;

describe('a due date added on this visit', () => {
  it('once autosaved, clearing it is refused and not saved', async () => {
    serveInvoice(undefined, { ...DRAFT, due_date: null });
    render(<EditPage />);
    await settle();
    typeDate(screen.getByLabelText('Due date'), '15 Oct 2026');
    await advance(1_500);
    expect(puts()).toHaveLength(1);
    expect(bodyOf(puts()[0]!).dueDate).toBe('2026-10-15');
    const due = screen.getByLabelText('Due date');
    fireEvent.change(due, { target: { value: '' } });
    fireEvent.blur(due);
    await advance(5_000);
    expect(puts()).toHaveLength(1);
    expect(statusText()).toMatch(/The due date cannot be cleared here/);
  });
});

describe('another invoice opened in place', () => {
  it('takes its own VAT mode: a rate-0 invoice, then a 15% one', async () => {
    serveInvoice((u) => (u.includes('id=inv-1') ? ok({ ...DRAFT, tax_rate: 0 }) : u.includes('id=inv-2') ? ok({ ...DRAFT, id: 'inv-2' }) : undefined));
    const { rerender } = render(<EditPage />);
    await settle();
    expect(mode()).toMatch(/No VAT/);
    h.query = { invoiceId: 'inv-2' };
    rerender(<EditPage />);
    await settle();
    expect(mode()).toMatch(/Excluding VAT/);
    expect((screen.getByLabelText('VAT rate %') as HTMLInputElement).value).toBe('15');
  });

  it('starts with no refused dates from the one before', async () => {
    serveInvoice((u) => (u.includes('id=inv-2') ? ok({ ...DRAFT, id: 'inv-2' }) : undefined));
    const { rerender } = render(<EditPage />);
    await settle();
    typeDate(screen.getByLabelText(/^Invoice date/), 'not a date');
    await advance(0);
    h.query = { invoiceId: 'inv-2' };
    rerender(<EditPage />);
    await settle();
    type(description(), 'Edited on B');
    await advance(1_500);
    expect(puts()).toHaveLength(1);
  });
});

describe('after Approve & email', () => {
  it('the form stays disabled once approved', async () => {
    serveInvoice();
    render(<EditPage />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /approve & email/i }));
    await settle();
    expect(screen.getByRole('heading', { name: 'Email Invoice' })).toBeTruthy();
    expect(description()).toBeDisabled();
  });

  it('a refusal on screen goes once autosave reports Saved', async () => {
    serveInvoice((u, init) => (u.includes('customer-invoices-detail') && init?.method === 'POST' ? refused(400, 'The invoice date falls in a closed period') : undefined));
    render(<EditPage />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /approve & email/i }));
    await settle();
    expect(screen.getByText('The invoice date falls in a closed period')).toBeTruthy();
    type(description(), 'Fixed it');
    await advance(1_500);
    await settle();
    expect(statusText()).toMatch(/Saved/);
    expect(screen.queryByText('The invoice date falls in a closed period')).toBeNull();
  });
});

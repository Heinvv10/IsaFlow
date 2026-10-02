// A failed request shows the server's message (400) or a plain sentence (empty 500), never a blank list or a raw JSON error.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { MSG, bad400, empty500, okRes, rawJsonError, router } from '../helpers/d2CensusG6';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const notify = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('@/utils/toast', () => ({ notify }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import { BankAccountSelector } from '@/components/accounting/bank/BankAccountSelector';
import { ExtractionReview } from '@/components/accounting/document-capture/ExtractionReview';
import { CompanyPicker } from '@/components/admin/CompanyPicker';
import { TodoWidget } from '@/components/dashboard/widgets/TodoWidget';

const script = (routes: Array<[string, () => Response]>, fallback: unknown = []) => vi.mocked(apiFetch).mockReset().mockImplementation(router(routes, fallback));
const noRawJson = () => expect(document.body.textContent ?? '').not.toMatch(rawJsonError);
afterEach(() => { cleanup(); notify.success.mockReset(); notify.error.mockReset(); });

describe('Bank account selector', () => {
  const SITE = 'chart-of-accounts';
  const show = () => render(<BankAccountSelector value={null} onChange={() => undefined} />);
  it('shows the server message on a 400', async () => { script([[SITE, bad400]]); show(); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    script([[SITE, empty500]]); show();
    expect(await screen.findByText('Could not load bank accounts - try again')).toBeTruthy(); noRawJson();
  });
  it('offers the bank accounts on success', async () => {
    script([[SITE, () => okRes([{ id: 'a1', accountCode: '1000', accountName: 'D2 Bank Account' }])]]); show();
    expect(await screen.findByRole('option', { name: /D2 Bank Account/ })).toBeTruthy();
  });
});

describe('Extraction review confirm / reject', () => {
  const SITE = 'document-capture-action';
  const doc = { document: { id: 'doc1', fileName: 'scan.pdf' }, extracted: { confidence: 0.9, warnings: [], lineItems: [] } } as never;
  const form = { vendor: '', date: '', ref: '', total: '', vat: '', docType: 'invoice', notes: '' };
  const press = (name: RegExp, res: () => Response) => {
    script([[SITE, res]]);
    const onDismiss = vi.fn();
    render(<ExtractionReview uploadResult={doc} form={form} onChange={() => undefined} onDismiss={onDismiss} onRefreshList={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name }));
    return onDismiss;
  };
  it('confirm: toasts the server message on a 400', async () => {
    press(/confirm/i, bad400); await waitFor(() => expect(notify.error).toHaveBeenCalledWith(MSG));
  });
  it('confirm: toasts a plain sentence on an empty 500', async () => {
    press(/confirm/i, empty500);
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Could not confirm the document - try again'));
    expect(String(notify.error.mock.calls[0]?.[0])).not.toMatch(rawJsonError);
  });
  it('confirm: reports success and dismisses on a 200', async () => {
    const onDismiss = press(/confirm/i, () => okRes({}));
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Document confirmed')); expect(onDismiss).toHaveBeenCalled();
  });
  it('reject: toasts the server message on a 400', async () => {
    press(/reject/i, bad400); await waitFor(() => expect(notify.error).toHaveBeenCalledWith(MSG));
  });
  it('reject: toasts a plain sentence on an empty 500', async () => {
    press(/reject/i, empty500);
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Could not reject the document - try again'));
    expect(String(notify.error.mock.calls[0]?.[0])).not.toMatch(rawJsonError);
  });
  it('reject: reports success on a 200', async () => {
    press(/reject/i, () => okRes({})); await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Document rejected'));
  });
});

describe('Admin company picker search', () => {
  const SITE = '/api/admin/companies';
  const search = () => { render(<CompanyPicker value={[]} onChange={() => undefined} />); fireEvent.change(screen.getByRole('combobox'), { target: { value: 'acme' } }); };
  it('shows the server message on a 400', async () => { script([[SITE, bad400]]); search(); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    script([[SITE, empty500]]); search();
    expect(await screen.findByText('Could not search companies - try again')).toBeTruthy(); noRawJson();
  });
  it('lists the matching companies on success', async () => {
    script([[SITE, () => okRes({ items: [{ id: 'c1', name: 'D2 Acme Holdings', status: 'active' }] })]]); search();
    expect(await screen.findByText('D2 Acme Holdings')).toBeTruthy();
  });
});

// TodoWidget caches a successful load at module level, so the success case runs last.
describe('Dashboard to-do widget', () => {
  const SITE = 'customer-invoices-list';
  it('shows the server message on a 400 instead of an all-clear', async () => {
    script([[SITE, bad400]]); render(<TodoWidget />);
    expect(await screen.findByText(MSG)).toBeTruthy(); expect(screen.queryByText(/all clear/)).toBeNull();
  });
  it('shows a plain sentence on an empty 500', async () => {
    script([['supplier-invoices', empty500]]); render(<TodoWidget />);
    expect(await screen.findByText('Unable to load actions')).toBeTruthy(); noRawJson();
  });
  it('lists the overdue invoices on success', async () => {
    script([[SITE, () => okRes({ total: 1, items: [{ id: 'x1', invoice_number: 'D2-INV-OVERDUE', client_name: 'D2 Slow Payer', total_amount: 10, due_date: '2026-01-01' }] })]]);
    render(<TodoWidget />);
    expect(await screen.findByText(/D2-INV-OVERDUE/)).toBeTruthy();
  });
});

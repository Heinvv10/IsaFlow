/**
 * D2 error envelope, group g2a: the CSV import pages of the migration wizard show the server's refusal
 * ({ success:false, error:{ code, message } }) instead of the generic "Import failed". The REAL
 * apiJson / assertOk run over a scripted apiFetch.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

const ROWS = vi.hoisted(() => [
  { account_code: '1000', debit_balance: '100', credit_balance: '0', name: 'Acme', customer_name: 'Acme', supplier_name: 'Acme', invoice_number: 'INV-1', total_amount: '100' },
  { account_code: '2000', debit_balance: '0', credit_balance: '100', name: 'Bolt', customer_name: 'Bolt', supplier_name: 'Bolt', invoice_number: 'INV-2', total_amount: '100' },
]);
vi.mock('papaparse', () => ({
  default: { parse: (_f: unknown, opts: { complete: (r: unknown) => void }) => opts.complete({ data: ROWS, meta: { fields: Object.keys(ROWS[0]!) } }) },
}));

import { apiFetch } from '@/lib/apiFetch';
import ApInvoicesPage from '../../../pages/accounting/migration/ap-invoices';
import ArInvoicesPage from '../../../pages/accounting/migration/ar-invoices';
import CustomersImportPage from '../../../pages/accounting/migration/customers';
import SuppliersImportPage from '../../../pages/accounting/migration/suppliers';
import OpeningBalancesPage from '../../../pages/accounting/migration/opening-balances';

void mockedApiFetchModule;
useApiJsonOverMock();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const refuse = (message: string, status = 422) => json({ success: false, error: { code: 'VALIDATION_ERROR', message } }, status);

/** Session + list lookups succeed; the page's POST route answers `postRoute` with the refusal. */
function answer(postRoute: string, message: string) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes(postRoute)) return refuse(message);
    if (u.includes('/migration/session')) return json({ success: true, data: { id: 's-1', session: { id: 's-1' } } });
    if (u.includes('suppliers-list')) return json({ success: true, data: { suppliers: [], total: 0 } });
    return json({ success: true, data: [] });
  });
}

async function upload(container: HTMLElement) {
  const input = container.querySelector('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [new File(['x'], 'f.csv', { type: 'text/csv' })] } });
}

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

it('AP invoices import shows the server message, not "Import failed"', async () => {
  const MSG = 'D2 server says no: AP invoice INV-1 is in a locked VAT period';
  answer('/migration/ap-invoices', MSG);
  const { container } = render(<ApInvoicesPage />);
  await upload(container);
  fireEvent.click(await screen.findByRole('button', { name: /Import 2 Invoices/ }));
  expect(await screen.findByText(MSG)).toBeTruthy();
  expect(screen.queryByText('Import failed')).toBeNull();
});

it('AR invoices import shows the server message, not "Import failed"', async () => {
  const MSG = 'D2 server says no: AR customer Acme has no debtors control account';
  answer('/migration/ar-invoices', MSG);
  const { container } = render(<ArInvoicesPage />);
  await upload(container);
  fireEvent.click(await screen.findByRole('button', { name: /Import 2 Invoices/ }));
  expect(await screen.findByText(MSG)).toBeTruthy();
  expect(screen.queryByText('Import failed')).toBeNull();
});

it('customers import shows the server message, not "Import failed"', async () => {
  const MSG = 'D2 server says no: customer file has 3 duplicate VAT numbers';
  answer('/migration/customers', MSG);
  const { container } = render(<CustomersImportPage />);
  await upload(container);
  fireEvent.click(await screen.findByRole('button', { name: /Import 2 Customers/ }));
  expect(await screen.findByText(MSG)).toBeTruthy();
  expect(screen.queryByText('Import failed')).toBeNull();
});

it('suppliers import shows the server message, not "Import failed"', async () => {
  const MSG = 'D2 server says no: supplier Bolt bank account number is invalid';
  answer('/migration/suppliers', MSG);
  const { container } = render(<SuppliersImportPage />);
  await upload(container);
  fireEvent.click(await screen.findByRole('button', { name: /Import 2 Suppliers/ }));
  expect(await screen.findByText(MSG)).toBeTruthy();
  expect(screen.queryByText('Import failed')).toBeNull();
});

it('opening balances import shows the server message, not "Import failed"', async () => {
  const MSG = 'D2 server says no: account 2000 does not exist in the chart';
  answer('/migration/opening-balances', MSG);
  const { container } = render(<OpeningBalancesPage />);
  await upload(container);
  fireEvent.change(container.querySelector('input[type="date"]')!, { target: { value: '2026-03-01' } });
  fireEvent.click(await screen.findByRole('button', { name: /Set Opening Balances/ }));
  expect(await screen.findByText(MSG)).toBeTruthy();
  expect(screen.queryByText('Import failed')).toBeNull();
});

/** Same lookups as `answer`, but the page's POST route succeeds with `data`. */
function answerOk(postRoute: string, data: unknown) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes(postRoute)) return json({ success: true, data });
    if (u.includes('/migration/session')) return json({ success: true, data: { id: 's-1', session: { id: 's-1' } } });
    if (u.includes('suppliers-list')) return json({ success: true, data: { suppliers: [], total: 0 } });
    return json({ success: true, data: [] });
  });
}

it('success: AP invoices import renders the data it received', async () => {
  answerOk('/migration/ap-invoices', { imported: 37, skipped: 4 });
  const { container } = render(<ApInvoicesPage />);
  await upload(container);
  fireEvent.click(await screen.findByRole('button', { name: /Import 2 Invoices/ }));
  expect(await screen.findByText(/Imported 37 invoices\. Skipped: 4\./)).toBeTruthy();
});

it('success: AR invoices import renders the data it received', async () => {
  answerOk('/migration/ar-invoices', { imported: 41, skipped: 6 });
  const { container } = render(<ArInvoicesPage />);
  await upload(container);
  fireEvent.click(await screen.findByRole('button', { name: /Import 2 Invoices/ }));
  expect(await screen.findByText(/Imported 41 invoices\. Skipped: 6\./)).toBeTruthy();
});

it('success: customers import renders the data it received', async () => {
  answerOk('/migration/customers', { succeeded: 53, skipped: 7, failed: 2 });
  const { container } = render(<CustomersImportPage />);
  await upload(container);
  fireEvent.click(await screen.findByRole('button', { name: /Import 2 Customers/ }));
  expect(await screen.findByText(/Imported 53 customers\. Skipped: 7\. Failed: 2\./)).toBeTruthy();
});

it('success: suppliers import renders the data it received', async () => {
  answerOk('/migration/suppliers', { succeeded: 29, skipped: 3, failed: 1 });
  const { container } = render(<SuppliersImportPage />);
  await upload(container);
  fireEvent.click(await screen.findByRole('button', { name: /Import 2 Suppliers/ }));
  expect(await screen.findByText(/Imported 29 suppliers\. Skipped: 3\. Failed: 1\./)).toBeTruthy();
});

it('success: opening balances import renders the data it received', async () => {
  // The service's real shape: { journalEntryId, linesImported, errors }. The
  // page used to read balancesSet / journalId, which it never returned.
  answerOk('/migration/opening-balances', { journalEntryId: 'J-777', linesImported: 61, errors: [] });
  const { container } = render(<OpeningBalancesPage />);
  await upload(container);
  fireEvent.change(container.querySelector('input[type="date"]')!, { target: { value: '2026-03-01' } });
  fireEvent.click(await screen.findByRole('button', { name: /Set Opening Balances/ }));
  expect(await screen.findByText(/Opening balances posted: 61 account line\(s\)\. Journal entry J-777/)).toBeTruthy();
});

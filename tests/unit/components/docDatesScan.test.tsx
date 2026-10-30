/**
 * Wave 2 PR A, review round: a scan-fill that sets a date the form ALREADY holds must clear a refusal on screen.
 * The form keeps the last good date when text is refused, so the scan's date equals the held one: DateField sees no
 * change and (without a resetKey) would keep the refused text and the submit gate shut.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2CensusG4';
import { typeDate } from '../helpers/dateFields';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(async () => true), replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1', name: 'Co' } }) }));
const scanned = vi.hoisted(() => ({ date: '2031-10-05' }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({
  ScanAndFillButton: ({ onExtracted }: { onExtracted: (d: Record<string, unknown>) => void }) => (
    <button type="button" onClick={() => onExtracted({ date: scanned.date, dueDate: scanned.date, referenceNumber: null, vendorName: null, customerName: null,
      totalAmount: null, vatRate: null, paymentTerms: null, purchaseOrderRef: null, lineItems: [], confidence: 0.9 })}>scan</button>
  ),
}));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({
  SupplierSelect: ({ onChange }: { onChange: (id: string, name: string) => void }) => (
    <button type="button" onClick={() => onChange('sup-1', 'Acme')}>pick-supplier</button>
  ),
}));

import { apiFetch } from '@/lib/apiFetch';
import CustomerPaymentNew from '../../../pages/accounting/customer-payments/new';
import SupplierInvoiceNew from '../../../pages/accounting/supplier-invoices/new';
import SupplierPaymentNew from '../../../pages/accounting/supplier-payments/new';

useApiJsonOverMock();
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async () => ok([]));
});
afterEach(cleanup);

const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST');
const box = (label: string): HTMLInputElement => screen.getByRole('textbox', { name: new RegExp(`^${label}`, 'i') }) as HTMLInputElement;

interface Case { page: string; element: ReactElement; dates: string[]; prepare?: () => void; }
const supplier = (): void => { fireEvent.click(screen.getByText('pick-supplier')); };
const cases: Case[] = [
  { page: 'customer-payments/new', element: <CustomerPaymentNew />, dates: ['Payment Date'] },
  { page: 'supplier-payments/new', element: <SupplierPaymentNew />, dates: ['Payment Date'], prepare: supplier },
  { page: 'supplier-invoices/new', element: <SupplierInvoiceNew />, dates: ['Invoice Date', 'Due Date'], prepare: supplier },
];

describe.each(cases)('$page', (c) => {
  for (const label of c.dates) {
    it(`a scan that re-sets the held ${label} replaces the refused text and unblocks the submit`, async () => {
      render(c.element);
      c.prepare?.();
      typeDate(box(label), '5 Oct 2031'); // the form now holds 2031-10-05 ...
      typeDate(box(label), 'zz');         // ... and keeps it while 'zz' is refused
      expect(box(label).getAttribute('aria-invalid')).toBe('true');
      fireEvent.click(screen.getByText('scan')); // the scan reads 2031-10-05: the same value
      await waitFor(() => expect(box(label).value).toBe('05 Oct 2031'));
      expect(box(label).getAttribute('aria-invalid')).not.toBe('true');
      fireEvent.submit(document.querySelector('form')!);
      await waitFor(() => expect(posts().length).toBeGreaterThan(0));
    });
  }
});

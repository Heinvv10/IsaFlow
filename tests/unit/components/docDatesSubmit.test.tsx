/**
 * Wave 2 PR A: submit on the document forms. The posted date is the ISO "YYYY-MM-DD" behind what was typed, and a
 * date the field refused blocks the submit (the old good date must not be posted behind a visible error).
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
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({
  SupplierSelect: ({ onChange }: { onChange: (id: string, name: string) => void }) => (
    <button type="button" onClick={() => onChange('sup-1', 'Acme')}>pick-supplier</button>
  ),
}));

import { apiFetch } from '@/lib/apiFetch';
import PaymentNew from '../../../pages/accounting/customer-payments/new';
import PoNew from '../../../pages/accounting/purchase-orders/new';
import SupplierInvoiceNew from '../../../pages/accounting/supplier-invoices/new';
import BankRecNew from '../../../pages/accounting/bank-reconciliation/new';
import CreditNoteNew from '../../../pages/accounting/credit-notes/new';

useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); vi.mocked(apiFetch).mockImplementation(async () => ok([])); });
afterEach(cleanup);

const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST');
const body = () => JSON.parse(String(posts()[0]![1]!.body)) as Record<string, unknown>;
const box = (label: string): HTMLInputElement => screen.getByRole('textbox', { name: new RegExp(`^${label}`, 'i') }) as HTMLInputElement;
const submit = () => fireEvent.submit(document.querySelector('form')!);

interface FormCase {
  page: string;
  element: ReactElement;
  prepare?: () => Promise<void> | void;
  dates: { label: string; key: string }[];
}

const forms: FormCase[] = [
  { page: 'customer-payments/new', element: <PaymentNew />, dates: [{ label: 'Payment Date', key: 'paymentDate' }] },
  { page: 'purchase-orders/new', element: <PoNew />, prepare: () => { fireEvent.click(screen.getByText('pick-supplier')); },
    dates: [{ label: 'Order Date', key: 'orderDate' }, { label: 'Expected Delivery', key: 'expectedDeliveryDate' }] },
  { page: 'supplier-invoices/new', element: <SupplierInvoiceNew />, prepare: () => { fireEvent.click(screen.getByText('pick-supplier')); },
    dates: [{ label: 'Invoice Date', key: 'invoiceDate' }, { label: 'Due Date', key: 'dueDate' }] },
  { page: 'credit-notes/new', element: <CreditNoteNew />, dates: [{ label: 'Credit Date', key: 'creditDate' }] },
  { page: 'bank-reconciliation/new', element: <BankRecNew />, dates: [{ label: 'Statement Date', key: 'statementDate' }] },
];

describe.each(forms)('$page', (c) => {
  for (const d of c.dates) {
    it(`posts ${d.label} as ISO`, async () => {
      render(c.element);
      await c.prepare?.();
      typeDate(box(d.label), '5 Oct 2031');
      submit();
      await waitFor(() => expect(posts().length).toBeGreaterThan(0));
      expect(body()[d.key]).toBe('2031-10-05');
    });

    it(`does not post while ${d.label} is refused, then posts the fixed date`, async () => {
      render(c.element);
      await c.prepare?.();
      typeDate(box(d.label), 'zz');
      submit();
      expect(posts()).toHaveLength(0);
      typeDate(box(d.label), '6 Oct 2031');
      submit();
      await waitFor(() => expect(posts().length).toBeGreaterThan(0));
      expect(body()[d.key]).toBe('2031-10-06');
    });
  }
});

describe('purchase-orders/new', () => {
  it('a refused date shows its reason on the field', () => {
    render(<PoNew />);
    typeDate(box('Order Date'), 'zz');
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });
});

/**
 * D2 census group 4 (c): purchases-by-supplier, waterfall, supplier allocations, supplier payment detail,
 * year-end. A 400 shows the server's message, an empty 500 a plain sentence (never "Unexpected end of JSON
 * input"), a 200 renders the data.
 * LEFT: reports/cash-flow cost-centre filter (best-effort reference data, empty filter is the stated fallback).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, vi } from 'vitest';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { paymentId: 'p-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('@/components/accounting/DataQualityNotice', () => ({ DataQualityNotice: () => null }));
vi.mock('@/components/shared/WaterfallChart', () => ({ WaterfallChart: () => null }));

import PurchasesBySupplierPage from '../../../pages/accounting/reports/purchases-by-supplier';
import WaterfallPage from '../../../pages/accounting/reports/waterfall';
import SupplierAllocationsPage from '../../../pages/accounting/supplier-allocations/index';
import SupplierPaymentPage from '../../../pages/accounting/supplier-payments/[paymentId]';
import YearEndPage from '../../../pages/accounting/year-end/index';
import { ok, trio } from '../helpers/d2CensusG4';

void mockedApiFetchModule;
useApiJsonOverMock();
afterEach(() => { cleanup(); });

const PAYMENT_LIST = { items: [{ id: 'p-1', paymentNumber: 'PAY-D2-777', supplierName: 'Sup', supplierId: 's-1', date: '2031-03-01', totalAmount: 100, allocatedAmount: 0 }] };

describe('reports/purchases-by-supplier load', () => {
  trio({ name: 'purchases by supplier', render: () => render(<PurchasesBySupplierPage />), match: u => u.includes('purchases-by-supplier'),
    data: [{ supplierId: 's1', supplierName: 'D2 Supplier 777', invoiceCount: 1, totalPurchases: 10, paymentsMade: 0, outstanding: 10 }],
    plain: 'Could not load the purchases report - try again', success: /D2 Supplier 777/ });
});

describe('reports/waterfall load', () => {
  trio({ name: 'waterfall', render: () => render(<WaterfallPage />), match: u => u.includes('reports-waterfall'),
    data: { steps: [{ label: 'D2 Step 777', value: 5, isSubtotal: false }], unclassifiedAccounts: null },
    plain: 'Could not load the waterfall chart - try again', success: /D2 Step 777/ });
});

describe('supplier-allocations', () => {
  const list = (u: string) => (u.includes('supplier-payments') ? ok(PAYMENT_LIST) : undefined);
  trio({ name: 'unallocated payments', render: () => render(<SupplierAllocationsPage />), match: u => u.includes('supplier-payments'),
    data: PAYMENT_LIST, plain: 'Could not load the unallocated payments - try again', success: /PAY-D2-777/ });
  trio({ name: 'invoices for the selected payment', render: () => render(<SupplierAllocationsPage />), match: u => u.includes('supplier-invoices'),
    data: [{ id: 'i1', invoiceNumber: 'SINV-D2-777', date: '2031-03-01', total: 100, outstanding: 100 }], others: list,
    drive: async () => { fireEvent.click(await screen.findByText(/PAY-D2-777/)); },
    plain: 'Could not load the supplier invoices - try again', success: /SINV-D2-777/ });
});

describe('supplier-payments detail load', () => {
  trio({ name: 'payment detail', render: () => render(<SupplierPaymentPage />), match: u => u.includes('supplier-payments?id='),
    data: { id: 'p-1', paymentNumber: 'PAY-D2-888', supplierId: 1, supplierName: 'Sup', paymentDate: '2031-03-01', totalAmount: 100,
      paymentMethod: 'eft', status: 'draft', allocations: [] },
    plain: 'Could not load the payment - try again', success: /PAY-D2-888/ });
});

describe('year-end load', () => {
  trio({ name: 'fiscal years', render: () => render(<YearEndPage />), match: u => u.includes('/api/accounting/year-end') && !u.includes('export'),
    data: { years: [{ year_label: 'FY-D2-777', start_date: '2031-03-01', end_date: '2032-02-28', status: 'open', periods_open: 1, periods_closed: 11,
      total_revenue: 1, total_expenses: 1, net_income: 0 }] },
    plain: 'Could not load the fiscal years - try again', success: /FY-D2-777/ });
});

/** D2 census group 8 (b): list and report pages that read `res.json()` without checking the status. */
import { screen } from '@testing-library/react';
import { vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { runSiteCases } from '../helpers/d2CensusG8Harness';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/utils/toast', () => ({ notify: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => null }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({ SupplierSelect: () => null }));

import ItemCategoriesPage from '../../../pages/accounting/item-categories/index';
import ProductsListPage from '../../../pages/accounting/products/index';
import AccountTransactionsPage from '../../../pages/accounting/reports/account-transactions';
import ItemQuantitiesPage from '../../../pages/accounting/reports/item-quantities';
import TrendAnalysisPage from '../../../pages/accounting/reports/trend-analysis';
import SupplierCategoriesPage from '../../../pages/accounting/supplier-categories/index';
import SupplierReturnsPage from '../../../pages/accounting/supplier-returns/index';

useApiJsonOverMock();

const EMPTY_REPORT = { accountCode: '1110', accountName: 'Bank', accountType: 'asset', openingBalance: 0, closingBalance: 0, transactions: [] };

runSiteCases([
  { name: 'item categories', ui: () => <ItemCategoriesPage />,
    hit: (u) => u.endsWith('/api/accounting/item-categories'), okData: [{ id: 'k1', name: 'D2 Item Category', description: 'd' }],
    plain: /Could not load categories/, okCheck: () => screen.findByText('D2 Item Category') },
  { name: 'products', ui: () => <ProductsListPage />,
    hit: (u) => u.includes('/api/accounting/products?'),
    okData: [{ id: 'p1', code: 'D2-PRD', name: 'D2 Widget', category: 'c', category_name: 'c', product_type: 'inventory', unit: 'ea',
      cost_price: 1, selling_price: 2, current_stock: 3, reorder_level: 0, avg_cost: 1, is_active: true }],
    plain: /Could not load products/, okCheck: () => screen.findByText('D2 Widget') },
  { name: 'account transactions: chart of accounts', ui: () => <AccountTransactionsPage />,
    hit: (u) => u.includes('chart-of-accounts'),
    okData: [{ id: 'g1', accountCode: '7788', accountName: 'D2 Ledger Account', level: 3, hasTransactions: true, parentAccountId: null }],
    other: (u) => (u.includes('reports-account-transactions') ? EMPTY_REPORT : { items: [] }),
    plain: /Could not load the chart of accounts/, okCheck: () => screen.findByRole('option', { name: '7788 — D2 Ledger Account' }) },
  { name: 'item quantities', ui: () => <ItemQuantitiesPage />,
    hit: (u) => u.includes('reports/item-quantities'),
    okData: [{ id: 'i1', itemCode: 'D2-ITM', name: 'D2 Bolt', category: 'c', uom: 'ea', qtyOnHand: 4, minLevel: 0, lowStock: false }],
    plain: /Could not load the report/, okCheck: () => screen.findByText('D2 Bolt') },
  { name: 'trend analysis', ui: () => <TrendAnalysisPage />,
    hit: (u) => u.includes('reports-trend-analysis'),
    okData: { analysis: { cmgr: 12.34, dataPoints: [{ period: '2026-09', value: 1000 }], movingAverage3: [0], anomalies: [], growthRates: [] } },
    plain: /Could not load the trend analysis/, okCheck: () => screen.findByText(/\+12\.34%/) },
  { name: 'supplier categories', ui: () => <SupplierCategoriesPage />,
    hit: (u) => u.endsWith('/api/accounting/supplier-categories'),
    okData: [{ id: 's1', name: 'D2 Supplier Category', description: 'd', supplierCount: 3 }],
    plain: /Could not load supplier categories/, okCheck: () => screen.findByText('D2 Supplier Category') },
  { name: 'supplier returns', ui: () => <SupplierReturnsPage />,
    hit: (u) => u.endsWith('/api/accounting/supplier-returns'),
    okData: { returns: [{ id: 'r1', return_number: 'D2-RET-1', supplier_name: 'D2 Supplier', original_invoice_number: null,
      return_date: '2026-10-01', amount: 5, reason: 'broken', status: 'pending' }] },
    plain: /Could not load supplier returns/, okCheck: () => screen.findByText('D2-RET-1') },
]);

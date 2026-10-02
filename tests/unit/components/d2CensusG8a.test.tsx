/**
 * D2 census group 8 (a): a non-2xx on the main load / save paths of these pages shows the server's message,
 * or a plain sentence for an empty body, and a 200 still renders the data.
 */
import { fireEvent, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { runSiteCases } from '../helpers/d2CensusG8Harness';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { paymentId: 'pay-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/utils/toast', () => ({ notify: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/components/accounting/AutoPostLlmSection', () => ({ AutoPostLlmSection: () => null }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => null }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));

import AccountingSettingsPage from '../../../pages/accounting/accounting-settings';
import FarReportPage from '../../../pages/accounting/assets/far-report';
import BatchPaymentsPage from '../../../pages/accounting/batch-payments/index';
import ConsolidationPage from '../../../pages/accounting/consolidation/index';
import CustomerPaymentDetailPage from '../../../pages/accounting/customer-payments/[paymentId]';
import DepreciationPage from '../../../pages/accounting/depreciation/index';

useApiJsonOverMock();

const AUTO_POST = { enabled: false, minConfidence: 0.9, amountCap: 10000, llmEnabled: false, llmMinConfidence: 0.95, llmAmountCap: 2000 };
const SUB = { items: [{ id: 'co-1', name: 'D2 Sub Co', relationshipType: 'subsidiary', ownershipPercent: 80 }] };
const TB = { groupName: 'D2 Group', periodStart: '2026-10-01', periodEnd: '2026-10-31', entities: [], totalDebits: 0, totalCredits: 0,
  accounts: [{ accountCode: '7777', accountName: 'D2 Consol Account', accountType: 'asset', byEntity: {}, totalDebit: 5, totalCredit: 5, isEliminated: false }] };

runSiteCases([
  { name: 'accounting settings: load', ui: () => <AccountingSettingsPage />,
    hit: (u) => u.includes('accounting-settings?key='), okData: { value: 'EUR' }, other: () => ({ settings: AUTO_POST }),
    plain: /Could not load settings/, okCheck: () => screen.findByDisplayValue(/EUR/) },
  { name: 'accounting settings: save auto-post', ui: () => <AccountingSettingsPage />,
    hit: (u, init) => u.includes('bank-auto-post') && init?.method === 'PUT', okData: { settings: { ...AUTO_POST, enabled: true } },
    other: (u) => (u.includes('bank-auto-post') ? { settings: AUTO_POST } : { value: 'ZAR' }),
    act: async () => { fireEvent.click(await screen.findByRole('button', { name: 'Off' })); },
    plain: /Could not save auto-post settings/, okCheck: () => screen.findByRole('button', { name: 'On' }) },
  { name: 'fixed asset register', ui: () => <FarReportPage />,
    hit: (u) => u.includes('far-report?asAt='), okData: { asAt: '2026-10-01', assets: [], totals: {}, setupRequired: 'D2 register marker' },
    plain: /Could not load the report/, okCheck: () => screen.findByText('D2 register marker') },
  { name: 'batch payments', ui: () => <BatchPaymentsPage />,
    hit: (u) => u.endsWith('/api/accounting/batch-payments'),
    okData: { items: [{ id: 'b1', batchNumber: 'D2-BATCH-77', batchDate: '2026-10-01', totalAmount: 5, paymentCount: 1, paymentMethod: 'eft', status: 'draft' }] },
    plain: /Could not load batch payments/, okCheck: () => screen.findByText('D2-BATCH-77') },
  { name: 'consolidation: group companies', ui: () => <ConsolidationPage />,
    hit: (u) => u.includes('consolidation/companies'), okData: SUB,
    plain: /Could not load group companies/, okCheck: () => screen.findByText('D2 Sub Co') },
  { name: 'consolidation: trial balance', ui: () => <ConsolidationPage />,
    hit: (u) => u.includes('consolidation/trial-balance'), okData: TB, other: () => SUB,
    act: async () => { await screen.findByText('D2 Sub Co'); fireEvent.click(await screen.findByRole('button', { name: /Run/ })); },
    plain: /Could not load the report/, okCheck: () => screen.findByText('D2 Consol Account') },
  { name: 'customer payment detail', ui: () => <CustomerPaymentDetailPage />,
    hit: (u) => u.includes('customer-payments?id=pay-1'),
    okData: { id: 'pay-1', paymentNumber: 'D2-PAY-9', clientId: 'c1', clientName: 'D2 Client', paymentDate: '2026-10-01', totalAmount: 5,
      paymentMethod: 'eft', status: 'draft', allocations: [] },
    plain: /Could not load the payment/, okCheck: () => screen.findByText('D2-PAY-9') },
  { name: 'depreciation: assets', ui: () => <DepreciationPage />,
    hit: (u) => u.includes('/api/accounting/assets?'),
    okData: { items: [{ id: 'a1', asset_number: 'D2-AST-1', name: 'D2 Press Brake', purchase_price: 12000, current_book_value: 12000,
      accumulated_depreciation: 0, useful_life_years: 5, salvage_value: 0, depreciation_method: null, purchase_date: '2026-01-01', disposal_date: null }] },
    plain: /Could not load the assets/, okCheck: () => screen.findByText('D2 Press Brake') },
]);

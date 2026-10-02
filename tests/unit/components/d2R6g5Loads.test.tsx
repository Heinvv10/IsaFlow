/**
 * D2 round 6 (g5): every list/report page of this group, answered with an empty-body 500 on load, shows a plain
 * sentence naming what could not be loaded (no JSON parse error, no HTTP code, no bare "Failed") and a refused
 * load shows the server message. REAL assertOk / apiErrorMessage over the scripted apiFetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, bad, empty500, noRawText, route } from '../helpers/d2R3a1Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { id: 'x-1' }, isReady: true, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({ SupplierSelect: () => null }));
vi.mock('@/components/accounting/management-packs/ManagementPackConfigTab', () => ({ ManagementPackConfigTab: () => null }));

import BatchesPage from '../../../pages/payroll/batches/index';
import ComponentsPage from '../../../pages/payroll/components/index';
import Irp5Page from '../../../pages/payroll/irp5/index';
import ClientsPage from '../../../pages/accounting/practice/clients/index';
import JobsPage from '../../../pages/accounting/practice/jobs/index';
import CostRatesPage from '../../../pages/accounting/practice/staff-cost-rates/index';
import UtilisationPage from '../../../pages/accounting/practice/reports/utilisation';
import SuppliersPage from '../../../pages/accounting/suppliers/index';
import MissingInvoicesPage from '../../../pages/accounting/suppliers/missing-invoices';
import ExchangeRatesPage from '../../../pages/accounting/exchange-rates';
import BankStatementsPage from '../../../pages/accounting/bank/statements/index';
import StatementRecsPage from '../../../pages/accounting/ap/supplier-statements/index';
import StatementRecPage from '../../../pages/accounting/ap/supplier-statements/[id]';
import CashMovementPage from '../../../pages/accounting/reports/cash-movement';
import PacksPage from '../../../pages/accounting/afs/management-packs';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

const CASES: Array<[string, () => JSX.Element, string]> = [
  ['payroll batches', () => <BatchesPage />, 'Could not load the batches - try again'],
  ['payroll components', () => <ComponentsPage />, 'Could not load the components - try again'],
  ['IRP5 summary', () => <Irp5Page />, 'Could not load the IRP5 summary - try again'],
  ['practice clients', () => <ClientsPage />, 'Could not load the clients - try again'],
  ['practice jobs', () => <JobsPage />, 'Could not load the jobs - try again'],
  ['staff cost rates', () => <CostRatesPage />, 'Could not load the staff list - try again'],
  ['utilisation report', () => <UtilisationPage />, 'Could not load the utilisation report - try again'],
  ['suppliers', () => <SuppliersPage />, 'Could not load the suppliers - try again'],
  ['missing invoices', () => <MissingInvoicesPage />, 'Could not load the missing invoice alerts - try again'],
  ['exchange rates', () => <ExchangeRatesPage />, 'Could not load the exchange rate data - try again'],
  ['bank statement imports', () => <BankStatementsPage />, 'Could not load the statement imports - try again'],
  ['supplier statements', () => <StatementRecsPage />, 'Could not load the supplier statements - try again'],
  ['supplier statement detail', () => <StatementRecPage />, 'Could not load the reconciliation - try again'],
  ['cash movement', () => <CashMovementPage />, 'Could not load the cash movement report - try again'],
  ['management packs', () => <PacksPage />, 'Could not load the pack settings - try again'],
];

describe.each(CASES)('%s', (_name, page, sentence) => {
  it('an empty-body 500 on load shows a plain sentence', async () => {
    route(() => empty500());
    render(page());
    expect(await screen.findByText(sentence)).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
  it('a refused load shows the server message, not a made-up empty view', async () => {
    route(() => bad());
    render(page());
    expect((await screen.findAllByText(new RegExp(MSG))).length).toBeGreaterThan(0);
  });
});

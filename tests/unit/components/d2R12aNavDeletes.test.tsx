/**
 * D2 round 12: deletes (customer, supplier, supplier rule) and the report builder's save navigate after the write
 * succeeded. A pending navigation keeps the busy control disabled; a cancelled one releases it; a rejected one is logged
 * and never says the delete / save failed (the record is already gone / saved).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, on, serve } from '../helpers/d2R3a6';
import { pendingNavigationKeepsButtonDisabled, rejectedNavigationIsNotAWriteFailure, type NavCase } from '../helpers/d2R12aNav';

const route = vi.hoisted(() => ({ query: {} as Record<string, string>, push: vi.fn(), replace: vi.fn(), isReady: true, pathname: '/' }));
const warn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn, debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', companyId: 'c1' }) }));
vi.mock('@/components/accounting/suppliers/ContactsTab', () => ({ ContactsTab: () => null }));
vi.mock('@/components/accounting/suppliers/ActivityTab', () => ({ ActivityTab: () => null }));
vi.mock('@/components/accounting/suppliers/DrcFlagToggle', () => ({ DrcFlagToggle: () => null }));
vi.mock('@/components/accounting/reports/ReportBuilderFilters', () => ({ ReportBuilderFilters: () => null }));
vi.mock('@/components/accounting/reports/ReportBuilderPreview', () => ({ ReportBuilderPreview: () => null }));
vi.mock('@/components/accounting/reports/ReportBuilderSidebar', () => ({
  ReportBuilderSidebar: (p: { onSourceChange: (s: string) => void; onAddField: (f: unknown) => void }) => (
    <div>
      <button onClick={() => p.onSourceChange('invoices')}>pick-source</button>
      <button onClick={() => p.onAddField({ field: 'f1', label: 'F1', type: 'text', filterable: true })}>add-col</button>
    </div>
  ),
}));

import { apiFetch } from '@/lib/apiFetch';
import CustomerPage from '../../../pages/accounting/customers/[customerId]';
import SupplierPage from '../../../pages/accounting/suppliers/[supplierId]';
import SupplierRulesPage from '../../../pages/accounting/suppliers/[supplierId]/rules';
import BuilderPage from '../../../pages/accounting/reports/builder';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
const alertSpy = vi.fn();
beforeEach(() => {
  vi.mocked(apiFetch).mockReset(); route.push.mockReset(); route.replace.mockReset(); warn.mockReset(); alertSpy.mockReset();
  vi.stubGlobal('confirm', vi.fn(() => true)); vi.stubGlobal('alert', alertSpy);
});
afterEach(() => { cleanup(); route.query = {}; vi.unstubAllGlobals(); });

describe('customers/[customerId] delete', () => {
  const customer = { id: 'cu1', name: 'D2 Delete Customer', email: null, phone: null, contact_person: null, vat_number: null, registration_number: null, payment_terms: 30, credit_limit: 0, is_active: true, created_at: '2026-01-01' };
  const del = () => screen.getByRole('button', { name: /Delete customer|Deleting/ });
  const nav = (): NavCase => ({
    push: route.push, warn, button: del,
    drive: async () => {
      route.query = { customerId: 'cu1' };
      serve(on('POST', 'soft-delete', () => ok({})), on('GET', 'customers?id=', () => ok(customer)));
      render(<CustomerPage />);
      await screen.findAllByText('D2 Delete Customer');
      fireEvent.click(await screen.findByRole('button', { name: /Delete customer/ }));
    },
    claimsFailure: () => alertSpy.mock.calls.length > 0,
  });
  it('a pending navigation keeps the button disabled; a cancelled one releases it', async () => { await pendingNavigationKeepsButtonDisabled(nav()); });
  it('a rejected navigation does not alert that the delete failed', async () => { await rejectedNavigationIsNotAWriteFailure(nav()); });
});

describe('suppliers/[supplierId] delete', () => {
  const del = () => screen.getByRole('button', { name: /Delete supplier|Deleting/ });
  const nav = (): NavCase => ({
    push: route.push, warn, button: del,
    drive: async () => {
      route.query = { supplierId: 'sup-1' };
      serve(on('DELETE', 'soft-delete', () => ok({})), on('POST', 'soft-delete', () => ok({})), on('GET', 'suppliers-list', () => ok({ id: 'sup-1', name: 'D2 Delete Supplier', is_active: true })));
      render(<SupplierPage />);
      await screen.findAllByText('D2 Delete Supplier');
      fireEvent.click(await screen.findByRole('button', { name: /Delete supplier/ }));
    },
    claimsFailure: () => alertSpy.mock.calls.length > 0,
  });
  it('a pending navigation keeps the button disabled; a cancelled one releases it', async () => { await pendingNavigationKeepsButtonDisabled(nav()); });
  it('a rejected navigation does not alert that the delete failed', async () => { await rejectedNavigationIsNotAWriteFailure(nav()); });
});

describe('suppliers/[supplierId]/rules delete', () => {
  const rule = { id: 'r1', companyId: 'c1', supplierId: 's1', defaultGlAccountId: 'g1', defaultVatCode: 'ZERO_RATED', defaultCostCentreId: null, defaultProjectId: null,
    autoPublish: false, autoPublishMaxAmount: null, autoPublishMinConfidence: 0.8, requirePoMatch: false, qtyTolerancePct: 2, priceTolerancePct: 2,
    learnedSampleCount: 14, learnedFromLastCorrectionAt: null, updatedBy: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' };
  const confirmBtn = () => screen.getByText('Confirm delete?').parentElement!.querySelector('button') as HTMLButtonElement; // shows a spinner, not text, while deleting
  const nav = (): NavCase => ({
    push: route.push, warn, button: confirmBtn,
    drive: async () => {
      route.query = { supplierId: 's1' };
      serve(on('DELETE', 'supplier-rules/s1', () => ok({})), on('GET', 'suppliers-list', () => ok({ id: 's1', name: 'D2 Rule Supplier' })),
        on('GET', 'supplier-rules/s1', () => ok(rule)), on('GET', 'chart-of-accounts', () => ok([])), on('GET', 'cost-centres', () => ok({ items: [] })));
      render(<SupplierRulesPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'Delete rule' }));
      fireEvent.click(await screen.findByRole('button', { name: /Yes, delete/ }));
    },
    claimsFailure: () => screen.queryByText(/Could not delete the coding rule/) !== null,
  });
  it('a pending navigation keeps the button disabled; a cancelled one releases it', async () => { await pendingNavigationKeepsButtonDisabled(nav()); });
  it('a rejected navigation does not say the delete failed', async () => { await rejectedNavigationIsNotAWriteFailure(nav()); });
});

describe('reports/builder save', () => {
  const save = () => screen.getByRole('button', { name: /^(Save|Saving\.\.\.)$/ });
  const nav = (): NavCase => ({
    push: route.replace, warn, button: save,
    drive: () => {
      serve(on('POST', 'custom-reports', () => ok({ id: 'rep-1' })), (u) => (u.includes('fields') ? ok({ fields: [] }) : undefined));
      render(<BuilderPage />);
      fireEvent.click(screen.getByText('pick-source'));
      fireEvent.click(screen.getByText('add-col'));
      fireEvent.click(save());
    },
    claimsFailure: () => screen.queryByText(/Could not save the report/) !== null,
  });
  it('a pending navigation keeps the Save button disabled; a cancelled one releases it', async () => { await pendingNavigationKeepsButtonDisabled(nav()); });
  it('a rejected navigation does not say the report failed to save', async () => { await rejectedNavigationIsNotAWriteFailure(nav()); });
});

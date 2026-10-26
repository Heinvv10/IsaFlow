/**
 * ModuleSetupChecklist (master-plan W1 PR C): shows per-module progress, collapses a
 * complete module, and hides the whole card when everything is done or the load fails.
 * Real apiJson / assertOk over a scripted apiFetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, refuse } from '../helpers/d2R3a5';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { ModuleSetupChecklist } from '../../../src/components/accounting/dashboard/ModuleSetupChecklist';
import { buildSetupProgress, type SetupFacts } from '../../../src/modules/accounting/services/core/setupProgressService';

useApiJsonOverMock();
afterEach(cleanup);

const NONE: SetupFacts = {
  logo: false, registrationNumber: false, vatNumber: false, vatPeriodSet: false, payeReference: false,
  vatVendor: true, bankAccounts: 0, bankTransactions: 0, customers: 0, customerInvoices: 0, receipts: 0,
  suppliers: 0, supplierInvoices: 0, fiscalPeriods: 0, openingBalances: 0, employees: 0, payrollRuns: 0,
};
const serve = (facts: SetupFacts) => vi.mocked(apiFetch).mockReset().mockResolvedValue(ok(buildSetupProgress(facts)));

describe('ModuleSetupChecklist', () => {
  it('shows overall and per-module progress for a fresh company', async () => {
    serve(NONE);
    render(<ModuleSetupChecklist />);
    expect(await screen.findByText('0 of 12 done')).toBeTruthy();
    expect(screen.getByText('Sales').closest('button')!.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByText('0/3').length).toBe(2); // Sales and Payroll
    expect(screen.getByRole('link', { name: /Add a customer/ }).getAttribute('href')).toBe('/accounting/customers/new');
  });

  it('counts a finished task and collapses a complete module', async () => {
    serve({ ...NONE, customers: 1, customerInvoices: 1, receipts: 1 });
    render(<ModuleSetupChecklist />);
    expect(await screen.findByText('3 of 12 done')).toBeTruthy();
    const sales = screen.getByText('Sales').closest('button')!;
    expect(sales.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('Complete')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Add a customer/ })).toBeNull();
    fireEvent.click(sales);
    expect(screen.getByRole('link', { name: /Add a customer/ })).toBeTruthy();
  });

  it('hides the card when everything is done', async () => {
    serve({
      ...NONE, vatNumber: true, vatPeriodSet: true, payeReference: true, bankAccounts: 1, bankTransactions: 1,
      customers: 1, customerInvoices: 1, receipts: 1, suppliers: 1, supplierInvoices: 1, employees: 1, payrollRuns: 1,
    });
    const { container } = render(<ModuleSetupChecklist />);
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).toBeNull());
    expect(container.textContent).toBe('');
  });

  it('hides the card when the checklist cannot be loaded', async () => {
    vi.mocked(apiFetch).mockReset().mockResolvedValue(refuse());
    const { container } = render(<ModuleSetupChecklist />);
    await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).toBeNull());
    expect(container.textContent).toBe('');
  });
});

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
import { NO_FACTS as NONE, ALL_FACTS } from '../helpers/setupFacts';

useApiJsonOverMock();
afterEach(cleanup);

const serve = (facts: SetupFacts) => vi.mocked(apiFetch).mockReset().mockResolvedValue(ok(buildSetupProgress(facts)));

describe('ModuleSetupChecklist', () => {
  it('shows overall and per-module progress for a fresh company', async () => {
    serve(NONE);
    render(<ModuleSetupChecklist />);
    expect(await screen.findByText('0 of 8 done')).toBeTruthy();
    expect(screen.getByText('Sales').closest('button')!.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByText('0/3').length).toBe(1);
    expect(screen.getByRole('link', { name: /Add a customer/ }).getAttribute('href')).toBe('/accounting/customers/new');
  });

  it('counts a finished task and collapses a complete module', async () => {
    serve({ ...NONE, hasCustomers: true, hasCustomerInvoices: true, hasReceipts: true });
    render(<ModuleSetupChecklist />);
    expect(await screen.findByText('3 of 8 done')).toBeTruthy();
    const sales = screen.getByText('Sales').closest('button')!;
    expect(sales.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('Complete')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Add a customer/ })).toBeNull();
    fireEvent.click(sales);
    expect(screen.getByRole('link', { name: /Add a customer/ })).toBeTruthy();
  });

  it('hides the card when everything is done', async () => {
    serve(ALL_FACTS);
    const { container } = render(<ModuleSetupChecklist />);
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
    await Promise.resolve();
    expect(container.textContent).toBe('');
  });

  it('renders nothing while loading (no skeleton, so the page does not shift)', () => {
    vi.mocked(apiFetch).mockReset().mockReturnValue(new Promise(() => undefined));
    const { container } = render(<ModuleSetupChecklist />);
    expect(container.innerHTML).toBe('');
  });

  it('hides the card when the checklist cannot be loaded', async () => {
    vi.mocked(apiFetch).mockReset().mockResolvedValue(refuse());
    const { container } = render(<ModuleSetupChecklist />);
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(container.textContent).toBe('');
  });

  it('a done task keeps full text colour (an opacity class dropped the light theme below AA)', async () => {
    serve({ ...NONE, hasEmployees: true });
    render(<ModuleSetupChecklist />);
    const label = await screen.findByText('Add an employee');
    expect(label.className).toContain('line-through');
    expect(label.className).not.toMatch(/opacity/);
  });
});

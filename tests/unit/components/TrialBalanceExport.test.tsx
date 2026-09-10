import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/accounting/evidence/EvidenceDrillModal', () => ({ EvidenceDrillModal: () => null }));
vi.mock('@/contexts/TableDensityContext', () => ({ useTableDensity: () => ({ rowClass: '' }) }));
const { routerQuery } = vi.hoisted(() => ({ routerQuery: {} as Record<string, string> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: routerQuery, isReady: true }) }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '@/lib/apiFetch';
import TrialBalancePage from '@/../pages/accounting/trial-balance';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const key of Object.keys(routerQuery)) delete routerQuery[key];
});
describe('trial balance CSV selection', () => {
  it('exports the cost centre selected on screen and clears it when All is selected', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      const data = String(url).includes('cost-centres') ? { items: [{ id: 'cc2', code: 'PROJECT', name: 'Project' }] }
        : String(url).includes('business-units') ? { items: [{ id: 'bu1', code: 'OPS', name: 'Operations' }] }
        : String(url).includes('fiscal-periods') ? [{ id: 'period', periodName: 'April', startDate: '2026-04-01', endDate: '2026-04-30', status: 'open' }]
        : { rows: [{ accountCode: '5000', accountName: 'Expense', accountType: 'expense', debitBalance: 17, creditBalance: 0 }], totalDebit: 17, totalCredit: 0, difference: 17, balanced: false };
      return new Response(JSON.stringify({ data }), {status: 200});
    });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<TrialBalancePage />);
    const select = await screen.findByDisplayValue('All Cost Centres');
    const businessUnit = await screen.findByDisplayValue('All Business Units');
    await screen.findByRole('option', {name: 'PROJECT — Project'});
    fireEvent.change(select, {target: {value:'cc2'}});
    fireEvent.change(businessUnit, {target: {value:'bu1'}});
    await waitFor(() => expect(screen.getByRole('button', {name:'Export CSV'})).toBeEnabled());
    fireEvent.click(screen.getByRole('button', {name:'Export CSV'}));
    expect(open).toHaveBeenLastCalledWith('/api/accounting/trial-balance-export?fiscal_period_id=period&cost_centre_id=cc2&business_unit_id=bu1', '_blank');
    fireEvent.change(select, {target: {value:''}});
    fireEvent.change(businessUnit, {target: {value:''}});
    await waitFor(() => expect(screen.getByRole('button', {name:'Export CSV'})).toBeEnabled());
    fireEvent.click(screen.getByRole('button', {name:'Export CSV'}));
    expect(open).toHaveBeenLastCalledWith('/api/accounting/trial-balance-export?fiscal_period_id=period', '_blank');
  });

  it('keeps a restored business-unit filter visible when reference data fails to load', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url).includes('business-units')) return new Response('{}', { status: 503 });
      const data = String(url).includes('cost-centres') ? []
        : String(url).includes('fiscal-periods') ? [{ id: 'period', periodName: 'April', startDate: '2026-04-01', endDate: '2026-04-30', status: 'open' }]
        : { rows: [], totalDebit: 0, totalCredit: 0, difference: 0, balanced: true };
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    routerQuery.business_unit_id = 'bu-restored';

    render(<TrialBalancePage />);

    expect(await screen.findByRole('option', { name: 'Selected Business Unit (unavailable)' })).toBeTruthy();
    expect(screen.getByDisplayValue('Selected Business Unit (unavailable)')).toBeTruthy();
  });
});

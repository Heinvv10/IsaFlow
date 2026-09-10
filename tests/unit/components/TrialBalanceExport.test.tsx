import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/accounting/evidence/EvidenceDrillModal', () => ({ EvidenceDrillModal: () => null }));
vi.mock('@/contexts/TableDensityContext', () => ({ useTableDensity: () => ({ rowClass: '' }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true }) }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '@/lib/apiFetch';
import TrialBalancePage from '@/../pages/accounting/trial-balance';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('trial balance CSV selection', () => {
  it('exports the cost centre selected on screen and clears it when All is selected', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      const data = String(url).includes('cost-centres') ? { items: [{ id: 'cc2', code: 'PROJECT', name: 'Project' }] }
        : String(url).includes('fiscal-periods') ? [{ id: 'period', periodName: 'April', startDate: '2026-04-01', endDate: '2026-04-30', status: 'open' }]
        : { rows: [{ accountCode: '5000', accountName: 'Expense', accountType: 'expense', debitBalance: 17, creditBalance: 0 }], totalDebit: 17, totalCredit: 0, difference: 17, balanced: false };
      return new Response(JSON.stringify({ data }), {status: 200});
    });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<TrialBalancePage />);
    const select = await screen.findByDisplayValue('All Cost Centres');
    await screen.findByRole('option', {name: 'PROJECT — Project'});
    fireEvent.change(select, {target: {value:'cc2'}});
    await waitFor(() => expect(screen.getByRole('button', {name:'Export CSV'})).toBeEnabled());
    fireEvent.click(screen.getByRole('button', {name:'Export CSV'}));
    expect(open).toHaveBeenLastCalledWith('/api/accounting/trial-balance-export?fiscal_period_id=period&cost_centre_id=cc2', '_blank');
    fireEvent.change(select, {target: {value:''}});
    await waitFor(() => expect(screen.getByRole('button', {name:'Export CSV'})).toBeEnabled());
    fireEvent.click(screen.getByRole('button', {name:'Export CSV'}));
    expect(open).toHaveBeenLastCalledWith('/api/accounting/trial-balance-export?fiscal_period_id=period', '_blank');
  });
});

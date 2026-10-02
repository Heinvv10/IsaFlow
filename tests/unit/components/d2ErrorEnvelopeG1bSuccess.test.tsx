/**
 * D2 (group 1b) SUCCESS paths: a 200 `{ success:true, data }` envelope is rendered on the financial-years and
 * group-eliminations pages. The real apiJson / assertOk / apiErrorMessage run on top of the mocked apiFetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1' } }) }));

import { apiFetch } from '@/lib/apiFetch';
import FinancialYearsPage from '../../../pages/accounting/financial-years/index';
import EliminationsPage from '../../../pages/accounting/group/eliminations';

useApiJsonOverMock();
afterEach(() => { cleanup(); });

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const sees = async (text: string) => { expect(await screen.findByText(text)).toBeTruthy(); };

describe('D2 success envelope is honoured (group 1b)', () => {
  it('success: financial years renders the data it received', async () => {
    const period = { id: 'p1', periodName: 'Pelican Period', periodNumber: 1, fiscalYear: 2031,
      startDate: '2031-01-01', endDate: '2031-01-31', status: 'open', createdAt: '2031-01-01', updatedAt: '2031-01-01' };
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) =>
      ok(String(url).includes('jeCounts') ? {} : [period]));
    render(<FinancialYearsPage />);
    await sees('FY 2031');
  });

  it('success: group eliminations renders the data it received', async () => {
    const item = { id: 'e1', adjustmentNumber: 'ELM-8842', adjustmentType: 'interco_revenue', description: 'Heron Sales', periodStart: '2026-01-31', periodEnd: '2026-01-31', status: 'draft', lines: [{ debit: 100, credit: 0 }] };
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) =>
      ok(String(url).includes('company-groups') ? { items: [{ id: 'g1', name: 'Group One' }] } : { items: [item] }));
    render(<EliminationsPage />);
    await sees('ELM-8842');
  });
});

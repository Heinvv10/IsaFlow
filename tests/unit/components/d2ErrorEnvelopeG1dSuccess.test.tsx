/**
 * D2 (group 1d) SUCCESS path: the asset detail page renders the data of a 200 `{ success:true, data }` envelope
 * and the disposal completes. The real apiJson / assertOk / apiErrorMessage run on top of the mocked apiFetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { assetId: 'as-1' }, push: nav.push }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/assets/AssetDualTrackPanel', () => ({ AssetDualTrackPanel: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import AssetDetailPage from '../../../pages/accounting/assets/[assetId]';

useApiJsonOverMock();
afterEach(() => { cleanup(); nav.push.mockReset(); });

const ASSET = {
  id: 'as-1', asset_number: 'A-0001', name: 'Forklift Okapi', category: 'Plant', purchase_date: '2024-01-01',
  purchase_price: 120000, current_book_value: 90000, useful_life_years: 5, status: 'active', location: null,
  serial_number: null, supplier_name: null, sars_category: null, sars_rate: null, tax_life: null,
  created_at: '2024-01-01', salvage_value: 0, depreciation_method: 'straight_line',
};
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

describe('D2 success envelope is honoured (group 1d)', () => {
  it('success: asset detail renders the data it received', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => ok([ASSET]));
    render(<AssetDetailPage />);
    expect(await screen.findByText('Forklift Okapi')).toBeTruthy();
  });

  it('success: asset disposal completes', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) =>
      String(url).includes('/dispose') ? new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }) : ok([ASSET]));
    render(<AssetDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /dispose asset/i }));
    fireEvent.click(await screen.findByRole('button', { name: /confirm disposal/i }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/accounting/assets'));
  });
});

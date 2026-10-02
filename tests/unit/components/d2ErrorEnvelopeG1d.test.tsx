/**
 * D2 (group 1d): the asset disposal form shows the server's real error envelope message
 * `{ success:false, error:{ code, message } }` — for an HTTP refusal and for a 200 body with success:false.
 * The real apiJson / assertOk / apiErrorMessage run on top of the mocked apiFetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { assetId: 'as-1' }, push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/assets/AssetDualTrackPanel', () => ({ AssetDualTrackPanel: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import AssetDetailPage from '../../../pages/accounting/assets/[assetId]';

useApiJsonOverMock();
afterEach(() => { cleanup(); });

const ASSET = {
  id: 'as-1', asset_number: 'A-0001', name: 'Forklift', category: 'Plant', purchase_date: '2024-01-01',
  purchase_price: 120000, current_book_value: 90000, useful_life_years: 5, status: 'active', location: null,
  serial_number: null, supplier_name: null, sars_category: null, sars_rate: null, tax_life: null,
  created_at: '2024-01-01', salvage_value: 0, depreciation_method: 'straight_line',
};

async function openDisposalAndConfirm(dispose: () => Response) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) =>
    String(url).includes('/dispose') ? dispose()
      : new Response(JSON.stringify({ success: true, data: [ASSET] }), { status: 200 }));
  render(<AssetDetailPage />);
  fireEvent.click(await screen.findByRole('button', { name: /dispose asset/i }));
  fireEvent.click(await screen.findByRole('button', { name: /confirm disposal/i }));
}

describe('asset disposal: refusal message reaches the user', () => {
  it('shows the server message of an HTTP refusal', async () => {
    const MSG = 'D2 server says no: asset is already disposed';
    await openDisposalAndConfirm(() => new Response(
      JSON.stringify({ success: false, error: { code: 'CONFLICT', message: MSG } }), { status: 409 }));
    expect(await screen.findByText(MSG)).toBeTruthy();
  });

  it('shows the server message of a 200 body carrying success:false', async () => {
    const MSG = 'D2 server says no: disposal journal was not posted';
    await openDisposalAndConfirm(() => new Response(
      JSON.stringify({ success: false, error: { code: 'POST_FAILED', message: MSG } }), { status: 200 }));
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
});

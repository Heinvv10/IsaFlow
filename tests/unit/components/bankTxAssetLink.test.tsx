/**
 * The bank transactions screen's asset / fleet link (mig 853): the row chip, and the picker posting the body each
 * link route takes — the asset itself, a fuel or service record of it, or an unlink (null id) to the route of the
 * kind the line carries. A refused link shows the server's sentence.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { BankTxLinkModal } from '@/components/accounting/bank-transactions/BankTxLinkModal';
import { BankTxLinkAction } from '@/components/accounting/bank-transactions/BankTxLinkAction';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/utils/toast', () => ({ notify: { success: vi.fn(), error: vi.fn() } }));
useApiJsonOverMock();

const TX = { id: 'bt-1', description: 'ENGEN', amount: -850, transactionDate: '2026-10-01' };
const ASSET = { id: 'as-1', name: 'Hilux', asset_number: 'FA-1' };
const FUEL = { id: 'fu-1', assetId: 'as-1', fillDate: '2026-10-01', litres: 40, amount: 850, odometerKm: null,
  supplierName: null, notes: null, createdAt: '', bankLinkCount: 0 };
const SERVICE = { id: 'sv-1', assetId: 'as-1', serviceDate: '2026-09-01', description: 'Brakes', amount: 1200, odometerKm: null,
  supplierName: null, notes: null, createdAt: '', bankLinkCount: 0 };

const posts: { url: string; body: unknown }[] = [];
function serve(linkReply: [number, unknown] = [200, { success: true, data: {} }]): void {
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const u = String(url);
    if (init?.method === 'POST') {
      posts.push({ url: u, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(linkReply[1]), { status: linkReply[0] });
    }
    if (u.startsWith('/api/accounting/assets/as-1/fuel')) return new Response(JSON.stringify({ success: true, data: [FUEL] }));
    if (u.startsWith('/api/accounting/assets/as-1/service')) return new Response(JSON.stringify({ success: true, data: [SERVICE] }));
    return new Response(JSON.stringify({ success: true, data: [ASSET] }));
  });
}

beforeEach(() => { vi.mocked(apiFetch).mockReset(); posts.length = 0; });
afterEach(cleanup);

async function pickAsset() {
  fireEvent.click(await screen.findByRole('button', { name: /Hilux/ }));
  await screen.findByText(/Fuel 2026-10-01/);
}

it('links the asset itself by default', async () => {
  serve(); const onDone = vi.fn();
  render(<BankTxLinkModal tx={TX} onClose={vi.fn()} onDone={onDone} />);
  await pickAsset();
  fireEvent.click(screen.getByRole('button', { name: 'Link' }));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(posts).toEqual([{ url: '/api/accounting/bank-match-asset', body: { bankTransactionId: 'bt-1', assetId: 'as-1' } }]);
});

it('links a fuel record, and a service record, through the fleet route', async () => {
  serve(); const onDone = vi.fn();
  render(<BankTxLinkModal tx={TX} onClose={vi.fn()} onDone={onDone} />);
  await pickAsset();
  fireEvent.click(screen.getByRole('radio', { name: /Fuel 2026-10-01/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Link' }));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('radio', { name: /Service 2026-09-01/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Link' }));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(2));
  expect(posts.map((p) => p.body)).toEqual([
    { bankTransactionId: 'bt-1', fleetEntityType: 'fuel', fleetEntityId: 'fu-1' },
    { bankTransactionId: 'bt-1', fleetEntityType: 'service', fleetEntityId: 'sv-1' },
  ]);
  expect(new Set(posts.map((p) => p.url))).toEqual(new Set(['/api/accounting/bank-match-fleet']));
});

it('unlinks through the route of the kind the line carries', async () => {
  serve(); const onDone = vi.fn();
  render(<BankTxLinkModal tx={{ ...TX, link: { kind: 'service', id: 'sv-1', assetName: 'Hilux', label: 'Brakes' } }}
    onClose={vi.fn()} onDone={onDone} />);
  expect(screen.getByText('Linked: Hilux — Brakes')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(posts).toEqual([{ url: '/api/accounting/bank-match-fleet',
    body: { bankTransactionId: 'bt-1', fleetEntityType: 'service', fleetEntityId: null } }]);
});

it('shows the server sentence when a link is refused, and stays open', async () => {
  serve([409, { success: false, error: { code: 'CONFLICT', message: 'Bank transaction bt-1 is still pending at the bank — you can link it once it posts.' } }]);
  const onDone = vi.fn();
  render(<BankTxLinkModal tx={TX} onClose={vi.fn()} onDone={onDone} />);
  await pickAsset();
  fireEvent.click(screen.getByRole('button', { name: 'Link' }));
  expect(await screen.findByText(/still pending at the bank/)).toBeTruthy();
  expect(onDone).not.toHaveBeenCalled();
});

it('the row action is a button when unlinked and a labelled chip when linked', () => {
  const onOpen = vi.fn();
  const { rerender } = render(<BankTxLinkAction onOpen={onOpen} />);
  fireEvent.click(screen.getByRole('button', { name: 'Link to asset / fuel / service' }));
  rerender(<BankTxLinkAction onOpen={onOpen} link={{ kind: 'fuel', id: 'fu-1', assetName: 'Hilux', label: 'Fuel 2026-10-01 R850.00' }} />);
  expect(screen.getByText('Fuel 2026-10-01 R850.00')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Linked to Hilux — Fuel 2026-10-01 R850.00' }));
  expect(onOpen).toHaveBeenCalledTimes(2);
});

// Round 2 (blind L2): a slower, OLDER response must not overwrite a newer one — the records shown, and so the record id
// a link posts, belong to the asset (and the search) the user picked last.
function deferredServe() {
  const pending = new Map<string, (body: unknown) => void>();
  vi.mocked(apiFetch).mockImplementation((url) => new Promise((resolve) => {
    pending.set(String(url), (data) => resolve(new Response(JSON.stringify({ success: true, data }))));
  }));
  const settle = async (url: string, data: unknown) => {
    await waitFor(() => expect(pending.has(url)).toBe(true));
    pending.get(url)!(data); pending.delete(url);
  };
  return { settle };
}
const ASSET_B = { id: 'as-2', name: 'Ranger', asset_number: 'FA-2' };
const FUEL_B = { ...FUEL, id: 'fu-2', assetId: 'as-2', fillDate: '2026-09-09' };

it('records of an earlier-picked asset that answer late are ignored', async () => {
  const { settle } = deferredServe();
  render(<BankTxLinkModal tx={TX} onClose={vi.fn()} onDone={vi.fn()} />);
  await settle('/api/accounting/assets', [ASSET, ASSET_B]);
  fireEvent.click(await screen.findByRole('button', { name: /Hilux/ }));
  fireEvent.click(screen.getByRole('button', { name: /Ranger/ }));
  await settle('/api/accounting/assets/as-2/fuel', [FUEL_B]);
  await settle('/api/accounting/assets/as-2/service', []);
  expect(await screen.findByText(/Fuel 2026-09-09/)).toBeTruthy();
  await settle('/api/accounting/assets/as-1/fuel', [FUEL]);
  await settle('/api/accounting/assets/as-1/service', [SERVICE]);
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByText(/Fuel 2026-10-01/)).toBeNull();
  expect(screen.queryByText(/Service 2026-09-01/)).toBeNull();
  expect(screen.getByText(/Fuel 2026-09-09/)).toBeTruthy();
});

it('an older search that answers late does not replace a newer one', async () => {
  const { settle } = deferredServe();
  render(<BankTxLinkModal tx={TX} onClose={vi.fn()} onDone={vi.fn()} />);
  await settle('/api/accounting/assets', [ASSET, ASSET_B]);
  const box = await screen.findByPlaceholderText('Search by name, number or serial');
  fireEvent.change(box, { target: { value: 'Hil' } });
  await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([u]) => String(u).endsWith('search=Hil'))).toBe(true));
  fireEvent.change(box, { target: { value: 'Ran' } });
  await settle('/api/accounting/assets?search=Ran', [ASSET_B]);
  expect(await screen.findByRole('button', { name: /Ranger/ })).toBeTruthy();
  await settle('/api/accounting/assets?search=Hil', [ASSET]);
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByRole('button', { name: /Hilux/ })).toBeNull();
  expect(screen.getByRole('button', { name: /Ranger/ })).toBeTruthy();
});

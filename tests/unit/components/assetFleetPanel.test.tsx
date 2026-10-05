/**
 * The asset page's fleet panel (mig 853): Fuel / Service tabs list, add (the route's body) and delete records; a
 * record a bank line links to cannot be deleted; a refused delete shows the server's sentence; the Linked bank
 * transactions tab lists what the asset and its records are linked from.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { AssetFleetPanel } from '@/components/assets/AssetFleetPanel';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/utils/toast', () => ({ notify: { success: vi.fn(), error: vi.fn() } }));
useApiJsonOverMock();

const FUEL = [
  { id: 'fu-1', assetId: 'as-1', fillDate: '2026-10-01', litres: 40, amount: 850, odometerKm: 1000, supplierName: 'Engen',
    notes: null, createdAt: '', bankLinkCount: 1 },
  { id: 'fu-2', assetId: 'as-1', fillDate: '2026-09-01', litres: 30, amount: 600, odometerKm: null, supplierName: null,
    notes: null, createdAt: '', bankLinkCount: 0 },
];
const LINE = { id: 'bt-1', bankAccountId: 'ba-1', bankAccountName: 'FNB Cheque', transactionDate: '2026-10-01', amount: -850,
  description: 'ENGEN', status: 'imported', kind: 'fuel',
  link: { kind: 'fuel', id: 'fu-1', assetId: 'as-1', assetName: 'Hilux', label: 'Fuel 2026-10-01 R850.00' } };

const writes: { method: string; url: string; body?: unknown }[] = [];
function serve(deleteReply: [number, unknown] = [200, { success: true, data: { deleted: true, id: 'fu-2' } }]): void {
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (method === 'POST') { writes.push({ method, url: u, body: JSON.parse(String(init!.body)) }); return new Response(JSON.stringify({ success: true, data: FUEL[1] }), { status: 201 }); }
    if (method === 'DELETE') { writes.push({ method, url: u }); return new Response(JSON.stringify(deleteReply[1]), { status: deleteReply[0] }); }
    if (u.endsWith('/bank-links')) return new Response(JSON.stringify({ success: true, data: [LINE] }));
    return new Response(JSON.stringify({ success: true, data: u.endsWith('/fuel') ? FUEL : [] }));
  });
}

beforeEach(() => { vi.mocked(apiFetch).mockReset(); writes.length = 0; });
afterEach(cleanup);

it('lists the fuel records; a linked record cannot be deleted', async () => {
  serve();
  render(<AssetFleetPanel assetId="as-1" />);
  expect(await screen.findByText('40 L')).toBeTruthy();
  const del = screen.getAllByRole('button', { name: 'Delete' });
  expect((del[0] as HTMLButtonElement).disabled).toBe(true);
  expect(del[0]!.getAttribute('title')).toMatch(/unlink it first/);
  expect((del[1] as HTMLButtonElement).disabled).toBe(false);
});

it('adds a fuel record with the route body (blank optionals left out)', async () => {
  serve();
  render(<AssetFleetPanel assetId="as-1" />);
  await screen.findByText('40 L');
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-10-03' } });
  fireEvent.change(screen.getByLabelText('Litres'), { target: { value: '45.5' } });
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '910.25' } });
  fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: ' Shell ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toEqual({ method: 'POST', url: '/api/accounting/assets/as-1/fuel',
    body: { fillDate: '2026-10-03', litres: 45.5, amount: 910.25, supplierName: 'Shell' } });
});

it('a refused delete shows the server sentence', async () => {
  serve([409, { success: false, error: { code: 'CONFLICT', message: 'A bank transaction is linked to this fuel record — unlink it on the bank transaction first.' } }]);
  render(<AssetFleetPanel assetId="as-1" />);
  await screen.findByText('40 L');
  fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[1]!);
  expect(await screen.findByText(/unlink it on the bank transaction first/)).toBeTruthy();
  expect(writes).toEqual([{ method: 'DELETE', url: '/api/accounting/assets/as-1/fuel?id=fu-2' }]);
});

it('the service tab posts a description; the bank tab lists the linked lines', async () => {
  serve();
  render(<AssetFleetPanel assetId="as-1" />);
  fireEvent.click(screen.getByRole('tab', { name: /Service/ }));
  expect(await screen.findByText('No service records yet')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Brakes' } });
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '1200' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]!.url).toBe('/api/accounting/assets/as-1/service');
  expect(writes[0]!.body).toMatchObject({ description: 'Brakes', amount: 1200 });

  fireEvent.click(screen.getByRole('tab', { name: /Linked bank transactions/ }));
  expect(await screen.findByText('ENGEN')).toBeTruthy();
  expect(screen.getByText('Fuel 2026-10-01 R850.00')).toBeTruthy();
  expect(screen.getByText('FNB Cheque')).toBeTruthy();
});

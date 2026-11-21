/**
 * #1654: pages that save from a plain onClick (no <form> submit, so the browser's own check never runs) must not send
 * a field that holds a lone "." or another refused draft: parseFloat('.') / Number('.') are NaN, which became "no cap",
 * NaN prices, or a silent old value. useAmountGuard blocks the save and shows the field's message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2R3a4';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
const route = vi.hoisted(() => ({ query: {} as Record<string, string>, push: vi.fn(), isReady: true }));
vi.mock('next/router', () => ({ useRouter: () => route }));
const company = vi.hoisted(() => ({ activeCompany: { id: 'co-1', name: 'Co' } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => company, useCompanyRoleOrNull: () => 'owner' }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/ui', async (original) => ({ ...await original<typeof import('@/components/ui')>(), KpiStrip: () => null }));

vi.mock('@/components/assets/AssetDualTrackPanel', () => ({ AssetDualTrackPanel: () => null }));
vi.mock('@/components/assets/AssetFleetPanel', () => ({ AssetFleetPanel: () => null }));
import { apiFetch } from '@/lib/apiFetch';
import SupplierRulesPage from '../../../pages/accounting/suppliers/[supplierId]/rules';
import ItemPricingPage from '../../../pages/accounting/item-pricing';
import ItemOpeningBalancesPage from '../../../pages/accounting/item-opening-balances';
import OpeningBalancesPage from '../../../pages/accounting/opening-balances/index';
import PoEditPage from '../../../pages/accounting/purchase-orders/[poId]';
import StaffCostRatesPage from '../../../pages/accounting/practice/staff-cost-rates/index';
import AssetPage from '../../../pages/accounting/assets/[assetId]';
import JobPage from '../../../pages/accounting/practice/jobs/[id]';
import { ApprovalStarterPanel } from '@/components/accounting/approvals/ApprovalStarterPanel';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
const writes: string[] = [];
const ITEM = { id: 'i1', item_code: 'D2-001', name: 'Widget', item_name: 'Widget', category: 'c', uom: 'ea', selling_price: 10, cost_price: 5, quantity_on_hand: 3, current_quantity: 3 };
beforeEach(() => { writes.length = 0; route.query = {}; vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });
const serve = (get: (u: string) => unknown) => vi.mocked(apiFetch).mockImplementation(async (u, init) => {
  if (init?.method && init.method !== 'GET') { writes.push(String(init.body)); return ok({}); }
  return ok(get(String(u)));
});
const firstAmount = async () => { await waitFor(() => expect(document.querySelector('input[data-amount-input]')).toBeTruthy()); return document.querySelector('input[data-amount-input]') as HTMLInputElement; };

describe('a lone "." never reaches a save', () => {
  it('supplier rules: "." in the cap is not saved as "no cap"', async () => {
    route.query = { supplierId: 's1' };
    serve((u) => (u.includes('suppliers-list') ? { id: 's1', name: 'Acme' } : []));
    render(<SupplierRulesPage />);
    const cap = await screen.findByPlaceholderText('No cap') as HTMLInputElement;
    fireEvent.change(cap, { target: { value: '.' } });
    fireEvent.click(await screen.findByRole('button', { name: /Create rule|Save changes/ }));
    expect(writes).toEqual([]);
    expect(cap.validity.valid).toBe(false);
  });

  it('item pricing: "." is not saved as NaN', async () => {
    serve(() => [ITEM]);
    render(<ItemPricingPage />);
    fireEvent.change(await firstAmount(), { target: { value: '.' } });
    fireEvent.click(await screen.findByRole('button', { name: /Save \(1\)/ }));
    expect(writes).toEqual([]);
  });

  it('item opening balances: "." is not saved as NaN', async () => {
    serve(() => [ITEM]);
    render(<ItemOpeningBalancesPage />);
    fireEvent.change(await firstAmount(), { target: { value: '.' } });
    fireEvent.click(await screen.findByRole('button', { name: /Save \(1\)/ }));
    expect(writes).toEqual([]);
  });

  it('opening balances: "." in a debit blocks the save', async () => {
    serve(() => ({ accounts: [{ id: 'a1', account_code: '1000', account_name: 'Bank', account_type: 'asset', normal_balance: 'debit', opening_debit: 0, opening_credit: 0 }] }));
    render(<OpeningBalancesPage />);
    fireEvent.change(await firstAmount(), { target: { value: '.' } });
    fireEvent.click(await screen.findByRole('button', { name: /Save Opening Balances/ }));
    expect(writes).toEqual([]);
  });

  it('approval starter panel: "." in an amount blocks Create', async () => {
    serve(() => []);
    render(<ApprovalStarterPanel actorRole="owner" rules={[]} onCreated={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getAllByLabelText(/^Amount for/)[0]!, { target: { value: '.' } });
    fireEvent.click(screen.getByRole('button', { name: /create|add|confirm/i }));
    expect(writes).toEqual([]);
  });

  it('purchase order edit: "." in a unit price is not saved as a null price', async () => {
    route.query = { poId: 'po1' };
    const PO = { id: 'po1', po_number: 'PO-1', status: 'draft', supplier_id: 's1', supplier_name: 'Acme', order_date: '2026-10-01', expected_delivery_date: null,
      items: [{ id: 'l1', description: 'Cable', quantity: '1', unit_price: '5', tax_rate: '15', gl_account_id: '', product_id: '', cc1_id: '', cc2_id: '', bu_id: '' }] };
    serve((u) => (/purchase-orders\/po1/.test(u) ? PO : []));
    render(<PoEditPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Edit$/ }));
    const el = await screen.findByLabelText('Line 1 unit price') as HTMLInputElement;
    fireEvent.change(el, { target: { value: '.' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    expect(writes).toEqual([]);
    expect(el.validity.valid).toBe(false);
  });

  it('staff cost rates: a refused paste after a valid rate blocks Add instead of resending the old rate', async () => {
    serve((u) => (u.includes('/users') ? [{ id: 'u1', displayName: 'Ann' }] : []));
    render(<StaffCostRatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /add/i }));
    const rate = await screen.findByPlaceholderText('0.00') as HTMLInputElement;
    await waitFor(() => expect(screen.getByRole('option', { name: /Ann/ })).toBeTruthy());
    fireEvent.change(screen.getByText('Staff member *').parentElement!.querySelector('select')!, { target: { value: 'u1' } });
    const from = screen.getByLabelText(/^Effective from/);
    fireEvent.change(from, { target: { value: '1 Mar 2026' } }); fireEvent.blur(from);
    fireEvent.change(rate, { target: { value: '10' } });
    fireEvent.change(rate, { target: { value: '10abc' } }); // refused: the field keeps 10 and flags it
    expect(rate.value).toBe('10');
    expect(rate.getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(screen.getAllByRole('button', { name: /add/i }).at(-1)!);
    expect(writes).toEqual([]);
  });

  it('asset disposal: "." in the amount is not posted as proceeds of 0', async () => {
    route.query = { assetId: 'a1' };
    serve(() => [{ id: 'a1', name: 'Truck', asset_number: 'A-1', status: 'available' }]);
    render(<AssetPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Dispose Asset/ }));
    const el = document.querySelector('input[name="disposal_amount"]') as HTMLInputElement;
    fireEvent.change(el, { target: { value: '.' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Dispose/ }).at(-1)!);
    expect(writes).toEqual([]);
    expect(el.validity.valid).toBe(false);
  });

  it('jobs/[id]: "." in the fixed fee is not saved as 0', async () => {
    route.query = { id: 'j1' };
    serve((u) => (u.includes('/practice/jobs/j1') ? { id: 'j1', jobNumber: 'J-1', name: 'Audit', status: 'new', fixedFeeAmount: null, budgetAmount: null, budgetedHours: null, tags: [] } : []));
    render(<JobPage />);
    const fee = await waitFor(() => screen.getByText('Fixed Fee (R)').parentElement!.querySelector('input') as HTMLInputElement);
    fireEvent.change(fee, { target: { value: '.' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    expect(writes).toEqual([]);
  });
});

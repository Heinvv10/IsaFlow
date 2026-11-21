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
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => company }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/ui', async (original) => ({ ...await original<typeof import('@/components/ui')>(), KpiStrip: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import SupplierRulesPage from '../../../pages/accounting/suppliers/[supplierId]/rules';
import ItemPricingPage from '../../../pages/accounting/item-pricing';
import ItemOpeningBalancesPage from '../../../pages/accounting/item-opening-balances';
import OpeningBalancesPage from '../../../pages/accounting/opening-balances/index';
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
});

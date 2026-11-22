/**
 * #1654: each converted money field takes exactly as many decimals as the column it is stored in
 * (loans numeric(18,2), products/assets/items numeric(15,2), practice cost rate numeric(18,4), PO unit price numeric(19,6)),
 * so nothing is typed that the database would round. Per field: the stored-scale text is kept, one more decimal is refused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2R3a4';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
const route = vi.hoisted(() => ({ query: {} as Record<string, string>, push: vi.fn(), isReady: true }));
vi.mock('next/router', () => ({ useRouter: () => route }));
const company = vi.hoisted(() => ({ activeCompany: { id: 'co-1' } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => company }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

vi.mock('@/components/assets/AssetDualTrackPanel', () => ({ AssetDualTrackPanel: () => null }));
vi.mock('@/components/assets/AssetFleetPanel', () => ({ AssetFleetPanel: () => null }));
import { apiFetch } from '@/lib/apiFetch';
import LoansNewPage from '../../../pages/accounting/loans/new';
import ProductsNewPage from '../../../pages/accounting/products/new';
import JobsNewPage from '../../../pages/accounting/practice/jobs/new';
import AssetPage from '../../../pages/accounting/assets/[assetId]';
import JobPage from '../../../pages/accounting/practice/jobs/[id]';
import SupplierRulesPage from '../../../pages/accounting/suppliers/[supplierId]/rules';
import { PoLineItemsEditor } from '@/components/accounting/purchase-orders/PoLineItemsEditor';
import { ApprovalStarterPanel } from '@/components/accounting/approvals/ApprovalStarterPanel';
import StaffRatesPage from '../../../pages/accounting/practice/staff-rates/index';
import StaffCostRatesPage from '../../../pages/accounting/practice/staff-cost-rates/index';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); route.push.mockReset(); vi.mocked(apiFetch).mockImplementation(async () => ok([])); });
afterEach(() => { cleanup(); });

/** Types `good` (a value at the column's scale): it is kept; one more decimal is refused. */
async function atScale(get: () => HTMLElement, good: string, tooMany: string) {
  await waitFor(() => expect(get()).toBeTruthy());
  const el = get() as HTMLInputElement;
  fireEvent.focus(el);
  let acc = '';
  for (const ch of good) { acc += ch; fireEvent.change(el, { target: { value: acc } }); }
  expect(el.value).toBe(good);
  fireEvent.change(el, { target: { value: tooMany } });
  expect(el.value).toBe(good);
  expect(el.getAttribute('aria-invalid')).toBe('true');
}
const byName = (n: string) => () => document.querySelector(`input[name="${n}"]`) as HTMLElement;

describe('decimals equal the stored column scale', () => {
  it('loans/new: principal, residual, origination fee are numeric(18,2)', async () => {
    render(<LoansNewPage />);
    await atScale(() => screen.getByPlaceholderText('1000000.00'), '1234.56', '1234.567');
    const zeros = () => screen.getAllByPlaceholderText('0.00');
    await atScale(() => zeros()[0]!, '10.25', '10.255'); // residual
    await atScale(() => zeros()[1]!, '5.50', '5.505'); // origination fee
  });

  it('products/new: cost and selling price are numeric(15,2)', async () => {
    render(<ProductsNewPage />);
    await atScale(byName('costPrice'), '12.34', '12.345');
    await atScale(byName('sellingPrice'), '99.99', '99.999');
  });

  it('practice jobs/new: fixed fee and budget are numeric(18,2)', async () => {
    render(<JobsNewPage />);
    await atScale(() => screen.getAllByPlaceholderText('0.00')[0]!, '1500.50', '1500.505');
    await atScale(() => screen.getByPlaceholderText('No budget'), '20000.10', '20000.105');
  });

  it('practice staff-rates: rate is numeric(12,2)', async () => {
    render(<StaffRatesPage />);
    const add = (await screen.findAllByRole('button', { name: /add|new|set/i }))[0];
    if (add) fireEvent.click(add);
    await atScale(() => screen.getByPlaceholderText('e.g. 850.00'), '850.25', '850.255');
  });

  it('practice staff-cost-rates: cost rate is numeric(18,4)', async () => {
    render(<StaffCostRatesPage />);
    const add = (await screen.findAllByRole('button', { name: /add|new|set/i }))[0];
    if (add) fireEvent.click(add);
    await atScale(() => screen.getByText('Cost rate/hr *').parentElement!.querySelector('input') as HTMLElement, '425.1234', '425.12345');
  });

  it('assets/[assetId]: disposal amount is numeric(15,2)', async () => {
    route.query = { assetId: 'a1' };
    vi.mocked(apiFetch).mockImplementation(async () => ok([{ id: 'a1', name: 'Truck', asset_number: 'A-1', status: 'available' }]));
    render(<AssetPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Dispose Asset/ }));
    await atScale(byName('disposal_amount'), '15000.75', '15000.755');
    route.query = {};
  });

  it('practice jobs/[id]: fixed fee and budget are numeric(18,2); clearing sends null', async () => {
    route.query = { id: 'j1' };
    vi.mocked(apiFetch).mockImplementation(async (u) => String(u).includes('/practice/jobs/j1') ? ok({ id: 'j1', jobNumber: 'J-1', name: 'Audit', status: 'new', fixedFeeAmount: null, budgetAmount: null, budgetedHours: null, tags: [] }) : ok([]));
    render(<JobPage />);
    await atScale(() => screen.getByText('Fixed Fee (R)').parentElement!.querySelector('input') as HTMLElement, '2500.40', '2500.405');
    await atScale(() => screen.getByText('Engagement Budget (R)').parentElement!.querySelector('input') as HTMLElement, '9000.10', '9000.105');
    route.query = {};
  });

  it('practice jobs/[id]: a stored 0 shows as 0, a negative is below the minimum, clearing is null', async () => {
    route.query = { id: 'j1' };
    vi.mocked(apiFetch).mockImplementation(async (u) => String(u).includes('/practice/jobs/j1') ? ok({ id: 'j1', jobNumber: 'J-1', name: 'Audit', status: 'new', fixedFeeAmount: 0, budgetAmount: null, budgetedHours: null, tags: [] }) : ok([]));
    render(<JobPage />);
    const fee = await waitFor(() => screen.getByText('Fixed Fee (R)').parentElement!.querySelector('input') as HTMLInputElement);
    expect(fee.value).toBe('0');
    expect(screen.getByText('Engagement Budget (R)').parentElement!.querySelector('input')!.value).toBe('');
    fireEvent.change(fee, { target: { value: '' } });
    expect(fee.value).toBe('');
    route.query = {};
  });

  it('supplier rules: auto-publish cap is numeric(18,2)', async () => {
    route.query = { supplierId: 's1' };
    vi.mocked(apiFetch).mockImplementation(async (u) => String(u).includes('suppliers-list') ? ok({ id: 's1', name: 'Acme' }) : ok([]));
    render(<SupplierRulesPage />);
    await atScale(() => screen.getByPlaceholderText('No cap'), '750.50', '750.505');
    route.query = {};
  });

  it('PO line editor: unit price is numeric(19,6)', async () => {
    const line = { key: 'k', description: '', quantity: '1', unit_price: '', tax_rate: '15', gl_account_id: '', product_id: '', cc1_id: '', cc2_id: '', bu_id: '' };
    render(<PoLineItemsEditor items={[line]} accounts={[]} storedLabels={{}} onAdd={() => {}} onRemove={() => {}} onUpdate={() => {}} />);
    const el = screen.getByLabelText('Line 1 unit price') as HTMLInputElement;
    fireEvent.change(el, { target: { value: '0.123456' } });
    expect(el.value).toBe('0.123456');
    fireEvent.change(el, { target: { value: '0.1234567' } });
    expect(el.value).toBe('0.123456');
  });

  it('approval starter panel: amounts are numeric(15,2)', async () => {
    render(<ApprovalStarterPanel actorRole="owner" rules={[]} onCreated={() => {}} onClose={() => {}} />);
    await atScale(() => screen.getAllByLabelText(/^Amount for/)[0]!, '5000.25', '5000.255');
  });
});

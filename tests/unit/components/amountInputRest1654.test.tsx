/**
 * #1654 (rest): money fields on items, assets, time entries, recurring invoices, adjustments, write-offs and
 * VAT adjustments keep what is typed. Typing "5000" into an empty/0 field gives 5000 (not "05000"), clearing empties it,
 * a third decimal is refused, and the value reaches the parent / submit payload.
 */
import { useState } from 'react';
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

import { apiFetch } from '@/lib/apiFetch';
import { PricingSection, OpeningBalancesSection } from '@/components/accounting/items/ItemFormSections';
import { AssetFinancialFields } from '@/components/accounting/assets/AssetFinancialFields';
import { TimeEntryModal, type TimeEntryForm } from '@/components/accounting/time-tracking/TimeEntryModal';
import { LineItemsSection, type LineItem } from '@/components/accounting/recurringInvoices/LineItemsSection';
import AdjustmentsPage from '../../../pages/accounting/adjustments/index';
import WriteOffsPage from '../../../pages/accounting/write-offs/index';
import VatAdjustmentsPage from '../../../pages/accounting/vat-adjustments/index';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); route.push.mockReset(); });
afterEach(() => { cleanup(); });

const typeText = (el: HTMLElement, text: string) => {
  fireEvent.focus(el);
  let acc = '';
  for (const ch of text) { acc += ch; fireEvent.change(el, { target: { value: acc } }); }
};
const v = (el: HTMLElement) => (el as HTMLInputElement).value;

/** Every money field the same way: types 5000, then a clear, then a third decimal. */
function checkField(get: () => HTMLElement) {
  typeText(get(), '5000');
  expect(v(get())).toBe('5000');
  fireEvent.change(get(), { target: { value: '' } });
  expect(v(get())).toBe('');
  typeText(get(), '12.5');
  fireEvent.change(get(), { target: { value: '12.555' } });
  expect(v(get())).toBe('12.5');
}

describe('item PricingSection / OpeningBalancesSection', () => {
  it('cost, both selling prices and opening cost', () => {
    const seen: Record<string, string> = {};
    function H() {
      const [f, setF] = useState({ cost_price: '', selling_price_excl: '', selling_price_incl: '', opening_cost: '' });
      const on = (k: string, val: string) => { seen[k] = val; setF(p => ({ ...p, [k]: val })); };
      return (<>
        <PricingSection cost_price={f.cost_price} selling_price_excl={f.selling_price_excl} selling_price_incl={f.selling_price_incl} gp_percent="" onChange={on} />
        <OpeningBalancesSection opening_qty="" opening_cost={f.opening_cost} opening_date="" onChange={on} dates={{ bind: () => () => {} } as never} />
      </>);
    }
    render(<H />);
    for (const id of ['item-form-sections-cost-price-zar', 'item-form-sections-exclusive-selling-price-zar', 'item-form-sections-inclusive-selling-price-zar', 'item-form-sections-opening-cost-zar']) {
      checkField(() => document.getElementById(id)!);
    }
    typeText(document.getElementById('item-form-sections-cost-price-zar')!, '99.9');
    expect(seen.cost_price).toBe('99.9');
  });
});

describe('AssetFinancialFields', () => {
  it('cost and salvage value', () => {
    let last = '';
    function H() {
      const [f, setF] = useState({ purchaseDate: '', cost: '', salvageValue: '', usefulLifeYears: '5' });
      return <AssetFinancialFields form={f} update={(k, val) => { last = val; setF(p => ({ ...p, [k]: val })); }} onDateChange={() => {}} />;
    }
    render(<H />);
    checkField(() => document.getElementById('asset-cost')!);
    checkField(() => document.getElementById('asset-salvageValue')!);
    expect(last).toBe('12.5');
  });
});

describe('TimeEntryModal', () => {
  it('hourly rate', () => {
    let rate = '';
    const base: TimeEntryForm = { projectName: '', taskDescription: '', entryDate: '', hours: '', rate: '', billable: true, customerId: '', notes: '' };
    function H() {
      const [f, setF] = useState(base);
      return <TimeEntryModal form={f} editId={null} busy="" customers={[]} onClose={() => {}} onSubmit={() => {}}
        onChange={(k, val) => { if (k === 'rate') rate = String(val); setF(p => ({ ...p, [k]: val })); }} />;
    }
    render(<H />);
    const get = () => document.querySelector('input[placeholder="0.00"]:not([required])') as HTMLElement;
    checkField(get);
    expect(rate).toBe('12.5');
  });
});

describe('recurring invoice LineItemsSection', () => {
  it('unit price and quantity reach the parent as numbers', () => {
    const updates: Array<[string, number | string]> = [];
    function H() {
      const [lines, setLines] = useState<LineItem[]>([{ key: 'a', description: '', quantity: 1, unitPrice: 0, glAccountId: '' }]);
      return <LineItemsSection lines={lines} taxRate={15} onTaxRateChange={() => {}} inputCls="" onAddLine={() => {}} onRemoveLine={() => {}}
        onUpdateLine={(key, field, val) => { updates.push([field, val]); setLines(p => p.map(l => (l.key === key ? { ...l, [field]: val } : l))); }} />;
    }
    render(<H />);
    typeText(screen.getByLabelText('Line 1 unit price'), '5000');
    expect(v(screen.getByLabelText('Line 1 unit price'))).toBe('5000');
    expect(updates.at(-1)).toEqual(['unitPrice', 5000]);
    fireEvent.change(screen.getByLabelText('Line 1 unit price'), { target: { value: '' } });
    expect(v(screen.getByLabelText('Line 1 unit price'))).toBe('');
    typeText(screen.getByLabelText('Line 1 quantity'), '2.5');
    expect(updates.at(-1)).toEqual(['quantity', 2.5]);
  });
});

describe.each([
  { name: 'adjustments', Page: AdjustmentsPage, open: /New Adjustment/ },
  { name: 'write-offs', Page: WriteOffsPage, open: /New Write-Off/ },
  { name: 'vat-adjustments', Page: VatAdjustmentsPage, open: /New (VAT )?Adjustment/ },
])('$name amount', ({ Page, open }) => {
  it('types 5000 into the amount, clears, refuses a third decimal', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => ok([]));
    render(<Page />);
    fireEvent.click((await screen.findAllByRole('button', { name: open }))[0]!);
    const get = () => screen.getByPlaceholderText('Amount *');
    await waitFor(() => expect(get()).toBeTruthy());
    checkField(get);
  });
});

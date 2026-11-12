// Budgets P5 §9 (prod acceptance 2026-11-06): lines copied from a PO must link to their PO line and keep its
// coding, or the PO's commitment is never released and the bill is counted twice against its budget.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { billLineFromPo, mergePoAccounts, poLinesFromOrder, LINKABLE_PO_STATUSES } from '@/components/accounting/suppliers/poBillLines';
import { restampLines } from '@/components/accounting/suppliers/useSupplierDimensionDefaults';
import { COMMITTING_PO_STATUSES } from '@/modules/accounting/services/budgets/remainingCommitted';

const row = {
  id: 'item-1', description: 'Router', quantity: '2', unit_price: '100.50', tax_rate: '15',
  gl_account_id: 'acc-1', account_code: '1210', account_name: 'Equipment', cc1_id: 'cc1', cc2_id: 'cc2', bu_id: 'bu',
};
const defaults = { cc2Id: 'supplier-cc2', buId: 'supplier-bu' };

describe('poLinesFromOrder', () => {
  it('carries the PO line id, account and dimensions of an approved order', () => {
    expect(poLinesFromOrder({ status: 'approved', items: [row] })).toEqual([{
      poItemId: 'item-1', description: 'Router', quantity: 2, unitPrice: 100.5, taxRate: 15,
      glAccountId: 'acc-1', accountCode: '1210', accountName: 'Equipment', cc1Id: 'cc1', cc2Id: 'cc2', buId: 'bu',
    }]);
  });

  it('does not link a line of an order the server would refuse (submitted): the coding is still copied', () => {
    const [line] = poLinesFromOrder({ status: 'submitted', items: [row] });
    expect(line?.poItemId).toBeUndefined();
    expect(line?.glAccountId).toBe('acc-1');
  });

  it('links on exactly the statuses the server accepts', () => {
    expect([...LINKABLE_PO_STATUSES]).toEqual([...COMMITTING_PO_STATUSES]);
  });

  it('reads a line with no coding as blanks, and an order with no items as none', () => {
    const [line] = poLinesFromOrder({ status: 'approved', items: [{ id: 'i', description: null }] });
    expect(line).toMatchObject({ glAccountId: '', cc1Id: '', cc2Id: '', buId: '', quantity: 1, unitPrice: 0, taxRate: 15 });
    expect(poLinesFromOrder({ status: 'approved' })).toEqual([]);
  });
});

describe('billLineFromPo', () => {
  const [coded] = poLinesFromOrder({ status: 'approved', items: [row] });

  it('keeps the PO line\'s dimensions over the supplier\'s, so the bill lands on the slice the PO committed', () => {
    expect(billLineFromPo(coded!, defaults, 'k')).toEqual({
      key: 'k', description: 'Router', quantity: 2, unitPrice: 100.5, taxRate: 15, glAccountId: 'acc-1',
      poItemId: 'item-1', cc1Id: 'cc1', cc2Id: 'cc2', buId: 'bu',
    });
  });

  it('does not mix a supplier default into a PO line that names only a CC1: the CC2 would conflict with it', () => {
    const [only] = poLinesFromOrder({ status: 'approved', items: [{ ...row, cc2_id: null, bu_id: null }] });
    expect(billLineFromPo(only!, defaults, 'k')).toMatchObject({ cc1Id: 'cc1', cc2Id: '', buId: '' });
  });

  it('falls back to the supplier\'s defaults when the PO line has no dimensions', () => {
    const [bare] = poLinesFromOrder({ status: 'approved', items: [{ ...row, cc1_id: null, cc2_id: null, bu_id: null }] });
    const line = billLineFromPo(bare!, defaults, 'k');
    expect(line).toMatchObject({ cc2Id: 'supplier-cc2', buId: 'supplier-bu' });
    expect(line.cc1Id).toBeUndefined();
  });
});

describe('mergePoAccounts', () => {
  const list = [{ id: 'a', accountCode: '5100', accountName: 'Materials' }];

  it('adds a PO line\'s account the picker does not offer, or the line would read as the default', () => {
    const [coded] = poLinesFromOrder({ status: 'approved', items: [row] });
    expect(mergePoAccounts(list, [coded!])).toEqual([...list, { id: 'acc-1', accountCode: '1210', accountName: 'Equipment' }]);
  });

  it('leaves the list alone when every account is offered or the line has none', () => {
    const [blank] = poLinesFromOrder({ status: 'approved', items: [{ id: 'i' }] });
    const [offered] = poLinesFromOrder({ status: 'approved', items: [{ ...row, gl_account_id: 'a' }] });
    expect(mergePoAccounts(list, [blank!, offered!])).toBe(list);
  });
});

describe('the supplier defaults arriving after a copy', () => {
  const none = { cc2Id: '', buId: '' };

  it('fill a copied line with no dimensions of its own', () => {
    const [bare] = poLinesFromOrder({ status: 'approved', items: [{ ...row, cc1_id: null, cc2_id: null, bu_id: null }] });
    const [line] = restampLines([billLineFromPo(bare!, none, 'k')], none, defaults);
    expect(line).toMatchObject({ cc2Id: 'supplier-cc2', buId: 'supplier-bu', poItemId: 'item-1' });
  });

  it('leave a copied line alone when it names a CC1: a default CC2 could conflict with it', () => {
    const [only] = poLinesFromOrder({ status: 'approved', items: [{ ...row, cc2_id: null, bu_id: null }] });
    const [line] = restampLines([billLineFromPo(only!, none, 'k')], none, defaults);
    expect(line).toMatchObject({ cc1Id: 'cc1', cc2Id: '', buId: '' });
  });
});

/**
 * contactControlGuard: which accounts count as AP/AR control, and the remedy each
 * caller's refusal names. A control account is identified by subtype through
 * canonicalSubtype, the same vocabulary the control-account resolver and the
 * subledger reconciler use, so every spelling they treat as control is refused.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { sql } from '@/lib/neon';
import {
  contactControlAccountIds, contactControlLineSkips, contactControlRefusal,
} from '@/modules/accounting/services/bank/contactControlGuard';
import { isBankAllocationRefusal } from '@/modules/accounting/services/bank/bankAllocationRefusal';
import { PAYABLE_SUBTYPES, RECEIVABLE_SUBTYPES } from '@/modules/accounting/services/gl/accountSubtypes';

describe('contactControlRefusal', () => {
  it.each([...PAYABLE_SUBTYPES, 'PAYABLE', ' Accounts Payable ', 'accounts-payable'])('refuses AP spelling %j', (raw) => {
    const r = contactControlRefusal(raw, 'This allocation');
    expect(isBankAllocationRefusal(r)).toBe(true);
    expect(r!.message).toMatch(/accounts payable control account: name the supplier/);
  });

  it.each([...RECEIVABLE_SUBTYPES, 'Receivable', 'trade-receivables'])('refuses AR spelling %j', (raw) => {
    expect(contactControlRefusal(raw, 'x')!.message).toMatch(/accounts receivable control account: name the customer/);
  });

  it.each([null, undefined, '', 'bank', 'default_expense', 'vat_input', 'revenue', 42])('lets %j through', (raw) => {
    expect(contactControlRefusal(raw, 'x')).toBeNull();
  });

  it('names each caller\'s own remedy', () => {
    expect(contactControlRefusal('payable', 'This allocation')!.message).toMatch(/\(allocate it as a supplier\)/);
    expect(contactControlRefusal('payable', 'A split line', 'split line')!.message).toMatch(/\(contactType 'supplier' \/ supplier_id\)/);
    expect(contactControlRefusal('receivable', 'Rule "R"', 'rule')!.message).toMatch(/^Rule "R" posts to .*\(set the rule's customer\)/);
    expect(contactControlRefusal('payable', 'A bank reconciliation adjustment', 'adjustment')!.message)
      .toMatch(/\(record a supplier payment and reconcile that\)/);
    expect(contactControlRefusal('debtors', 'x', 'adjustment')!.message).toMatch(/\(record a customer receipt and reconcile that\)/);
  });
});

describe('the batch reads (one query each)', () => {
  it('contactControlLineSkips: the control lines, keyed by bank line, ids compared lowercased', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ id: 'ap-1', account_subtype: 'payable' }, { id: 'fuel', account_subtype: 'default_expense' }] as never);
    const skips = await contactControlLineSkips('c-1', [{ txId: 't1', accountId: 'AP-1' }, { txId: 't2', accountId: 'fuel' }]);
    expect([...skips.keys()]).toEqual(['t1']);
    expect(skips.get('t1')).toMatch(/accounts payable control account/);
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(1);
  });

  it('contactControlAccountIds: the rule accounts that are control', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ id: 'AR-9', account_subtype: 'Debtors' }, { id: 'rent', account_subtype: 'default_expense' }] as never);
    expect(await contactControlAccountIds('c-1', ['AR-9', 'rent'])).toEqual(new Set(['ar-9']));
  });

  it('reads nothing for an empty batch', async () => {
    vi.mocked(sql).mockClear();
    expect((await contactControlLineSkips('c-1', [])).size).toBe(0);
    expect((await contactControlAccountIds('c-1', [])).size).toBe(0);
    expect(sql).not.toHaveBeenCalled();
  });
});

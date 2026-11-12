import { describe, it, expect } from 'vitest';
import {
  billLineAccountChoices,
  groupBillAccounts,
  PO_GROUP_LABEL,
} from '@/components/accounting/suppliers/billAccountOptions';
import { billLineAccountProblem } from '@/modules/accounting/services/ap/billLineAccountRules';
import type { GLAccount } from '@/modules/accounting/types/gl.types';

type Row = Pick<GLAccount, 'id' | 'accountCode' | 'accountName' | 'accountType' | 'isActive'>
  & Partial<Pick<GLAccount, 'accountSubtype' | 'parentAccountId'>>;
const acc = (id: string, accountCode: string, accountType: GLAccount['accountType'], accountSubtype?: string, over: Partial<Row> = {}): Row =>
  ({ id, accountCode, accountName: `Acc ${accountCode}`, accountType, accountSubtype, isActive: true, ...over });

const CHART: Row[] = [
  acc('fa', '1500', 'asset', 'fixed_asset'),
  acc('inv', '1300', 'asset', 'inventory'),
  acc('pre', '1400', 'asset', 'prepayment'),
  acc('e3', '400', 'expense', 'operating_expense'),
  acc('e5', '5100', 'expense', 'cost_of_sales'),
  acc('acr', '2300', 'liability', 'accrual'),
  acc('bank', '1110', 'asset', 'bank'),
  acc('ar', '1200', 'asset', 'receivable'),
  acc('ap', '2000', 'liability', 'payable'),
  acc('vi', '2100', 'liability', 'vat_input'),
  acc('vo', '2110', 'liability', 'vat_output'),
  acc('re', '3900', 'equity', 'retained_earnings'),
  acc('ad', '1590', 'asset', 'accumulated_depreciation'),
  acc('sys8', 'SYS-8', 'liability'),
  acc('off', '5900', 'expense', 'operating_expense', { isActive: false }),
  acc('hdr', '6000', 'expense', 'operating_expense'),
  acc('hdrChild', '6010', 'expense', 'operating_expense', { parentAccountId: 'hdr' }),
  acc('hdr2', '6100', 'expense', 'operating_expense'),
  acc('hdr2Child', '6110', 'expense', 'operating_expense', { parentAccountId: 'hdr2', isActive: false }),
];

describe('billLineAccountChoices', () => {
  const ids = billLineAccountChoices(CHART).map((a) => a.id);

  it('offers asset, stock, prepayment, three-digit and liability accounts', () => {
    for (const id of ['fa', 'inv', 'pre', 'e3', 'e5', 'acr']) expect(ids).toContain(id);
  });

  it('refuses control, VAT, system, inactive and header accounts', () => {
    for (const id of ['bank', 'ar', 'ap', 'vi', 'vo', 're', 'ad', 'sys8', 'off', 'hdr', 'hdr2']) {
      expect(ids).not.toContain(id);
    }
  });

  it('is sorted by code', () => {
    const codes = billLineAccountChoices(CHART).map((a) => a.accountCode);
    expect(codes).toEqual([...codes].sort((x, y) => x.localeCompare(y)));
  });

  it('offers exactly what the server guard accepts', () => {
    const parents = new Set(CHART.map((a) => a.parentAccountId).filter(Boolean));
    for (const a of CHART) {
      const serverOk = billLineAccountProblem({
        account_code: a.accountCode, account_name: a.accountName,
        account_subtype: a.accountSubtype ?? null, is_active: a.isActive, has_children: parents.has(a.id),
      }) === null;
      expect(ids.includes(a.id), a.accountCode).toBe(serverOk);
    }
  });
});

describe('groupBillAccounts', () => {
  it('orders groups, labels them, and puts untyped accounts under the PO group', () => {
    const groups = groupBillAccounts([
      ...billLineAccountChoices(CHART),
      { id: 'po', accountCode: '9999', accountName: 'From PO' },
    ]);
    expect(groups.map((g) => g.label)).toEqual(['Expenses', 'Assets', 'Liabilities', PO_GROUP_LABEL]);
    expect(groups[1]!.accounts.map((a) => a.id)).toEqual(['inv', 'pre', 'fa']);
    expect(groups[3]!.accounts.map((a) => a.id)).toEqual(['po']);
  });
});

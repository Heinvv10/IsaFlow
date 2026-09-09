import { expect, it } from 'vitest';
import { selectApSystemAccount } from '@/modules/accounting/services/ap/apControlAccounts';
const account = { id: 'id', account_subtype: 'payable', account_type: 'liability', is_active: true, is_system_account: true };
it('refuses missing, ambiguous, inactive or mistyped account mappings', () => {
  expect(selectApSystemAccount([account], 'payable')).toEqual(account);
  expect(() => selectApSystemAccount([], 'payable')).toThrow();
  expect(() => selectApSystemAccount([account, { ...account, id: 'other' }], 'payable')).toThrow('Ambiguous');
  expect(() => selectApSystemAccount([{ ...account, account_type: 'expense' }], 'payable')).toThrow();
  expect(() => selectApSystemAccount([{ ...account, is_active: false }], 'payable')).toThrow();
});

it('accepts authoritative gross-inclusive invoice lines supported by the existing AP writer', async () => {
  const { deriveInvoiceAmount } = await import('@/modules/accounting/services/controls/apOperationMaterializer');
  expect(deriveInvoiceAmount('115', [{ line_total: '115', tax_amount: '15' }])).toBe('115');
  expect(() => deriveInvoiceAmount('116', [{ line_total: '115', tax_amount: '15' }])).toThrow();
});

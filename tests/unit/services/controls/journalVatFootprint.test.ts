import { expect, it } from 'vitest';
import { journalAffectsVatReturn } from '@/modules/accounting/services/controls/journalVatFootprint';
const account = { id: 'a', account_type: 'asset', account_subtype: 'bank' };
const line = { gl_account_id: 'a', vat_type: null };
it.each(['vat_input', 'vat_output'])('includes %s even without a line VAT code', account_subtype => {
  expect(journalAffectsVatReturn([line], [{ ...account, account_subtype }])).toBe(true);
});
it.each(['bank', 'receivable', 'payable', 'retained_earnings', null, 'tax'])('includes coded report exceptions on %s', account_subtype => {
  expect(journalAffectsVatReturn([{ ...line, vat_type: 'standard' }], [{ ...account, account_subtype }])).toBe(true);
});
it('does not classify an uncoded bank transfer or no-VAT settlement as return material', () => {
  expect(journalAffectsVatReturn([line], [account])).toBe(false);
  expect(journalAffectsVatReturn([{ ...line, vat_type: 'no_vat' }], [account])).toBe(false);
});
it('does not invent a VAT footprint solely from a normal supply or legitimate capital base', () => {
  expect(journalAffectsVatReturn([{ ...line, vat_type: 'standard' }], [{ ...account, account_type: 'revenue', account_subtype: null }])).toBe(false);
  expect(journalAffectsVatReturn([{ ...line, vat_type: 'capital_goods' }], [{ ...account, account_subtype: 'fixed_asset' }])).toBe(false);
});

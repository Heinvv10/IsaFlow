import { expect, it } from 'vitest';
import { supplierExposureBuckets } from '@/modules/accounting/services/controls/supplierExposureBuckets';
import type { ApMaterial } from '@/modules/accounting/services/controls/apOperationMaterializer';

function material(amount = '12000'): ApMaterial {
  return { supplierId: '', observedSources: [], versionBasis: 'untracked_current_observation',
    binding: { companyId: 'tenant', entityType: 'supplier_payment_batch', entityId: 'batch',
      entityVersion: 1, operation: 'supplier_payment_batch.process', accountingDate: '2026-09-09',
      amount, currency: 'ZAR', sourceVersions: [], beneficiaries: [
        { entityType: 'supplier', entityId: 'a', beneficiaryId: 'bank-a', version: 1, fingerprint: 'a', amount: '4000', currency: 'ZAR' },
        { entityType: 'supplier', entityId: 'b', beneficiaryId: 'bank-b', version: 1, fingerprint: 'b', amount: '6000', currency: 'ZAR' },
        { entityType: 'supplier', entityId: 'a', beneficiaryId: 'bank-a', version: 1, fingerprint: 'a', amount: '2000', currency: 'ZAR' },
      ] } };
}
it('groups mixed batch exposure per supplier without attributing the batch total to each', () => {
  expect(supplierExposureBuckets(material())).toEqual([
    { beneficiaryKey: 'a', amount: '6000', currency: 'ZAR' },
    { beneficiaryKey: 'b', amount: '6000', currency: 'ZAR' },
  ]);
});
it('preserves exact decimal totals beyond floating point and default Decimal precision', () => {
  const value = material('9007199254740993.00000001');
  value.binding.beneficiaries = [
    { ...value.binding.beneficiaries[0]!, amount: '9007199254740993' },
    { ...value.binding.beneficiaries[0]!, amount: '0.00000001' },
  ];
  expect(supplierExposureBuckets(value)[0]!.amount).toBe('9007199254740993.00000001');
});
it.each(['missing', 'currency', 'amount', 'employee'])('rejects incomplete or incompatible beneficiary coverage: %s', kind => {
  const value = material();
  if (kind === 'missing') value.binding.beneficiaries = [];
  if (kind === 'currency') value.binding.beneficiaries = value.binding.beneficiaries.map(b => ({ ...b, currency: 'USD' }));
  if (kind === 'amount') value.binding.amount = '12001';
  if (kind === 'employee') value.binding.beneficiaries = value.binding.beneficiaries.map(b => ({ ...b, entityType: 'employee' }));
  expect(() => supplierExposureBuckets(value)).toThrow();
});
it('supports authoritative single-supplier invoice material without a payment beneficiary', () => {
  const value = material('115'); value.supplierId = 'supplier';
  value.binding.entityType = 'supplier_invoice'; value.binding.operation = 'supplier_invoice.post';
  value.binding.beneficiaries = [];
  expect(supplierExposureBuckets(value)).toEqual([{ beneficiaryKey: 'supplier', amount: '115', currency: 'ZAR' }]);
});
it('does not invent supplier authority for unsupported operations', () => {
  const value = material(); value.binding.entityType = 'bank_transfer_intent';
  value.binding.operation = 'bank_transfer.post';
  expect(() => supplierExposureBuckets(value)).toThrow();
});

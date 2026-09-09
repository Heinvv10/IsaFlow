import Decimal from 'decimal.js';
import { canonicalMoney } from './canonical';
import type { ApMaterial } from './apOperationMaterializer';

const Money = Decimal.clone({ precision: 80 });
export interface SupplierExposureBucket { beneficiaryKey: string; amount: string; currency: string }

/** Derive aggregate-policy exposure only from complete authoritative source material. */
export function supplierExposureBuckets(material: ApMaterial): SupplierExposureBucket[] {
  const { binding } = material;
  if (binding.amount === null || binding.currency === null || !/^[A-Z]{3}$/.test(binding.currency)) {
    throw new Error('Supplier aggregate policy requires monetary material');
  }
  const total = new Money(canonicalMoney(binding.amount));
  if (!total.gt(0)) throw new Error('Supplier aggregate exposure must be positive');
  const composite = ['supplier_payment_batch', 'payment_release_intent'].includes(binding.entityType);
  if (!composite) {
    if (!['supplier_invoice', 'supplier_payment'].includes(binding.entityType) || !material.supplierId) {
      throw new Error('Supplier aggregate policy cannot evaluate this operation');
    }
    return [{ beneficiaryKey: material.supplierId, amount: total.toFixed(), currency: binding.currency }];
  }
  if (!binding.beneficiaries.length || binding.beneficiaries.length > 100) {
    throw new Error('Supplier aggregate beneficiary population is incomplete');
  }
  const buckets = new Map<string, Decimal>();
  let covered = new Money(0);
  for (const beneficiary of binding.beneficiaries) {
    if (beneficiary.entityType !== 'supplier' || !beneficiary.entityId || beneficiary.amount === null
      || beneficiary.currency !== binding.currency) throw new Error('Supplier aggregate beneficiary is incompatible');
    const amount = new Money(canonicalMoney(beneficiary.amount));
    if (!amount.gt(0)) throw new Error('Supplier aggregate beneficiary amount must be positive');
    covered = covered.add(amount);
    buckets.set(beneficiary.entityId, (buckets.get(beneficiary.entityId) ?? new Money(0)).add(amount));
  }
  if (!covered.eq(total)) throw new Error('Supplier aggregate beneficiary amounts do not cover the operation');
  return [...buckets].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([beneficiaryKey, amount]) => ({ beneficiaryKey, amount: amount.toFixed(), currency: binding.currency! }));
}

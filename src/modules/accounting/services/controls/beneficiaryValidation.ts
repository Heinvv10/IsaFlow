import { timingSafeEqual } from 'node:crypto';
import { UUID_RE } from '@/lib/validation';
import { beneficiaryFingerprint, openProtectedChange, protectChangeValues, type ProtectedChange } from './changeProtection';

export interface BeneficiaryRef { entityType: 'supplier' | 'employee'; entityId: string }
export interface BeneficiaryDetails { bankName: string; accountNumber: string; branchCode: string; accountType: string }
export class BeneficiaryError extends Error {
  constructor(public readonly code: string) { super(`Beneficiary control refused: ${code}`); this.name = 'BeneficiaryError'; }
}
const fail = (): never => { throw new BeneficiaryError('INVALID_MATERIAL'); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !('value' in d))) return fail();
  return value as Record<string, unknown>;
}
export function validateBeneficiaryRef(value: unknown): BeneficiaryRef {
  const v = object(value);
  if (Object.keys(v).some(k => !['entityType', 'entityId'].includes(k))
    || !['supplier', 'employee'].includes(String(v.entityType))
    || typeof v.entityId !== 'string' || !UUID_RE.test(v.entityId)) return fail();
  return { entityType: v.entityType as BeneficiaryRef['entityType'], entityId: v.entityId.toLowerCase() };
}
export function normalizeBeneficiaryDetails(value: unknown): BeneficiaryDetails {
  const v = object(value);
  if (Object.keys(v).some(k => !['bankName', 'accountNumber', 'branchCode', 'accountType'].includes(k))
    || ['bankName', 'accountNumber', 'branchCode', 'accountType'].some(k => typeof v[k] !== 'string')) return fail();
  const bankName = (v.bankName as string).trim().replace(/\s+/g, ' ');
  const accountNumber = (v.accountNumber as string).trim();
  const branchCode = (v.branchCode as string).trim();
  const accountType = (v.accountType as string).trim().toLowerCase();
  if (!bankName || bankName.length > 100 || /[\x00-\x1f]/.test(bankName)
    || !/^\d{5,30}$/.test(accountNumber) || !/^\d{6}$/.test(branchCode)
    || !['cheque', 'current', 'savings', 'transmission'].includes(accountType)) return fail();
  return { bankName, accountNumber, branchCode, accountType: accountType === 'current' ? 'cheque' : accountType };
}
export function bankFingerprint(companyId: string, ref: BeneficiaryRef, details: unknown): string {
  return beneficiaryFingerprint(companyId, { ...ref, details });
}
export function sealBeneficiary(companyId: string, ref: BeneficiaryRef, details: BeneficiaryDetails): {
  envelope: ProtectedChange; fingerprint: string;
} {
  return { envelope: protectChangeValues(`beneficiary_${ref.entityType}`, null, { ...details }).protectedPayload,
    fingerprint: bankFingerprint(companyId, ref, details) };
}
export function openBeneficiary(companyId: string, ref: BeneficiaryRef, envelope: ProtectedChange, fingerprint: string): BeneficiaryDetails {
  const details = normalizeBeneficiaryDetails(openProtectedChange(envelope).after);
  const actual = bankFingerprint(companyId, ref, details);
  if (!/^[a-f0-9]{64}$/.test(fingerprint) || !timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(fingerprint, 'hex'))) {
    throw new BeneficiaryError('MATERIAL_INTEGRITY');
  }
  return details;
}

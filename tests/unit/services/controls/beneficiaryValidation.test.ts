import { beforeEach, describe, expect, it } from 'vitest';
import { normalizeBeneficiaryDetails, validateBeneficiaryRef, sealBeneficiary, openBeneficiary } from '@/modules/accounting/services/controls/beneficiaryValidation';

const ref = { entityType: 'supplier' as const, entityId: '11111111-1111-4111-8111-111111111111' };
const bank = { bankName: '  Example Bank  ', accountNumber: '00123456789', branchCode: '001234', accountType: 'cheque' };
beforeEach(() => {
  process.env.ENCRYPTION_KEY = 'synthetic-beneficiary-encryption-key-only';
  process.env.CONTROL_FINGERPRINT_KEY = 'synthetic-beneficiary-fingerprint-key-only';
});
describe('beneficiary material validation', () => {
  it('normalizes names without losing account leading zeroes', () => {
    expect(normalizeBeneficiaryDetails(bank)).toEqual({ ...bank, bankName: 'Example Bank' });
  });
  it.each([{ ...bank, verified: true }, { ...bank, accountNumber: 12345 }, { ...bank, branchCode: 'x' },
    { ...bank, accountType: 'crypto' }, { ...bank, bankName: '' }])('refuses malformed or authority-bearing details %j', value => {
    expect(() => normalizeBeneficiaryDetails(value)).toThrow();
  });
  it('rejects tenant selectors and invalid typed identities', () => {
    expect(() => validateBeneficiaryRef({ ...ref, companyId: 'foreign' })).toThrow();
    expect(() => validateBeneficiaryRef({ ...ref, entityType: 'customer' })).toThrow();
    expect(() => validateBeneficiaryRef({ ...ref, entityId: 'x' })).toThrow();
  });
  it('encrypts exact material and binds the tenant and typed beneficiary', () => {
    const details = normalizeBeneficiaryDetails(bank);
    const sealed = sealBeneficiary('tenant-a', ref, details);
    expect(JSON.stringify(sealed)).not.toContain(bank.accountNumber);
    expect(openBeneficiary('tenant-a', ref, sealed.envelope, sealed.fingerprint)).toEqual(details);
    expect(() => openBeneficiary('tenant-b', ref, sealed.envelope, sealed.fingerprint)).toThrow();
    expect(() => openBeneficiary('tenant-a', { ...ref, entityType: 'employee' }, sealed.envelope, sealed.fingerprint)).toThrow();
  });
  it('fails closed on absent encryption or fingerprint keys', () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => sealBeneficiary('tenant-a', ref, normalizeBeneficiaryDetails(bank))).toThrow();
    process.env.ENCRYPTION_KEY = 'synthetic-beneficiary-encryption-key-only';
    delete process.env.CONTROL_FINGERPRINT_KEY;
    expect(() => sealBeneficiary('tenant-a', ref, normalizeBeneficiaryDetails(bank))).toThrow();
  });
});

import { randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { beneficiaryFingerprint, openProtectedChange, protectChangeValues } from '@/modules/accounting/services/controls/changeProtection';

afterEach(() => vi.unstubAllEnvs());
function key() { vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('hex')); }
it('retains exact banking before/after encrypted while exposing only safe fields', () => {
  key();
  const before = { name: 'Synthetic supplier', bank_account_number: '000123456789', status: 'active' };
  const after = { ...before, bank_account_number: '000987654321', token: 'never-store-this-token' };
  const result = protectChangeValues('supplier', before, after);
  expect(result.before).toEqual({ name: 'Synthetic supplier', status: 'active' });
  expect(JSON.stringify(result)).not.toContain('000123456789');
  expect(JSON.stringify(result)).not.toContain('never-store-this-token');
  expect(openProtectedChange(result.protectedPayload)).toEqual({ before, after: { ...before, bank_account_number: '000987654321' } });
});
it('restricts payroll values even when they use ordinary amount/name fields', () => {
  key();
  const result = protectChangeValues('payroll_component', { name: 'Alice', amount: '10000', status: 'active' }, { amount: '15000' });
  expect(result.before).toEqual({ status: 'active' });
  expect(result.after).toEqual({});
  expect(openProtectedChange(result.protectedPayload).before).toEqual({ name: 'Alice', amount: '10000', status: 'active' });
});
it('refuses missing encryption keys in tests as well as production', () => {
  vi.stubEnv('ENCRYPTION_KEY', '');
  expect(() => protectChangeValues('supplier', null, { status: 'active' })).toThrow();
});
it('detects altered protected evidence and unsupported encryption key identifiers', () => {
  key();
  const result = protectChangeValues('supplier', null, { status: 'active' });
  expect(() => openProtectedChange({ ...result.protectedPayload, ciphertext: result.protectedPayload.ciphertext + '00' })).toThrow();
  expect(() => openProtectedChange({ ...result.protectedPayload, keyId: 'missing-key' })).toThrow();
});
it('uses tenant- and domain-bound keyed beneficiary fingerprints', () => {
  vi.stubEnv('CONTROL_FINGERPRINT_KEY', randomBytes(32).toString('hex'));
  const data = { accountNumber: '000123456789', branchCode: '123456' };
  expect(beneficiaryFingerprint('tenant-a', data)).toBe(beneficiaryFingerprint('tenant-a', data));
  expect(beneficiaryFingerprint('tenant-a', data)).not.toBe(beneficiaryFingerprint('tenant-b', data));
  vi.stubEnv('CONTROL_FINGERPRINT_KEY', '');
  expect(() => beneficiaryFingerprint('tenant-a', data)).toThrow();
});

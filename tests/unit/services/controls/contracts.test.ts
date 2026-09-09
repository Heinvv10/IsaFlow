import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalMoney, operationBindingHash } from '@/modules/accounting/services/controls/canonical';
import type { OperationBinding } from '@/modules/accounting/services/controls/contracts';

const binding: OperationBinding = {
  companyId: 'tenant-a', operation: 'supplier_payment.process', entityType: 'supplier_payment',
  entityId: 'payment-a', entityVersion: 3, accountingDate: '2026-09-09', amount: '1150.00', currency: 'ZAR',
  beneficiaries: [{ entityType: 'supplier', entityId: 'supplier-a', beneficiaryId: 'bank-a',
    version: 2, fingerprint: 'keyed-fingerprint', amount: '1150', currency: 'ZAR' }],
  sourceVersions: [{ entityType: 'supplier_invoice', entityId: 'bill-a', version: 4, fingerprint: 'invoice-lines' }],
  policies: [{ policyId: 'rule-a', policyVersion: 2, approverRole: 'admin', mandatory: true }],
};

describe('stable financial operation contracts', () => {
  it('canonicalizes object order and actual Date/string values without erasing evidence', () => {
    expect(canonicalJson({ b: 1, a: new Date('2026-09-09T00:00:00Z') }))
      .toBe(canonicalJson({ a: '2026-09-09T00:00:00.000Z', b: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
  it.each([NaN, Infinity, undefined, new Date('invalid'), BigInt(1), () => 1, new Map()])(
    'rejects unsupported evidence instead of silently hashing a different value: %s', value => {
      expect(() => canonicalJson({ value })).toThrow();
    },
  );
  it('rejects cyclic evidence', () => {
    const value: Record<string, unknown> = {}; value.self = value;
    expect(() => canonicalJson(value)).toThrow();
  });
  it('normalizes decimal money without binary rounding or dropping precision', () => {
    expect(canonicalMoney('001150.00')).toBe('1150');
    expect(canonicalMoney('9007199254740993.01')).toBe('9007199254740993.01');
    expect(canonicalMoney('-0.00')).toBe('0');
    expect(() => canonicalMoney('Infinity')).toThrow();
    expect(() => canonicalMoney('1e999')).toThrow();
  });
  it('binds semantically identical decimal amounts identically', () => {
    expect(operationBindingHash(binding)).toBe(operationBindingHash({ ...binding, amount: '1150' }));
  });
  it.each([
    { companyId: 'tenant-b' }, { entityId: 'payment-b' }, { entityVersion: 4 },
    { accountingDate: '2026-09-08' }, { amount: '1150.01' }, { currency: 'USD' },
    { operation: 'supplier_payment.void' },
    { beneficiaries: [{ ...binding.beneficiaries[0]!, version: 3 }] },
    { sourceVersions: [{ ...binding.sourceVersions[0]!, fingerprint: 'changed-lines' }] },
    { policies: [{ ...binding.policies[0]!, policyVersion: 3 }] },
  ])('invalidates approval material on changed field %j', patch => {
    expect(operationBindingHash({ ...binding, ...patch } as OperationBinding)).not.toBe(operationBindingHash(binding));
  });
  it('sorts set-valued references and applies every policy', () => {
    const policies = [...binding.policies, { ...binding.policies[0]!, policyId: 'rule-b' }];
    expect(operationBindingHash({ ...binding, policies })).toBe(operationBindingHash({ ...binding, policies: [...policies].reverse() }));
    expect(operationBindingHash({ ...binding, policies })).not.toBe(operationBindingHash(binding));
    expect(() => operationBindingHash({ ...binding, policies: [policies[0]!, policies[0]!] })).toThrow();
  });
  it('allows absent money for nonmonetary controls but rejects it for financial effects', () => {
    expect(() => operationBindingHash({ ...binding, operation: 'fiscal_period.reopen', amount: null, currency: null })).not.toThrow();
    expect(() => operationBindingHash({ ...binding, amount: null, currency: null })).toThrow();
  });
});

it('orders distinct Unicode bytes consistently regardless of reference permutation', () => {
  const policies = ['é', 'e\u0301'].map(policyId => ({ ...binding.policies[0]!, policyId }));
  expect(operationBindingHash({ ...binding, policies }))
    .toBe(operationBindingHash({ ...binding, policies: [...policies].reverse() }));
});

it.each([
  { sourceVersions: [{ ...binding.sourceVersions[0]!, version: 0 }] },
  { sourceVersions: [{ ...binding.sourceVersions[0]!, version: 1.5 }] },
  { sourceVersions: [{ ...binding.sourceVersions[0]!, fingerprint: '' }] },
  { beneficiaries: [{ ...binding.beneficiaries[0]!, version: -1 }] },
  { beneficiaries: [{ ...binding.beneficiaries[0]!, beneficiaryId: ' ' }] },
  { beneficiaries: [{ ...binding.beneficiaries[0]!, amount: null, currency: 'ZAR' }] },
  { beneficiaries: [{ ...binding.beneficiaries[0]!, currency: 'zar' }] },
  { policies: [{ ...binding.policies[0]!, policyVersion: Number.MAX_SAFE_INTEGER + 1 }] },
  { policies: [{ ...binding.policies[0]!, approverRole: '' }] },
  { policies: [{ ...binding.policies[0]!, mandatory: 'yes' }] },
  { accountingDate: '2026-02-30' }, { accountingDate: '09/09/2026' },
])('rejects malformed material binding fields before hashing %j', patch => {
  expect(() => operationBindingHash({ ...binding, ...patch } as OperationBinding)).toThrow();
});

it('rejects sparse arrays even when another enumerable property masks the missing index', () => {
  const value = new Array(1); Object.assign(value, { extra: 'lost evidence' });
  expect(() => canonicalJson(value)).toThrow();
});
it('rejects array symbol decoration and hidden payload on arrays/objects', () => {
  const decorated = [null]; Object.assign(decorated, { [Symbol('evidence')]: 123 });
  expect(() => canonicalJson(decorated)).toThrow();
  for (const value of [[null], {}]) {
    Object.defineProperty(value, 'hidden', { value: 'not represented', enumerable: false });
    expect(() => canonicalJson(value)).toThrow();
  }
});
it('rejects accessor evidence without invoking getters', () => {
  let accessed = false;
  for (const value of [[null], {}]) {
    Object.defineProperty(value, Array.isArray(value) ? '0' : 'field', {
      enumerable: true, get() { accessed = true; return 123; },
    });
    expect(() => canonicalJson(value)).toThrow();
  }
  expect(accessed).toBe(false);
});

it('keeps Unicode permutations stable for sources and beneficiaries without merging identities', () => {
  const ids = ['é', 'e\u0301'];
  const sourceVersions = ids.map(entityId => ({ ...binding.sourceVersions[0]!, entityId }));
  const beneficiaries = ids.map(entityId => ({ ...binding.beneficiaries[0]!, entityId }));
  const forward = { ...binding, sourceVersions, beneficiaries };
  expect(operationBindingHash(forward)).toBe(operationBindingHash({ ...forward,
    sourceVersions: [...sourceVersions].reverse(), beneficiaries: [...beneficiaries].reverse() }));
  expect(operationBindingHash(forward)).not.toBe(operationBindingHash(binding));
});
it.each([
  { companyId: ' ' }, { entityId: 42 }, { accountingDate: '2025-02-29' },
  { sourceVersions: [{ ...binding.sourceVersions[0]!, entityId: '' }] },
  { sourceVersions: [{ ...binding.sourceVersions[0]!, entityType: '' }] },
  { beneficiaries: [{ ...binding.beneficiaries[0]!, fingerprint: '' }] },
  { beneficiaries: [{ ...binding.beneficiaries[0]!, entityType: 'bank' }] },
  { beneficiaries: [{ ...binding.beneficiaries[0]!, amount: '1', currency: null }] },
  { policies: [{ ...binding.policies[0]!, policyId: ' ' }] },
  { policies: [{ ...binding.policies[0]!, mandatory: undefined }] },
  { policies: null },
])('rejects missing or wrongly typed material fields %j', patch => {
  expect(() => operationBindingHash({ ...binding, ...patch } as OperationBinding)).toThrow();
});
it('permits valid leap days, false policy requirements and frozen ordinary data', () => {
  expect(() => operationBindingHash({ ...binding, accountingDate: '2024-02-29',
    policies: [{ ...binding.policies[0]!, mandatory: false }] })).not.toThrow();
  expect(canonicalJson(Object.freeze([Object.freeze({ a: 1 })]))).toBe('[{"a":1}]');
});
it('rejects a hidden array index and decorated dates without losing payload', () => {
  const array = [1]; Object.defineProperty(array, '0', { enumerable: false });
  const date = Object.assign(new Date('2026-09-09T00:00:00Z'), { extra: 'hidden by ISO conversion' });
  expect(() => canonicalJson(array)).toThrow();
  expect(() => canonicalJson(date)).toThrow();
});

import { describe, expect, it } from 'vitest';
import { glTypeForSageType, nameSimilarity } from '@/modules/accounting/services/core/sageAccountTypes';

describe('glTypeForSageType', () => {
  it('resolves the numeric ids, as numbers or as the text the column stores', () => {
    expect(glTypeForSageType(1)).toBe('revenue');
    expect(glTypeForSageType('5')).toBe('asset');
    expect(glTypeForSageType('7')).toBe('equity');
  });

  it('returns null, never "any type", for a missing, blank, text or unknown value', () => {
    for (const raw of [null, undefined, '', '  ', 'Asset', '99', 'NaN']) expect(glTypeForSageType(raw)).toBeNull();
  });
});

describe('nameSimilarity', () => {
  it('scores an identical name 1 and unrelated names 0', () => {
    expect(nameSimilarity('bank account', 'bank account')).toBe(1);
    expect(nameSimilarity('bank', 'revenue')).toBe(0);
  });
});

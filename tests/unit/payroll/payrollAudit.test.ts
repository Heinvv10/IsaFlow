import { describe, it, expect } from 'vitest';
import { diffValues } from '@/modules/payroll/payrollAuditService';

describe('diffValues helper', () => {
  it('returns only changed fields', () => {
    const oldV = { a: 1, b: 'x', c: true };
    const newV = { a: 1, b: 'y', c: false };
    const diff = diffValues(oldV, newV);
    expect(diff.old).toEqual({ b: 'x', c: true });
    expect(diff.new).toEqual({ b: 'y', c: false });
  });

  it('captures added fields', () => {
    const oldV = { a: 1 };
    const newV = { a: 1, b: 2 };
    const diff = diffValues(oldV, newV);
    expect(diff.old).toEqual({ b: undefined });
    expect(diff.new).toEqual({ b: 2 });
  });

  it('captures removed fields', () => {
    const oldV = { a: 1, b: 2 };
    const newV = { a: 1 };
    const diff = diffValues(oldV, newV);
    expect(diff.old).toEqual({ b: 2 });
    expect(diff.new).toEqual({ b: undefined });
  });

  it('empty diff when nothing changed', () => {
    const v = { a: 1, b: 'x' };
    const diff = diffValues(v, v);
    expect(diff.old).toEqual({});
    expect(diff.new).toEqual({});
  });
});

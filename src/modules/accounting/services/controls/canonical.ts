import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import type { OperationBinding } from './contracts';
import { validateOperationBinding } from './bindingValidation';

/** Reject lossy JSON values rather than aliasing distinct evidence to one hash. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function normalize(input: unknown, depth: number): unknown {
    if (depth > 64) throw new Error('Evidence nesting limit exceeded');
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (input instanceof Date && Number.isFinite(Date.prototype.getTime.call(input))) {
      if (Object.getPrototypeOf(input) !== Date.prototype || Reflect.ownKeys(input).length) throw new Error('Decorated evidence date');
      return Date.prototype.toISOString.call(input);
    }
    if (typeof input !== 'object' || input === null || input instanceof Date) throw new Error('Unsupported evidence value');
    if (ancestors.has(input)) throw new Error('Cyclic evidence');
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        if (Object.getPrototypeOf(input) !== Array.prototype || Reflect.ownKeys(input).length !== input.length + 1) {
          throw new Error('Sparse or decorated evidence array');
        }
        const result: unknown[] = [];
        for (let index = 0; index < input.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('Unsupported evidence array property');
          result.push(normalize(descriptor.value, depth + 1));
        }
        return result;
      }
      if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
        throw new Error('Unsupported evidence object');
      }
      if (Object.getOwnPropertySymbols(input).length) throw new Error('Unsupported evidence keys');
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of Object.getOwnPropertyNames(input).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
        if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Unsupported evidence property');
        result[key] = normalize(descriptor.value, depth + 1);
      }
      return result;
    } finally { ancestors.delete(input); }
  }
  return JSON.stringify(normalize(value, 0));
}

/** Exact, bounded plain decimal input; exponent notation is not financial input. */
export function canonicalMoney(value: string): string {
  if (typeof value !== 'string' || !/^-?\d{1,30}(?:\.\d{1,12})?$/.test(value)) throw new Error('Invalid decimal amount');
  return new Decimal(value).toFixed();
}

function sortedUnique<T>(values: readonly T[], identity: (value: T) => string): T[] {
  const seen = new Set<string>();
  for (const value of values) {
    const id = identity(value);
    if (seen.has(id)) throw new Error('Duplicate operation binding reference');
    seen.add(id);
  }
  return [...values].sort((a, b) => {
    const left = canonicalJson(a), right = canonicalJson(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export function operationBindingHash(binding: OperationBinding): string {
  // Check descriptors before spreads/map or validation could invoke a getter or lose decoration.
  canonicalJson(binding);
  validateOperationBinding(binding);
  const amount = binding.amount === null ? null : canonicalMoney(binding.amount);
  const beneficiaries = sortedUnique(binding.beneficiaries.map(b => ({ ...b,
    amount: b.amount === null ? null : canonicalMoney(b.amount),
  })), b => canonicalJson([b.entityType, b.entityId, b.beneficiaryId]));
  const sourceVersions = sortedUnique(binding.sourceVersions, s => canonicalJson([s.entityType, s.entityId]));
  const policies = sortedUnique(binding.policies, p => p.policyId);
  return createHash('sha256').update(canonicalJson({ ...binding, amount, beneficiaries, sourceVersions, policies })).digest('hex');
}

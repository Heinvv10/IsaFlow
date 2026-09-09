import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { CONTROL_OPERATIONS, type OperationBinding } from './contracts';

/** Reject lossy JSON values rather than aliasing distinct evidence to one hash. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function normalize(input: unknown, depth: number): unknown {
    if (depth > 64) throw new Error('Evidence nesting limit exceeded');
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (input instanceof Date && Number.isFinite(input.getTime())) return input.toISOString();
    if (typeof input !== 'object' || input === null || input instanceof Date) throw new Error('Unsupported evidence value');
    if (ancestors.has(input)) throw new Error('Cyclic evidence');
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        if (Object.keys(input).length !== input.length) throw new Error('Sparse or decorated evidence array');
        return input.map(item => normalize(item, depth + 1));
      }
      if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
        throw new Error('Unsupported evidence object');
      }
      if (Object.getOwnPropertySymbols(input).length) throw new Error('Unsupported evidence keys');
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(input).sort()) result[key] = normalize((input as Record<string, unknown>)[key], depth + 1);
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

const NONMONETARY = new Set<string>([
  'fiscal_period.close', 'fiscal_period.lock', 'fiscal_period.reopen', 'year.close',
  'company_lockdown.change', 'vat_period.lock', 'beneficiary.propose', 'beneficiary.verify',
  'beneficiary.activate', 'payroll_run.reopen',
]);

function sortedUnique<T>(values: readonly T[], identity: (value: T) => string): T[] {
  const seen = new Set<string>();
  for (const value of values) {
    const id = identity(value);
    if (seen.has(id)) throw new Error('Duplicate operation binding reference');
    seen.add(id);
  }
  return [...values].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b), 'en'));
}

export function operationBindingHash(binding: OperationBinding): string {
  if (!CONTROL_OPERATIONS.includes(binding.operation)) throw new Error('Unsupported operation');
  if (!binding.companyId || !binding.entityType || !binding.entityId
    || !Number.isSafeInteger(binding.entityVersion) || binding.entityVersion < 1) throw new Error('Invalid entity binding');
  const amount = binding.amount === null ? null : canonicalMoney(binding.amount);
  if ((amount === null) !== (binding.currency === null)
    || (amount === null && !NONMONETARY.has(binding.operation))
    || (binding.currency !== null && !/^[A-Z]{3}$/.test(binding.currency))) throw new Error('Missing or invalid operation currency/amount');
  const beneficiaries = sortedUnique(binding.beneficiaries.map(b => ({ ...b,
    amount: b.amount === null ? null : canonicalMoney(b.amount),
  })), b => `${b.entityType}:${b.entityId}:${b.beneficiaryId}`);
  const sourceVersions = sortedUnique(binding.sourceVersions, s => `${s.entityType}:${s.entityId}`);
  const policies = sortedUnique(binding.policies, p => p.policyId);
  return createHash('sha256').update(canonicalJson({ ...binding, amount, beneficiaries, sourceVersions, policies })).digest('hex');
}

import { createHmac } from 'node:crypto';
import { encrypt, decrypt } from '@/lib/encryption';
import { canonicalJson } from './canonical';

export interface ProtectedChange { version: 1; keyId: string; ciphertext: string }
type Values = Record<string, unknown> | null;
const PUBLIC_FIELDS = new Set(['name', 'status', 'currency', 'amount', 'accountingDate', 'accounting_date',
  'entry_date', 'document_date', 'account_type', 'account_subtype', 'is_active', 'version', 'reason']);
const PAYROLL_FIELDS = new Set(['status', 'is_active', 'version', 'accountingDate', 'accounting_date']);
const SECRET_KEY = /token|password|secret|credential|authorization|api.?key/i;

function withoutCredentials(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCredentials);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_KEY.test(key))
      .map(([key, child]) => [key, withoutCredentials(child)]));
  }
  return value;
}
function sanitized(values: Values): Values {
  // Validate descriptors and normalize Dates before traversing caller values.
  return withoutCredentials(JSON.parse(canonicalJson(values))) as Values;
}
function publicValues(entityType: string, values: Values): Values {
  if (values === null) return null;
  const allowed = /payroll|employee|salary|compensation/i.test(entityType) ? PAYROLL_FIELDS : PUBLIC_FIELDS;
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => allowed.has(key)
    && (value === null || ['string', 'number', 'boolean'].includes(typeof value))));
}

/** Exact source values remain restricted; credentials are never evidence. */
export function protectChangeValues(entityType: string, before: Values, after: Values): {
  before: Values; after: Values; protectedPayload: ProtectedChange;
} {
  const safeBefore = sanitized(before), safeAfter = sanitized(after);
  const keyId = process.env.CONTROL_ENCRYPTION_KEY_ID ?? 'current';
  return {
    before: publicValues(entityType, safeBefore), after: publicValues(entityType, safeAfter),
    protectedPayload: { version: 1, keyId, ciphertext: encrypt(canonicalJson({ before: safeBefore, after: safeAfter })) },
  };
}

export function openProtectedChange(envelope: ProtectedChange): { before: Values; after: Values } {
  if (envelope.version !== 1 || envelope.keyId !== (process.env.CONTROL_ENCRYPTION_KEY_ID ?? 'current')) {
    throw new Error('Unsupported protected evidence key');
  }
  const value: unknown = JSON.parse(decrypt(envelope.ciphertext));
  if (!value || typeof value !== 'object' || !('before' in value) || !('after' in value)) {
    throw new Error('Invalid protected evidence');
  }
  return value as { before: Values; after: Values };
}

/** Do not expose these keyed fingerprints through generic contact/history APIs. */
export function beneficiaryFingerprint(companyId: string, normalizedDetails: Record<string, unknown>): string {
  const key = process.env.CONTROL_FINGERPRINT_KEY;
  if (!key || key.length < 32 || !companyId) throw new Error('Beneficiary fingerprint key and tenant required');
  return createHmac('sha256', key).update(canonicalJson({ domain: 'isaflow:beneficiary:v1', companyId, normalizedDetails })).digest('hex');
}

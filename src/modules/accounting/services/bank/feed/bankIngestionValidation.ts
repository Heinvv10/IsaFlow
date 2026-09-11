// src/modules/accounting/services/bank/feed/bankIngestionValidation.ts
/** Pure validation for canonical feed batches. Throws BankIngestionRefusal. */
import { bankTransactionHash } from '@/modules/accounting/utils/bankTransactionHash';
import {
  BankIngestionRefusal, type BankIngestionBatch, type BankTransactionIdentity, type IdentityMode,
  type NormalizedBankTransaction,
} from './bankIngestionTypes';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ABS_AMOUNT = 1e13; // NUMERIC(15,2)
const MAX_DESCRIPTION = 500;
const MAX_REFERENCE = 255;   // bank_transactions.reference VARCHAR(255)
const MAX_PROVIDER_ID = 200;

export function isCalendarDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * The established extension dedup hash: date | amount | description, with no
 * balance. Fields are passed explicitly so a `balance` on the incoming row can
 * never leak into the hash (HashableTransaction accepts one).
 */
export function contentHashIdentity(
  tx: { transactionDate: string; amount: number; description: string },
): Extract<BankTransactionIdentity, { kind: 'content_hash' }> {
  return {
    kind: 'content_hash',
    contentHash: bankTransactionHash({ transactionDate: tx.transactionDate, amount: tx.amount, description: tx.description }),
  };
}

export function identityModeFor(provider: string): IdentityMode {
  if (provider === 'extension') return 'content_hash';
  if (provider === 'manual_csv') {
    throw new BankIngestionRefusal('UNSUPPORTED_PROVIDER', 'Manual CSV connections import through the statement import page, not a feed.');
  }
  return 'provider';
}

function invalid(i: number, why: string): never {
  throw new BankIngestionRefusal('INVALID_TRANSACTION', `Transaction ${i + 1}: ${why}`, i);
}

function validateOne(t: NormalizedBankTransaction, i: number, mode: IdentityMode): void {
  if (!isCalendarDate(t.transactionDate)) invalid(i, `transactionDate "${t.transactionDate}" is not a calendar date`);
  if (t.valueDate !== undefined && !isCalendarDate(t.valueDate)) invalid(i, `valueDate "${t.valueDate}" is not a calendar date`);
  if (!Number.isFinite(t.amount) || Math.abs(t.amount) >= MAX_ABS_AMOUNT) invalid(i, 'amount must be a finite number');
  if (t.currency !== 'ZAR') invalid(i, `currency "${String(t.currency)}" is not supported`);
  if (t.description.trim().length === 0 || t.description.length > MAX_DESCRIPTION) invalid(i, 'description must be 1-500 characters');
  if (t.reference !== undefined && t.reference.length > MAX_REFERENCE) invalid(i, 'reference exceeds 255 characters');
  if (t.balance !== undefined && !Number.isFinite(t.balance)) invalid(i, 'balance must be finite');
  if (t.providerUpdatedAt !== undefined && Number.isNaN(Date.parse(t.providerUpdatedAt))) invalid(i, 'providerUpdatedAt is not a timestamp');

  if (mode === 'content_hash') {
    if (t.identity.kind !== 'content_hash' || t.state !== 'posted') {
      throw new BankIngestionRefusal('IDENTITY_MODE_MISMATCH', `Transaction ${i + 1}: this connection sends posted content-hash rows only`, i);
    }
    if (t.identity.contentHash !== contentHashIdentity(t).contentHash) invalid(i, 'content hash does not match the transaction fields');
  } else {
    if (t.identity.kind !== 'provider') {
      throw new BankIngestionRefusal('IDENTITY_MODE_MISMATCH', `Transaction ${i + 1}: this connection requires provider transaction IDs`, i);
    }
    const id = t.identity.providerTransactionId;
    if (id.trim().length === 0 || id.length > MAX_PROVIDER_ID) invalid(i, 'providerTransactionId must be 1-200 characters');
  }
}

export function validateBatch(batch: BankIngestionBatch, mode: IdentityMode): void {
  const seen = new Set<string>();
  batch.transactions.forEach((t, i) => {
    validateOne(t, i, mode);
    if (t.identity.kind === 'provider') {
      if (seen.has(t.identity.providerTransactionId)) {
        throw new BankIngestionRefusal('DUPLICATE_PROVIDER_ID', `Transaction ${i + 1}: provider id repeated in one batch`, i);
      }
      seen.add(t.identity.providerTransactionId);
    }
  });
}

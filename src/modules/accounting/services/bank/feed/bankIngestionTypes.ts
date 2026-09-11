// src/modules/accounting/services/bank/feed/bankIngestionTypes.ts
/** Canonical bank-feed ingestion contract (spec §1, Release 1 amendments). */
import type { FeedState } from '../../../types/bank.types';

export type { FeedState };

export interface BankIngestionSource {
  kind: 'feed';
  connectionId: string;
  providerBatchId?: string;
  cursor?: string;
}

export type BankTransactionIdentity =
  | { kind: 'provider'; providerTransactionId: string }
  | { kind: 'content_hash'; contentHash: string };

export interface NormalizedBankTransaction {
  identity: BankTransactionIdentity;
  state: FeedState;
  transactionDate: string;   // YYYY-MM-DD, a real calendar date
  valueDate?: string;
  amount: number;            // signed, finite
  currency: 'ZAR';
  description: string;
  reference?: string;
  balance?: number;
  providerUpdatedAt?: string; // ISO-8601
}

export interface BankIngestionBatch {
  source: BankIngestionSource;
  fetchedAt: string;
  transactions: NormalizedBankTransaction[];
}

export interface BankIngestionCounts {
  found: number; inserted: number; updated: number; duplicate: number;
  pending: number; removed: number; conflicts: number; ignored: number;
}

export interface BankIngestionResult {
  logId: string;
  importBatchId: string | null;
  counts: BankIngestionCounts;
  appliedSuggestions: number;
  warnings: string[];
}

export type IdentityMode = 'provider' | 'content_hash';

export type BankIngestionRefusalCode =
  | 'CONNECTION_NOT_FOUND' | 'CONNECTION_INACTIVE' | 'UNSUPPORTED_PROVIDER'
  | 'BANK_ACCOUNT_INVALID' | 'IDENTITY_MODE_MISMATCH' | 'INVALID_TRANSACTION'
  | 'DUPLICATE_PROVIDER_ID' | 'SYNC_IN_PROGRESS';

// `code` is a constructor parameter property, so `readonly code = '` (the
// MCP typedRefusalReachesAgent census grep) never matches this class. No MCP
// caller of ingestBankBatch exists today; if one is added, add these 8 codes
// to REFUSAL_CODES by hand.
export class BankIngestionRefusal extends Error {
  constructor(readonly code: BankIngestionRefusalCode, message: string, readonly index?: number) {
    super(message);
    this.name = 'BankIngestionRefusal';
  }
}

export function isBankIngestionRefusal(err: unknown): err is BankIngestionRefusal {
  return err instanceof Error && err.name === 'BankIngestionRefusal';
}

import type { DbRow } from '@/types/db';
/** Open Banking — shared types */

export type SupportedProvider = 'manual_csv' | 'extension';

export function isSupportedProvider(p: string): p is SupportedProvider {
  return p === 'manual_csv' || p === 'extension';
}

export type ConnectionStatus = 'active' | 'paused' | 'error' | 'disconnected';
export type SyncStatus = 'running' | 'success' | 'failed';

export interface BankFeedSyncCounts {
  found: number;
  imported: number;
  duplicate: number;
  updated: number;
  pending: number;
  removed: number;
  conflicts: number;
  completedAt: string | null;
}

export interface BankFeedConnection {
  id: string;
  companyId: string;
  provider: string;
  accountId: string | null;
  accountName: string | null;
  accountNumberMasked: string | null;
  externalAccountId: string | null;
  status: ConnectionStatus;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastSyncStatus: SyncStatus | null;
  lastSyncError: string | null;
  lastSync: BankFeedSyncCounts | null;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface BankFeedConnectionInput {
  provider: SupportedProvider;
  accountId?: string;          // FK to bank_accounts.id
  externalAccountId?: string;
  config?: Record<string, unknown>;
}

export interface BankFeedSyncResult {
  connectionId: string;
  provider: string;
  logId: string;
  found: number;
  imported: number;
  duplicate: number;
  instructions?: string;   // for manual_csv provider
}

export interface BankFeedSyncLog {
  id: string;
  connectionId: string;
  companyId: string;
  startedAt: string;
  completedAt: string | null;
  status: SyncStatus;
  transactionsFound: number;
  transactionsImported: number;
  transactionsDuplicate: number;
  transactionsUpdated: number;
  transactionsPending: number;
  transactionsRemoved: number;
  transactionsConflict: number;
  errorMessage: string | null;
  errorCode: string | null;
}

// ── Shared DB row mappers ─────────────────────────────────────────────────────


export function mapConnection(r: DbRow): BankFeedConnection {
  const hasLastSync = r.ls_completed_at != null || r.ls_found != null;
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    provider: String(r.provider),
    accountId: r.account_id != null ? String(r.account_id) : null,
    accountName: r.account_name != null ? String(r.account_name) : null,
    accountNumberMasked: r.account_number_masked != null ? String(r.account_number_masked) : null,
    externalAccountId: r.external_account_id != null ? String(r.external_account_id) : null,
    status: String(r.status ?? 'active') as ConnectionStatus,
    lastSyncAt: r.last_sync_at != null ? String(r.last_sync_at) : null,
    lastSuccessAt: r.last_success_at != null ? String(r.last_success_at) : null,
    lastSyncStatus: r.last_sync_status != null ? String(r.last_sync_status) as SyncStatus : null,
    lastSyncError: r.last_sync_error != null ? String(r.last_sync_error) : null,
    lastSync: hasLastSync ? {
      found: Number(r.ls_found ?? 0),
      imported: Number(r.ls_imported ?? 0),
      duplicate: Number(r.ls_duplicate ?? 0),
      updated: Number(r.ls_updated ?? 0),
      pending: Number(r.ls_pending ?? 0),
      removed: Number(r.ls_removed ?? 0),
      conflicts: Number(r.ls_conflict ?? 0),
      completedAt: r.ls_completed_at != null ? String(r.ls_completed_at) : null,
    } : null,
    config: (r.config as Record<string, unknown>) ?? {},
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function mapSyncLog(r: DbRow): BankFeedSyncLog {
  return {
    id: String(r.id),
    connectionId: String(r.connection_id),
    companyId: String(r.company_id),
    startedAt: String(r.started_at),
    completedAt: r.completed_at != null ? String(r.completed_at) : null,
    status: String(r.status) as SyncStatus,
    transactionsFound: Number(r.transactions_found ?? 0),
    transactionsImported: Number(r.transactions_imported ?? 0),
    transactionsDuplicate: Number(r.transactions_duplicate ?? 0),
    transactionsUpdated: Number(r.transactions_updated ?? 0),
    transactionsPending: Number(r.transactions_pending ?? 0),
    transactionsRemoved: Number(r.transactions_removed ?? 0),
    transactionsConflict: Number(r.transactions_conflict ?? 0),
    errorMessage: r.error_message != null ? String(r.error_message) : null,
    errorCode: r.error_code != null ? String(r.error_code) : null,
  };
}

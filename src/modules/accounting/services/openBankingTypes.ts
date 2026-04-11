/** Open Banking — shared types */

export type Provider = 'manual_csv' | 'basiq' | 'tink' | 'plaid';
export type ConnectionStatus = 'active' | 'paused' | 'error';
export type SyncStatus = 'running' | 'success' | 'failed';

export interface BankFeedConnection {
  id: string;
  companyId: string;
  provider: Provider;
  accountId: string | null;
  accountName: string | null;
  externalAccountId: string | null;
  status: ConnectionStatus;
  lastSyncAt: string | null;
  lastSyncStatus: SyncStatus | null;
  lastSyncError: string | null;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface BankFeedConnectionInput {
  provider: Provider;
  accountId?: string;          // FK to bank_accounts.id
  externalAccountId?: string;
  config?: Record<string, unknown>;
}

export interface BankFeedSyncResult {
  connectionId: string;
  provider: Provider;
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
  errorMessage: string | null;
}

// ── Shared DB row mappers ─────────────────────────────────────────────────────

type Row = Record<string, unknown>;

export function mapConnection(r: Row): BankFeedConnection {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    provider: String(r.provider) as Provider,
    accountId: r.account_id != null ? String(r.account_id) : null,
    accountName: r.account_name != null ? String(r.account_name) : null,
    externalAccountId: r.external_account_id != null ? String(r.external_account_id) : null,
    status: String(r.status ?? 'active') as ConnectionStatus,
    lastSyncAt: r.last_sync_at != null ? String(r.last_sync_at) : null,
    lastSyncStatus: r.last_sync_status != null ? String(r.last_sync_status) as SyncStatus : null,
    lastSyncError: r.last_sync_error != null ? String(r.last_sync_error) : null,
    config: (r.config as Record<string, unknown>) ?? {},
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function mapSyncLog(r: Row): BankFeedSyncLog {
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
    errorMessage: r.error_message != null ? String(r.error_message) : null,
  };
}

/** Shared UI types for the Bank Feeds feature */

export type Provider = 'manual_csv' | 'basiq' | 'tink' | 'plaid' | 'extension';
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

export interface SyncLog {
  id: string;
  connectionId: string;
  startedAt: string;
  completedAt: string | null;
  status: SyncStatus;
  transactionsFound: number;
  transactionsImported: number;
  transactionsDuplicate: number;
  errorMessage: string | null;
}

export interface BankAccount {
  id: string;
  accountName: string;
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  manual_csv: 'Manual CSV Upload',
  basiq: 'Basiq (Open Banking AU/ZA)',
  tink: 'Tink (Open Banking EU)',
  plaid: 'Plaid (Open Banking US)',
  extension: 'Direct via Browser Extension',
};

export const PROVIDER_DESCRIPTIONS: Record<Provider, string> = {
  manual_csv: 'Import bank statements manually via CSV file upload.',
  basiq: 'Connect directly to SA/AU banks via the Basiq API (requires Basiq API key).',
  tink: 'Connect to European banks via Tink Open Banking (requires Tink credentials).',
  plaid: 'Connect to US and international banks via Plaid (requires Plaid credentials).',
  extension: 'Use the IsaFlow Bank Connector Chrome extension to import from your authenticated bank session. No credentials leave your browser.',
};

export const STATUS_STYLES: Record<ConnectionStatus, { cls: string; label: string }> = {
  active: { cls: 'bg-teal-500/20 text-teal-400', label: 'Active' },
  paused: { cls: 'bg-amber-500/20 text-amber-400', label: 'Paused' },
  error: { cls: 'bg-red-500/20 text-red-400', label: 'Error' },
};

export const SYNC_STATUS_STYLES: Record<SyncStatus, { cls: string; label: string }> = {
  success: { cls: 'bg-teal-500/20 text-teal-400', label: 'Success' },
  running: { cls: 'bg-blue-500/20 text-blue-400', label: 'Running' },
  failed: { cls: 'bg-red-500/20 text-red-400', label: 'Failed' },
};

export function fmtDate(d: string | null): string {
  return d ? new Date(d).toLocaleString('en-ZA', { dateStyle: 'short', timeStyle: 'short' }) : '—';
}

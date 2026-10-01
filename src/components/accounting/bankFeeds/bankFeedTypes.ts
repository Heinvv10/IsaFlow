/** Shared UI types for the Bank Feeds feature */

export type SupportedProvider = 'manual_csv' | 'extension';
export type ConnectionStatus = 'active' | 'paused' | 'error' | 'disconnected';
export type SyncStatus = 'running' | 'success' | 'failed';

export function isSupportedProvider(p: string): p is SupportedProvider {
  return p === 'manual_csv' || p === 'extension';
}

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

/**
 * basiq | tink | plaid never had an integration behind them. New connections
 * are refused by the API; legacy rows still render, so the card disables Sync
 * for them rather than letting the user trigger a guaranteed failure.
 */
export function isUnsupportedProvider(provider: string): boolean {
  return !isSupportedProvider(provider);
}

export const PROVIDER_LABELS: Record<SupportedProvider, string> = {
  extension: 'ABSA browser import',
  manual_csv: 'Import statements',
};

export const PROVIDER_DESCRIPTIONS: Record<SupportedProvider, string> = {
  extension: 'User-operated: open the IsaFlow extension in your signed-in ABSA tab and import. IsaFlow never sees your banking password and cannot fetch in the background.',
  manual_csv: 'User-operated: upload CSV, PDF, OFX or QIF statements on the Bank Transactions page.',
};

/** A legacy connection whose provider was never built is labelled as such, not offered as a choice. */
export function providerLabel(p: string): string {
  return isSupportedProvider(p) ? PROVIDER_LABELS[p] : `Unsupported legacy connection (${p})`;
}

export const STATUS_STYLES: Record<ConnectionStatus, { cls: string; label: string }> = {
  active: { cls: 'bg-teal-500/20 text-teal-400', label: 'Active' },
  paused: { cls: 'bg-amber-500/20 text-amber-400', label: 'Paused' },
  error: { cls: 'bg-red-500/20 text-red-400', label: 'Error' },
  disconnected: { cls: 'bg-gray-500/20 text-gray-400', label: 'Disconnected' },
};

export const SYNC_STATUS_STYLES: Record<SyncStatus, { cls: string; label: string }> = {
  success: { cls: 'bg-teal-500/20 text-teal-400', label: 'Success' },
  running: { cls: 'bg-blue-500/20 text-blue-400', label: 'Running' },
  failed: { cls: 'bg-red-500/20 text-red-400', label: 'Failed' },
};

export function fmtDate(d: string | null): string {
  return d ? new Date(d).toLocaleString('en-ZA', { dateStyle: 'short', timeStyle: 'short' }) : '—';
}

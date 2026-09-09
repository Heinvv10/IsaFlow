/**
 * Open Banking Service — multi-provider bank feed connection management.
 *
 * Supports providers: extension | manual_csv. basiq/tink/plaid have no
 * integration behind them: creating one is refused, and syncing a legacy one
 * fails rather than importing anything.
 *
 * Deduplication: uses bank_transactions.bank_reference (external tx ID).
 * Fallback dedup when bank_reference is unavailable: amount + date + description.
 *
 * Domain split:
 *   openBankingService.ts       — types, connection CRUD, sync logs query
 *   openBankingSyncService.ts   — transaction fetching, dedup, sync orchestration
 */

export {
  listBankFeedConnections,
  createBankFeedConnection,
  deleteBankFeedConnection,
  getBankFeedSyncLogs,
} from './openBankingConnectionService';

export { syncBankFeed } from './openBankingSyncService';

export type {
  Provider,
  ConnectionStatus,
  SyncStatus,
  BankFeedConnection,
  BankFeedConnectionInput,
  BankFeedSyncResult,
  BankFeedSyncLog,
} from './openBankingTypes';

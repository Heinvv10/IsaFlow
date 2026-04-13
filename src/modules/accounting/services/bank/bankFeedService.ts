/**
 * Bank Feed Service — re-export facade for backward compatibility.
 *
 * Domain logic lives in:
 *   bankFeedConnectionService.ts — OAuth, token management, connection CRUD, GraphQL
 *   bankFeedSyncService.ts       — transaction fetching, sync orchestration, history
 *
 * Environment variables required:
 *   STITCH_CLIENT_ID     — Stitch application client ID
 *   STITCH_CLIENT_SECRET — Stitch application secret
 *   STITCH_REDIRECT_URI  — OAuth callback URL
 */

// Types
export type {
  BankFeedConnection,
  StitchTransaction,
  StitchAccount,
  SyncResult,
} from './bankFeedConnectionService';

// Connection management
export {
  isConfigured,
  getAuthorizationUrl,
  exchangeCode,
  refreshAccessToken,
  fetchStitchAccounts,
  listConnections,
  getConnection,
  createConnection,
  disconnectConnection,
} from './bankFeedConnectionService';

// Sync
export {
  fetchStitchTransactions,
  syncTransactions,
  getSyncHistory,
} from './bankFeedSyncService';

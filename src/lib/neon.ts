/**
 * pg.Pool-backed SQL client — the app's one database entry point.
 *
 * Connects to any vanilla PostgreSQL over TCP (Supabase self-hosted,
 * RDS, etc.), preserving the public surface that the rest of the app
 * depends on:
 *
 *   - `sql\`...\`` tagged template returning rows
 *   - `sql.transaction([q1, q2])` array form (Neon-style batching)
 *   - `sql.transaction((tx) => [q1, q2], { isolationLevel })` callback form
 *   - `transaction((tx) => [...])` helper re-export (unchanged call sites)
 *   - `withTransaction(async (tx) => {...})` sequential helper (unchanged)
 *   - `fmtDate()` and `DbRow`
 *
 * This file is a barrel (R-184). The code lives in src/lib/neon/:
 *   - pool.ts        the lazily built process-wide pool and its accessors
 *   - query.ts       LazyQuery (an awaitable query) and the $N query builder
 *   - sql.ts         `sql`, `sql.transaction`, `transaction()`
 *   - transaction.ts `withTransaction`, `withSavepoint`
 *   - savepointQueue.ts `SavepointQueueTimeoutError`, `savepointQueueWait` (siblings on one connection queue)
 * Import from '@/lib/neon' only, never from those modules: `vi.mock('@/lib/neon')`
 * intercepts this file, so a direct import of a module would slip past it.
 */

import { sql } from './neon/sql';

export type { DbRow } from './neon/query';
export { getPool, getPoolForTests, getDbPool } from './neon/pool';
export { sql, transaction } from './neon/sql';
export { withTransaction, withSavepoint } from './neon/transaction';
export { SavepointQueueTimeoutError, savepointQueueWait } from './neon/savepointQueue';
export type { TxSql } from './neon/transaction';
export { assertTxUsable } from '@/lib/als';

// fmtDate lives in its own module because it is a pure function with no
// connection or pool dependency, and keeping it here made every
// vi.mock('@/lib/neon') in the test suite delete it. Re-exported so the
// existing `import { fmtDate } from '@/lib/neon'` call sites keep working.
export { fmtDate } from '@/lib/fmtDate';

export default sql;

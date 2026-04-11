/**
 * Neon Database Client
 * Standalone serverless PostgreSQL connection for the Accounting app
 * Uses @neondatabase/serverless with retry logic and proper config
 */

import { neon, neonConfig } from '@neondatabase/serverless';
import pg from 'pg';

/** Shared DB row type — import this instead of declaring local `type Row` */
export type DbRow = Record<string, unknown>;
import { log } from '@/lib/logger';

// Enable connection caching for better performance
neonConfig.fetchConnectionCache = true;

// Configure transport for Node.js environments (not in browser/edge)
declare const EdgeRuntime: unknown;

const isNodeEnv =
  typeof window === 'undefined' &&
  typeof EdgeRuntime === 'undefined';

if (isNodeEnv) {
  const useHttpTransport = process.env.NEON_USE_HTTP === 'true';

  if (!useHttpTransport) {
    // WebSocket transport - faster for Node.js
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ws = require('ws');
      neonConfig.webSocketConstructor = ws;
      log.info('Using WebSocket transport', {}, 'Neon');
    } catch {
      log.info('WebSocket not available, falling back to HTTP', {}, 'Neon');
    }
  } else {
    log.info('Using HTTP transport (NEON_USE_HTTP=true)', {}, 'Neon');
  }

  // Configure WebSocket proxy (Neon v2 protocol)
  neonConfig.wsProxy = (host: string, port: number | string) => `${host}:${port}/v2`;

  // Use secure WebSocket connections
  neonConfig.useSecureWebSocket = true;

  // Pipeline authentication for faster connections
  neonConfig.pipelineConnect = 'password';

  // Enable automatic retries on transient errors
  neonConfig.fetchFunction = async (...args: Parameters<typeof fetch>) => {
    const maxRetries = 3;
    let lastError: unknown;

    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetch(...args);
        if (!response.ok && response.status >= 500 && i < maxRetries - 1) {
          // Retry on server errors with exponential backoff
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 100));
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (i < maxRetries - 1) {
          // Exponential backoff: 100ms, 200ms, 400ms
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 100));
          continue;
        }
      }
    }
    throw lastError || new Error('Request failed after retries');
  };
}

/**
 * Get the DATABASE_URL, throwing a clear error if not set
 */
function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Please configure it in your environment.');
  }
  return url;
}

/**
 * Serverless SQL client for use in API routes and edge functions.
 * Use tagged template literals: sql`SELECT * FROM table WHERE id = ${id}`
 */
export const sql = neon(getDatabaseUrl());

/**
 * Execute multiple queries in a transaction using the Neon serverless driver.
 *
 * IMPORTANT: The Neon HTTP driver is stateless — each tagged template call is an
 * independent HTTP request. Issuing BEGIN/COMMIT as separate calls does NOT
 * guarantee they run on the same connection. We use the official `transaction()`
 * API from @neondatabase/serverless which batches queries into a single HTTP request.
 *
 * @param queries - Array of query-producing functions that receive the sql client
 * @returns Array of query results
 *
 * @example
 * const results = await transaction([
 *   (sql) => sql`INSERT INTO accounts (name) VALUES (${'Cash'}) RETURNING id`,
 *   (sql) => sql`UPDATE balances SET amount = 0 WHERE account_id = ${id}`,
 * ]);
 */
export async function transaction(
  queriesFn: (txSql: typeof sql) => Array<ReturnType<typeof sql>>
): Promise<unknown[]> {
  try {
    // Reuse module-level sql client instead of creating a new neon() client per call
    const results = await sql.transaction(
      (tx) => queriesFn(tx as unknown as typeof sql) as any,
      { isolationLevel: 'ReadCommitted' }
    );
    return results as unknown[];
  } catch (error) {
    log.error(
      'Transaction failed',
      error instanceof Error ? { message: error.message } : { error },
      'Neon'
    );
    throw error;
  }
}

/**
 * Execute a sequential, multi-step transaction using a dedicated pool client.
 *
 * Unlike `transaction()` above (which batches static queries in a single HTTP
 * round-trip), `withTransaction` allows intermediate `await` calls inside the
 * callback — necessary when later queries depend on IDs returned by earlier
 * inserts (INSERT … RETURNING id → INSERT … WHERE fk = id).
 *
 * The pool client issues genuine BEGIN / COMMIT / ROLLBACK, giving full ACID
 * guarantees. Any error thrown inside `fn` triggers an automatic ROLLBACK.
 *
 * @example
 * const invoiceId = await withTransaction(async (tx) => {
 *   const [row] = await tx`INSERT INTO invoices (total) VALUES (${total}) RETURNING id`;
 *   await tx`INSERT INTO invoice_items (invoice_id) VALUES (${row.id})`;
 *   return String(row.id);
 * });
 */
/**
 * Derive a direct (non-pooler) connection URL from the DATABASE_URL.
 * The Neon pooler uses PgBouncer in transaction mode which doesn't support
 * session-level BEGIN/COMMIT via the pg driver. The direct URL bypasses
 * PgBouncer and gives a full PostgreSQL session.
 *
 * Neon pooler hostname: ep-xxx-pooler.region.aws.neon.tech
 * Neon direct hostname: ep-xxx.region.aws.neon.tech
 */
function getDirectUrl(): string {
  const url = getDatabaseUrl();
  // Remove '-pooler' from the hostname and 'channel_binding=require' from query params
  return url.replace('-pooler.', '.').replace('&channel_binding=require', '').replace('?channel_binding=require', '?');
}

let _pgPool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!_pgPool) {
    _pgPool = new pg.Pool({
      connectionString: getDirectUrl(),
      max: 5,
      connectionTimeoutMillis: 15000,
      idleTimeoutMillis: 30000,
      ssl: { rejectUnauthorized: false },
    });
    _pgPool.on('error', (err) => {
      log.warn('pg pool background error', { message: err.message }, 'Neon');
    });
  }
  return _pgPool;
}

// Type for a transaction-scoped sql tagged-template function
export type TxSql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

export async function withTransaction<T>(fn: (tx: TxSql) => Promise<T>): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Wrap the pool client's parameterised query as a tagged-template function
    // so callers can use tx`SELECT ...` instead of raw client.query strings.
    const tx: TxSql = async (strings, ...values) => {
      let text = '';
      strings.forEach((s, i) => {
        text += s;
        if (i < values.length) text += `$${i + 1}`;
      });
      const result = await client.query(text, values as unknown[]);
      return result.rows as unknown[];
    };

    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    log.error(
      'withTransaction rolled back',
      error instanceof Error ? { message: error.message } : { error },
      'Neon'
    );
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Format a value from a DB date column as an ISO date string (YYYY-MM-DD).
 *
 * The @neondatabase/serverless driver returns PostgreSQL `date` columns as
 * JavaScript Date objects. Calling String() on them produces a locale-specific
 * string ("Sat Apr 11 2026 00:00:00 GMT+0200 ...") which PostgreSQL cannot
 * parse when used as a query parameter. This helper extracts the local-time
 * date portion regardless of whether the value is already a string or a Date.
 *
 * @param val - Raw value from a DB `date` column (Date object or string)
 * @returns  YYYY-MM-DD string suitable for use in SQL parameters
 */
export function fmtDate(val: unknown): string {
  if (!val) return '';
  if (val instanceof Date) {
    // Use local-time date parts to avoid UTC off-by-one on midnight dates
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  // Already a string — return as-is (may be YYYY-MM-DD already)
  const s = String(val);
  // If it looks like an ISO timestamp (contains 'T'), extract date portion
  if (s.includes('T')) return s.split('T')[0]!;
  return s;
}

export default sql;

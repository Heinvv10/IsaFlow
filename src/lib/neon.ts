/**
 * Neon Database Client
 * Standalone serverless PostgreSQL connection for the Accounting app
 * Uses @neondatabase/serverless with retry logic and proper config
 */

import { neon, neonConfig } from '@neondatabase/serverless';
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
 * Execute multiple queries in a transaction using the serverless client.
 *
 * @param callback - Async function receiving the sql client
 * @returns The result of the callback
 *
 * @example
 * const result = await transaction(async (tx) => {
 *   await tx`INSERT INTO accounts ...`;
 *   await tx`UPDATE balances ...`;
 *   return { success: true };
 * });
 */
export async function transaction<T>(
  callback: (client: typeof sql) => Promise<T>
): Promise<T> {
  try {
    await sql`BEGIN`;
    const result = await callback(sql);
    await sql`COMMIT`;
    return result;
  } catch (error) {
    await sql`ROLLBACK`;
    log.error(
      'Transaction rolled back',
      error instanceof Error ? { message: error.message } : { error },
      'Neon'
    );
    throw error;
  }
}

export default sql;

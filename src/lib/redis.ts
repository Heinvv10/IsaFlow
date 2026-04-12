/**
 * Singleton Redis client backed by ioredis.
 *
 * Returns null when REDIS_URL is not set so callers can fall back to their
 * in-memory implementation gracefully.
 *
 * Optional env var: REDIS_URL (e.g. redis://localhost:6379 or a managed URL)
 * When not set, all Redis-backed features degrade to their in-memory equivalents.
 */

import Redis from 'ioredis';
import { log } from '@/lib/logger';

let client: Redis | null = null;

/**
 * Returns the shared Redis client, or null if REDIS_URL is not configured.
 * The client uses lazyConnect so no connection is attempted at import time.
 */
export function getRedisClient(): Redis | null {
  if (!process.env.REDIS_URL) return null;

  if (!client) {
    client = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2000,
    });

    client.on('error', (err: Error) => {
      log.warn('Redis client error', { message: err.message }, 'redis');
    });
  }

  return client;
}

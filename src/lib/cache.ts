/**
 * WS-5.1: In-Process LRU Cache
 * No external Redis dependency — single-process Next.js server cache.
 */

import { LRUCache } from 'lru-cache';
import { log } from '@/lib/logger';

interface CacheOptions {
  maxSize?: number;   // Max entries (default 10000)
  defaultTTL?: number; // Default TTL in ms (default 5 min)
}

class AppCache {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private cache: LRUCache<string, any>;
  private hitCount = 0;
  private missCount = 0;

  constructor(options?: CacheOptions) {
    this.cache = new LRUCache({
      max: options?.maxSize ?? 10000,
      ttl: options?.defaultTTL ?? 5 * 60 * 1000,
      allowStale: false,
    });
  }

  get<T>(key: string): T | undefined {
    const val = this.cache.get(key) as T | undefined;
    if (val !== undefined) {
      this.hitCount++;
    } else {
      this.missCount++;
    }
    return val;
  }

  set<T>(key: string, value: T, ttl?: number): void {
    this.cache.set(key, value, ttl !== undefined ? { ttl } : undefined);
  }

  invalidate(key: string): void {
    this.cache.delete(key);
    log.info('Cache invalidated', { key }, 'cache');
  }

  invalidatePrefix(prefix: string): void {
    let count = 0;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        count++;
      }
    }
    log.info('Cache prefix invalidated', { prefix, count }, 'cache');
  }

  invalidateCompany(companyId: string): void {
    this.invalidatePrefix(`${companyId}:`);
  }

  stats(): { size: number; hitCount: number; missCount: number; hitRate: string } {
    const total = this.hitCount + this.missCount;
    return {
      size: this.cache.size,
      hitCount: this.hitCount,
      missCount: this.missCount,
      hitRate: total > 0 ? `${Math.round((this.hitCount / total) * 100)}%` : '0%',
    };
  }

  clear(): void {
    this.cache.clear();
    this.hitCount = 0;
    this.missCount = 0;
    log.info('Cache cleared', {}, 'cache');
  }
}

// Singleton — lives in the Next.js server process
export const cache = new AppCache();

/**
 * Cache-through helper: returns cached value if present,
 * otherwise calls fetcher, stores the result, and returns it.
 */
export async function cacheThrough<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttl?: number,
): Promise<T> {
  const cached = cache.get<T>(key);
  if (cached !== undefined) return cached;

  const result = await fetcher();
  cache.set(key, result, ttl);
  return result;
}

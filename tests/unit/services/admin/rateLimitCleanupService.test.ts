/**
 * Tests for cleanupRateLimitData (M14 / WS-2b).
 *
 * DB-backed: inserts test rows, runs cleanup, asserts old rows are gone and
 * fresh rows survive. Cleans up after itself.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { isDbReachable } from '../../helpers/dbReachable';
import { cleanupRateLimitData } from '@/modules/admin/services/rateLimitCleanupService';

const OLD_KEY = 'test:cleanup:old:' + Date.now();
const FRESH_KEY = 'test:cleanup:fresh:' + Date.now();

const hasRealDb = await isDbReachable();

describe('cleanupRateLimitData (M14)', () => {
  beforeAll(async () => {
    if (!hasRealDb) return;

    // Insert an OLD counter (window_start = 2 days ago — beyond the 1-day threshold).
    await sql`
      INSERT INTO rate_limit_counters (key, count, window_start)
      VALUES (${OLD_KEY}, 5, NOW() - INTERVAL '2 days')
      ON CONFLICT (key) DO UPDATE SET count = 5, window_start = NOW() - INTERVAL '2 days'
    `;

    // Insert a FRESH counter (window_start = 1 minute ago — must survive).
    await sql`
      INSERT INTO rate_limit_counters (key, count, window_start)
      VALUES (${FRESH_KEY}, 1, NOW() - INTERVAL '1 minute')
      ON CONFLICT (key) DO UPDATE SET count = 1, window_start = NOW() - INTERVAL '1 minute'
    `;
  });

  afterAll(async () => {
    if (!hasRealDb) return;
    await sql`DELETE FROM rate_limit_counters WHERE key IN (${OLD_KEY}, ${FRESH_KEY})`;
  });

  it.skipIf(!hasRealDb)(
    'deletes stale counter rows and leaves fresh rows intact',
    async () => {
      const result = await cleanupRateLimitData();

      // At least the OLD_KEY row must have been deleted.
      expect(result.countersDeleted).toBeGreaterThanOrEqual(1);

      // lockoutsDeleted should be a non-negative number (table may be empty).
      expect(result.lockoutsDeleted).toBeGreaterThanOrEqual(0);

      // OLD_KEY must be gone.
      const oldRows = (await sql`
        SELECT key FROM rate_limit_counters WHERE key = ${OLD_KEY}
      `) as { key: string }[];
      expect(oldRows).toHaveLength(0);

      // FRESH_KEY must still exist.
      const freshRows = (await sql`
        SELECT key FROM rate_limit_counters WHERE key = ${FRESH_KEY}
      `) as { key: string }[];
      expect(freshRows).toHaveLength(1);
    },
  );
});

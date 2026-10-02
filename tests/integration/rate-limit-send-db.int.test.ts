/**
 * Tests for checkSendRateLimit — M13 (WS-2b).
 *
 * Verifies the per-IP bucket is enforced when ipMax is exceeded.
 *
 * Against real PostgreSQL. Moved here from tests/unit/lib/rateLimitSend.test.ts
 * in R-175: there it ran against whatever DATABASE_URL vitest.config.ts found
 * in .env.local and wrote test keys to the shared dev database. Here it needs
 * the disposable fixture, and the name is random per run.
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll, beforeAll, afterEach } from 'vitest';
import type { NextApiRequest } from 'next';
import { checkSendRateLimit, clearRateLimitCache } from '@/lib/rateLimit';
import { getPoolForTests, sql } from '@/lib/neon';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
afterAll(() => getPoolForTests().end());

const TEST_NAME = `test-${randomUUID()}`;
const TEST_COMPANY = '00000000-0000-0000-0000-000000000099';
const TEST_IP = '203.0.113.99';
const KEY_PATTERN = `send:${TEST_NAME}:%`;

function makeReq(ip = TEST_IP): NextApiRequest {
  return {
    headers: { 'x-forwarded-for': ip },
    socket: { remoteAddress: ip },
  } as unknown as NextApiRequest;
}

describe('checkSendRateLimit — DB-backed (M13)', () => {
  beforeAll(async () => {
    await sql`DELETE FROM rate_limit_counters WHERE key LIKE ${KEY_PATTERN}`;
  });

  afterEach(async () => {
    await sql`DELETE FROM rate_limit_counters WHERE key LIKE ${KEY_PATTERN}`;
    clearRateLimitCache();
  });

  it(
    'returns false once the per-IP limit is exceeded',
    async () => {
      const req = makeReq();

      // Make ipMax calls — all should be allowed.
      const ipMax = 2;
      for (let i = 0; i < ipMax; i++) {
        const allowed = await checkSendRateLimit(req, TEST_COMPANY, TEST_NAME, { ipMax });
        expect(allowed).toBe(true);
      }

      // Forget any remembered refusal so the next call is decided by the DB.
      clearRateLimitCache();

      // One more call must hit the DB and see count > ipMax → blocked.
      // We make one extra call to ensure DB counter reaches the max.
      await checkSendRateLimit(req, TEST_COMPANY, TEST_NAME, { ipMax });
      clearRateLimitCache();

      const blocked = await checkSendRateLimit(req, TEST_COMPANY, TEST_NAME, { ipMax });
      expect(blocked).toBe(false);
    },
  );

  it(
    'uses send: key prefix (not ai:)',
    async () => {
      const req = makeReq('203.0.113.100');
      await checkSendRateLimit(req, TEST_COMPANY, TEST_NAME, { ipMax: 5 });

      const rows = (await sql`
        SELECT key FROM rate_limit_counters
        WHERE key LIKE ${'send:' + TEST_NAME + ':%'}
        LIMIT 5
      `) as { key: string }[];

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.key.startsWith('send:')).toBe(true);
      }
    },
  );

  it(
    'weights the company/day VOLUME buckets by count, but charges the per-IP RATE bucket 1',
    async () => {
      const req = makeReq('203.0.113.101');

      // A single call with count=40 consumes 40 units of the company (volume)
      // bucket but only 1 unit of the IP (request-rate) bucket.
      const allowed = await checkSendRateLimit(req, TEST_COMPANY, TEST_NAME, {
        companyMax: 50,
        count: 40,
      });
      expect(allowed).toBe(true);

      clearRateLimitCache();
      const co = (await sql`
        SELECT count FROM rate_limit_counters WHERE key = ${`send:${TEST_NAME}:co:${TEST_COMPANY}`}
      `) as { count: number }[];
      expect(co[0]?.count).toBe(40); // company/volume bucket weighted by count

      const ipRows = (await sql`
        SELECT count FROM rate_limit_counters WHERE key = ${`send:${TEST_NAME}:ip:203.0.113.101`}
      `) as { count: number }[];
      expect(ipRows[0]?.count).toBe(1); // IP/rate bucket charged 1, not 40
    },
  );

  it(
    'a single legitimate large batch (count > ipMax) is NOT blocked by the per-IP rate bucket',
    async () => {
      const req = makeReq('203.0.113.103');
      // 100 recipients > default ipMax(30): must still be allowed because the IP
      // bucket is charged 1, and the volume buckets have ample headroom here.
      const allowed = await checkSendRateLimit(req, TEST_COMPANY, TEST_NAME, {
        ipMax: 30,
        companyMax: 2_000,
        dailyMax: 10_000,
        count: 100,
      });
      expect(allowed).toBe(true);
    },
  );

  it(
    'a batch whose count exceeds the company VOLUME budget is rejected in a single call',
    async () => {
      const req = makeReq('203.0.113.102');
      const blocked = await checkSendRateLimit(req, TEST_COMPANY, TEST_NAME, {
        companyMax: 60,
        count: 100, // 100 emails > 60 company volume budget → rejected (by company bucket)
      });
      expect(blocked).toBe(false);
    },
  );
});

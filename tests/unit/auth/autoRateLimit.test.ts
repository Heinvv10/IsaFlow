/**
 * R-175 review round 3: withAuth (cookie) and the bearer pipeline apply the
 * same per-company bucket to heavy report routes. Each held its own copy of
 * the table and both write `reports:<company>`; had the copies drifted, each
 * path would have reset the other's window. There is one table now.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { check } = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: check }));

import { AUTO_RATE_LIMIT, checkAutoRateLimit } from '@/lib/auth/autoRateLimit';

const read = (file: string) => readFileSync(path.resolve(__dirname, '../../..', file), 'utf8');

describe('checkAutoRateLimit (R-175)', () => {
  beforeEach(() => {
    check.mockReset();
    check.mockResolvedValue(true);
  });

  it('charges the company bucket for a reports route, with or without a query string', async () => {
    expect(await checkAutoRateLimit('/api/accounting/reports-pdf?from=2026-01-01', 'co-1')).toBe(true);
    expect(await checkAutoRateLimit('/api/accounting/reports-pack', 'co-2')).toBe(true);

    expect(check.mock.calls).toEqual([
      ['reports:co-1', { max: 60, windowSecs: 60 }],
      ['reports:co-2', { max: 60, windowSecs: 60 }],
    ]);
  });

  it('answers false when the bucket refuses', async () => {
    check.mockResolvedValue(false);

    expect(await checkAutoRateLimit('/api/accounting/reports-html', 'co-1')).toBe(false);
  });

  it('charges nothing for a route with no bucket', async () => {
    expect(await checkAutoRateLimit('/api/accounting/customers', 'co-1')).toBe(true);
    expect(await checkAutoRateLimit(undefined, 'co-1')).toBe(true);
    expect(await checkAutoRateLimit('/api/accounting/reportsX', 'co-1')).toBe(true);

    expect(check).not.toHaveBeenCalled();
  });

  it('is the only table: both wrappers call it and neither keeps a copy', () => {
    expect(AUTO_RATE_LIMIT).toEqual([{ prefix: '/api/accounting/reports-', key: 'reports', max: 60, windowSecs: 60 }]);
    for (const file of ['src/lib/auth/withAuth.ts', 'src/lib/auth/bearerPipeline.ts']) {
      const source = read(file);
      expect(source).toContain('await checkAutoRateLimit(req.url,');
      expect(source).not.toContain('AUTO_RATE_LIMIT');
      expect(source).not.toMatch(/checkRateLimit\(/);
    }
  });
});

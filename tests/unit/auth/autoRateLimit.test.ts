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

import { AUTO_RATE_LIMIT, chargeAuditJob, checkAutoRateLimit } from '@/lib/auth/autoRateLimit';

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

  it('charges each member\'s own audit bucket for the whole-ledger audit jobs only', async () => {
    const charged: [string, string][] = [['POST', '/api/accounting/audit-snapshots'], ['GET', '/api/accounting/audit-snapshots?id=x&verify=1'],
      ['GET', '/api/accounting/audit-snapshots?chain=1'], ['GET', '/api/accounting/audit-comparisons?snapshotId=x'],
      ['POST', '/api/accounting/audit-check-runs'], ['POST', '/api/accounting/audit-exports'],
      ['GET', '/api/accounting/audit-exports/e1?verify=1'], ['GET', '/api/accounting/audit-exports/e1/download']];
    for (const [method, path] of charged) expect(await checkAutoRateLimit(path, 'co-9', 'u-1', method)).toBe(true);
    // Each member's own bucket: one member's requests (refused or not) never spend another's allowance.
    expect(await checkAutoRateLimit('/api/accounting/audit-comparisons', 'co-9', 'u-2', 'GET')).toBe(true);
    expect(check.mock.calls).toEqual([...Array(charged.length).fill(['audit:co-9:u-1', { max: 30, windowSecs: 60 }]),
      ['audit:co-9:u-2', { max: 30, windowSecs: 60 }]]);
  });

  it('charges nothing for browsing a snapshot, the audit log or the trail export (blind r2 M1)', async () => {
    const free: [string, string][] = [['GET', '/api/accounting/audit-log?search=a'], ['GET', '/api/accounting/audit-log-entity'],
      ['GET', '/api/accounting/audit-log-export'], ['POST', '/api/accounting/audit-trail-export'],
      ['GET', '/api/accounting/audit-snapshots'], ['GET', '/api/accounting/audit-snapshots?id=x&section=journals&page=2'],
      ['GET', '/api/accounting/audit-check-runs?id=r'], ['GET', '/api/accounting/audit-exports'],
      ['GET', '/api/accounting/audit-exports/e1/sessions']];
    for (const [method, path] of free) expect(await checkAutoRateLimit(path, 'co-9', 'u-1', method)).toBe(true);
    expect(check).not.toHaveBeenCalled();
  });

  it('chargeAuditJob charges the same per-member audit bucket the routes do (the MCP tools)', async () => {
    expect(await chargeAuditJob('co-9', 'u-1')).toBe(true);
    expect(check.mock.calls).toEqual([['audit:co-9:u-1', { max: 30, windowSecs: 60 }]]);
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
    expect(AUTO_RATE_LIMIT.map(({ prefix, key, max, windowSecs, perUser }) => ({ prefix, key, max, windowSecs, perUser }))).toEqual([
      { prefix: '/api/accounting/reports-', key: 'reports', max: 60, windowSecs: 60, perUser: undefined },
      ...['audit-snapshots', 'audit-comparisons', 'audit-check-runs', 'audit-exports'].map((r) =>
        ({ prefix: `/api/accounting/${r}`, key: 'audit', max: 30, windowSecs: 60, perUser: true }))]);
    for (const file of ['src/lib/auth/withAuth.ts', 'src/lib/auth/bearerPipeline.ts']) {
      const source = read(file);
      expect(source).toMatch(/await checkAutoRateLimit\(req\.url, [^)]*, req\.method\)/);
      expect(source).not.toContain('AUTO_RATE_LIMIT');
      expect(source).not.toMatch(/checkRateLimit\(/);
    }
  });
});

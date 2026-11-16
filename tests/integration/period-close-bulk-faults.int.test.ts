/**
 * Bulk Close faults (review round 2 of PR #1451):
 *   arch C  An error with no SQLSTATE and no refusal type part-way through a
 *           Bulk Close used to be a 400 that COMMITted the earlier periods
 *           while saying "failed". It is a 500 now and nothing is closed.
 *   N2a     A repeated id is one period: one write, one result row.
 * The fault is injected by wrapping the real readiness gate (vi.mock) so it
 * throws a plain Error for one chosen period.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { members } from './entity-changes.helpers';
import { cleanupAudit } from './audit-snapshots.helpers';
import { gateFixture } from './helpers/periodCloseGateFixture';

const fault = vi.hoisted(() => ({ periodId: '' }));
vi.mock('@/modules/accounting/services/gl/periodCloseGate', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/gl/periodCloseGate')>();
  return {
    ...real,
    assertPeriodCloseReady: async (...args: Parameters<typeof real.assertPeriodCloseReady>) => {
      if (args[1] === fault.periodId) throw new Error('an untyped fault inside the close');
      return real.assertPeriodCloseReady(...args);
    },
  };
});

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const fx = gateFixture(pool, companies, tokens);

beforeAll(async () => { [fx.owner] = await members(pool, tokens, 1); });
afterAll(() => cleanupAudit(pool, companies, [fx.owner]));

describe('Bulk Close faults', () => {
  it('an untyped error on the second period is a 500, and the first period is NOT left closed', async () => {
    const b = await fx.books();
    fault.periodId = b.periods[1]!;
    try {
      const res = await fx.action(b.c, { action: 'bulk_close', ids: [b.periods[0], b.periods[1]], confirm: true });
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(500);
      expect(JSON.stringify(res.state.body)).not.toContain('"ok":true');
    } finally { fault.periodId = ''; }
    expect((await fx.statuses(b.c)).slice(0, 2)).toEqual(['open', 'open']);
  });

  it.each(['bulk_close', 'bulk_lock', 'bulk_reopen'] as const)('%s with a repeated id: one row, one write', async (action) => {
    const b = await fx.books();
    if (action === 'bulk_lock') await pool.query("UPDATE fiscal_periods SET status = 'closed' WHERE id = $1", [b.periods[0]]);
    if (action === 'bulk_reopen') await pool.query("UPDATE fiscal_periods SET status = 'closed' WHERE id = $1", [b.periods[0]]);
    const res = await fx.action(b.c, { action, ids: [b.periods[0], b.periods[0]], confirm: true });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const data = (res.state.body as { data: { results: unknown[]; okCount: number; total: number } }).data;
    expect(data).toEqual({ results: [{ id: b.periods[0], ok: true }], okCount: 1, total: 1 });
  });
});

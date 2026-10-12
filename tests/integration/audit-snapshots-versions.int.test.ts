/**
 * Forensic-controls step 4, blind review r2 — what must survive a later change of the code:
 *  - a snapshot is verified under the document version it was sealed with, so bumping DOCUMENT_VERSION never turns
 *    an earlier snapshot invalid;
 *  - a column frozen after a snapshot was taken is not a change to every journal in a comparison;
 *  - the time budget is a bound: a slow step or check is cut off at what is left of it, not after it;
 *  - an automatic snapshot waits a bounded time for its company's snapshot lock;
 *  - the chain check reads every sealed snapshot, however many attempts were recorded since.
 * The knobs stand in for a later release of the code (a bumped version, a newly frozen column) and a slow ledger.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { members, newCompany } from './entity-changes.helpers';
import { cleanupAudit, plantJournal, plantLedger } from './audit-snapshots.helpers';

const knobs = vi.hoisted(() => ({ version: 2, frozenLater: false, budgetMs: 120_000, slowLedger: false, slowChecks: false, waitMs: 300_000 }));

vi.mock('../../src/modules/accounting/services/audit/documents', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/modules/accounting/services/audit/documents')>();
  return { ...real, get DOCUMENT_VERSION() { return knobs.version; } };
});
vi.mock('../../src/modules/accounting/services/audit/auditTx', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/modules/accounting/services/audit/auditTx')>();
  return { ...real, get SNAPSHOT_TIME_BUDGET_MS() { return knobs.budgetMs; }, get AUDIT_WAIT_MS() { return knobs.waitMs; } };
});
vi.mock('../../src/modules/accounting/services/audit/snapshotRows', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/modules/accounting/services/audit/snapshotRows')>();
  const { materialHash } = await import('../../src/modules/accounting/services/audit/canonical');
  const { sql } = await import('../../src/lib/neon');
  return {
    ...real,
    journalRows: async (companyId: string, cutoff: string) => {
      if (knobs.slowLedger) await sql`SELECT pg_sleep(10)`;
      const rows = await real.journalRows(companyId, cutoff);
      if (!knobs.frozenLater) return rows;
      return rows.map((r) => {
        const row = { ...r.row, frozen_later: 'set' };
        return { ...r, row, materialHash: materialHash(row) };
      });
    },
  };
});

vi.mock('../../src/modules/accounting/services/core/anomalyScanService', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/modules/accounting/services/core/anomalyScanService')>();
  const { sql } = await import('../../src/lib/neon');
  return {
    ...real,
    runAnomalyScan: async (...args: Parameters<typeof real.runAnomalyScan>) => {
      if (knobs.slowChecks) await sql`SELECT pg_sleep(120)`;
      return real.runAnomalyScan(...args);
    },
  };
});

import { SnapshotTimeBudgetError, takeAutoSnapshot, takeSnapshot } from '../../src/modules/accounting/services/audit/snapshotService';
import { verifyChain, verifySnapshot } from '../../src/modules/accounting/services/audit/snapshotVerify';
import { compareSnapshotToLive, compareSnapshots } from '../../src/modules/accounting/services/audit/comparisonService';
import { getCheckRun, getSnapshot } from '../../src/modules/accounting/services/audit/snapshotRead';
import { SnapshotBusyError, runAuditTx, type AuditPrincipal } from '../../src/modules/accounting/services/audit/auditTx';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let o = '';

beforeAll(async () => {
  [o] = await members(pool, tokens, 1);
  process.env.AUDIT_SNAPSHOT_SIGNING_KEY = 'v'.repeat(48);
  process.env.AUDIT_SNAPSHOT_KEY_ID = 'versions-test';
});
afterEach(() => Object.assign(knobs, { version: 2, frozenLater: false, budgetMs: 120_000, slowLedger: false, slowChecks: false, waitMs: 300_000 }));
afterAll(() => cleanupAudit(pool, companies, [o]));

const principal = (c: string): AuditPrincipal => ({ userId: o, companyId: c, claims: { sub: o, session_id: crypto.randomUUID() } });
const read = <T>(c: string, fn: () => Promise<T>) => runAuditTx(principal(c), 'READ COMMITTED', fn);

async function books() {
  const c = await newCompany(pool, [[o, 'owner']], companies);
  const l = await plantLedger(pool, c);
  await plantJournal(pool, c, { date: '2026-03-10', amount: 1000, debit: l.bank, credit: l.sales, by: o });
  await plantJournal(pool, c, { date: '2026-04-05', amount: 500, debit: l.expense, credit: l.bank, by: o });
  return { c, l };
}

describe('across releases', { timeout: 120_000 }, () => {
  it('a snapshot sealed under an earlier document version still verifies and compares after the version is bumped', async () => {
    const { c } = await books();
    const first = await takeSnapshot(principal(c), { cutoff: '2026-06-30', trigger: 'manual' });
    knobs.version = 3;
    expect((await read(c, () => verifySnapshot(c, first.id)))?.status).toBe('valid');
    const second = await takeSnapshot(principal(c), { cutoff: '2026-06-30', trigger: 'manual' });
    const [s1, s2] = await read(c, async () => [await getSnapshot(c, first.id), await getSnapshot(c, second.id)]);
    expect([s1!.totals.document_version, s2!.totals.document_version]).toEqual([2, 3]);
    const run2 = await read(c, () => getCheckRun(c, second.checkRunId));
    expect(run2!.totals.document_version).toBe(3);
    expect((await read(c, () => verifySnapshot(c, second.id)))?.status).toBe('valid');
    const cmp = await compareSnapshots(principal(c), first.id, second.id);
    expect(cmp.verification).toEqual({ base: 'valid', against: 'valid' });
    expect(cmp.counts.changed).toBe(0);
  });

  it('a column frozen after the snapshot was taken is not reported as a change to every journal', async () => {
    const { c, l } = await books();
    const s = await takeSnapshot(principal(c), { cutoff: '2026-06-30', trigger: 'manual' });
    knobs.frozenLater = true;
    await plantJournal(pool, c, { date: '2026-05-01', amount: 9, debit: l.expense, credit: l.bank, by: o });
    const cmp = await compareSnapshotToLive(principal(c), s.id);
    expect(cmp.counts).toMatchObject({ changed: 0, backdated: 1, removed: 0 });
    expect(cmp.notCompared).toEqual({ journals: ['frozen_later'], lines: [] });
  });

  it('the time budget is a bound: a slow step is cut off at what is left of the budget, and nothing is written', async () => {
    const { c } = await books();
    Object.assign(knobs, { budgetMs: 2_000, slowLedger: true });
    const started = Date.now();
    const err = await takeSnapshot(principal(c), { cutoff: '2026-06-30', trigger: 'manual' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapshotTimeBudgetError);
    expect((err as SnapshotTimeBudgetError).step).toBe('reading the ledger');
    // The 10 s statement was cancelled at the budget's end, not waited out.
    expect(Date.now() - started).toBeLessThan(6_000);
    const { rows: [n] } = await pool.query('SELECT count(*)::int AS n FROM audit_snapshots WHERE company_id = $1', [c]);
    expect(n.n).toBe(0);
  });

  it('the budget holds through the check run: a check cut off at the budget ends the snapshot at the next step', async () => {
    const { c } = await books();
    Object.assign(knobs, { budgetMs: 30_000, slowChecks: true });
    const started = Date.now();
    const err = await takeSnapshot(principal(c), { cutoff: '2026-06-30', trigger: 'manual' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapshotTimeBudgetError);
    // The anomaly family's 120 s statement was cancelled at the budget (its savepoint records it unknown); the next
    // step refuses to start.
    expect((err as SnapshotTimeBudgetError).step).toBe('the journal-risk checks');
    expect(Date.now() - started).toBeLessThan(45_000);
  });

  it("an automatic snapshot waits a bounded time for the company's snapshot lock held elsewhere, then is refused", async () => {
    const { c } = await books();
    knobs.waitMs = 1_500;
    const other = await pool.connect();
    try {
      await other.query("SELECT pg_advisory_lock(hashtext('audit_snapshot_chain:' || $1))", [c]);
      const started = Date.now();
      const err = await takeAutoSnapshot(principal(c), { cutoff: '2026-06-30', trigger: 'period_close' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SnapshotBusyError);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await other.query("SELECT pg_advisory_unlock(hashtext('audit_snapshot_chain:' || $1))", [c]);
      other.release();
    }
  });

  it('the chain check reads every sealed snapshot, however many attempts were recorded after it', async () => {
    const { c } = await books();
    const s = await takeSnapshot(principal(c), { cutoff: '2026-06-30', trigger: 'manual' });
    // More failed attempts than a screen's list holds, all newer than the sealed snapshot.
    await pool.query(
      `INSERT INTO audit_snapshots (id, company_id, cutoff, taken_at, taken_by, channel, trigger, status, failure_reason, totals, caveat)
       SELECT gen_random_uuid(), $1, DATE '2026-06-30', now() + make_interval(secs => g), $2, 'session', 'period_close', 'failed',
              'error: planted', '{}'::jsonb, 'x'
       FROM generate_series(1, 210) AS g`, [c, o]);
    const chain = await read(c, () => verifyChain(c));
    expect(chain).toMatchObject({ status: 'valid', length: 1, head: { seq: 1, snapshotId: s.id } });
  });
});

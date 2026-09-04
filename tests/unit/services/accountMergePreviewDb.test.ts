/**
 * `previewAccountMerge` against a real Postgres.
 *
 * A mocked SQL template cannot catch a column that is not there, and this
 * service reads six tables. Every assertion here executes against `isaflow_dev`
 * inside a transaction that is rolled back, so nothing commits.
 *
 * What is being pinned:
 *  - the two accounts' figures are derived independently of each other, so the
 *    preview cannot report a target balance it computed FROM the source;
 *  - the company-wide identity (other accounts + source + target === company
 *    total) actually closes, which is the only part of the trial-balance block
 *    capable of failing;
 *  - a line in a CLOSED period and a posted line in NO period are skips, with
 *    machine-stable codes and their amounts — not silently repointed;
 *  - the entries are reachable as ids, not merely counted.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';
import {
  assertMergeTestDb,
  createMergeFixture,
  type MergeFixture,
} from '../helpers/accountMergeFixture';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests } from '@/lib/neon';
import { previewAccountMerge } from '@/modules/accounting/services/gl/accountMergePreview';

type Ctx = Parameters<typeof als.run>[0];
const ctxFor = (client: PoolClient, companyId: string): Ctx =>
  ({ client, userId: '00000000-0000-0000-0000-0000000000aa', companyId, claims: {} } as unknown as Ctx);

async function withFixture(fn: (c: PoolClient, f: MergeFixture) => Promise<void>): Promise<void> {
  assertMergeTestDb();
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const fixture = await createMergeFixture(client);
    if (!fixture) return;
    await als.run(ctxFor(client, fixture.companyId), () => fn(client, fixture));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('previewAccountMerge', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('reports both accounts, each derived on its own', async () => {
    await withFixture(async (_c, f) => {
      const p = await previewAccountMerge(f.companyId, f.sourceId, f.targetId);

      // Source: 100 + 200 (open) + 50 (closed) + 25 (no period) = 375 debit.
      expect(p.source.postedDebit).toBeCloseTo(375, 2);
      expect(p.source.postedCredit).toBeCloseTo(0, 2);
      expect(p.source.postedLines).toBe(4);
      // Target's own history only — never the source's.
      expect(p.target.postedDebit).toBeCloseTo(40, 2);
      expect(p.target.postedLines).toBe(1);

      // Only the two OPEN-period lines may move, so the after figures carry
      // 300, not 375. A preview that added the whole source balance would be
      // promising a merge it then refuses to perform.
      expect(p.targetAfter.postedDebit).toBeCloseTo(340, 2);
      expect(p.sourceAfter.postedDebit).toBeCloseTo(75, 2);
    });
  }, 60_000);

  it.skipIf(!reachable)('closes the company-wide identity, and says it is not sufficient', async () => {
    await withFixture(async (_c, f) => {
      const p = await previewAccountMerge(f.companyId, f.sourceId, f.targetId);
      const tb = p.trialBalance;

      expect(tb.identity.holds).toBe(true);
      expect(tb.before.totalDebit).toBeCloseTo(
        tb.identity.otherAccountsDebit + p.source.postedDebit + p.target.postedDebit, 2,
      );
      // A repoint moves no money: the company totals must be identical.
      expect(tb.after.totalDebit).toBeCloseTo(tb.before.totalDebit, 2);
      expect(tb.after.totalCredit).toBeCloseTo(tb.before.totalCredit, 2);
      expect(tb.unchanged).toBe(true);
      expect(tb.caveat).toMatch(/necessary/i);
    });
  }, 60_000);

  it.skipIf(!reachable)('skips a closed-period line and a posted line with no period', async () => {
    await withFixture(async (_c, f) => {
      const p = await previewAccountMerge(f.companyId, f.sourceId, f.targetId);

      const codes = p.skips.map((s) => s.reason).sort();
      expect(codes).toEqual(['fiscal_period_closed', 'posted_without_fiscal_period']);
      expect(p.skipsTotal).toBe(2);

      // The amount, not just the count: "two rows" and "R75" are different facts.
      const closed = p.skips.find((s) => s.reason === 'fiscal_period_closed');
      expect(closed?.debit).toBeCloseTo(50, 2);
      const noPeriod = p.skips.find((s) => s.reason === 'posted_without_fiscal_period');
      expect(noPeriod?.debit).toBeCloseTo(25, 2);

      // A skip blocks the write. The preview has to say so rather than let a
      // reader assume the other 300 would go through on its own.
      expect(p.blocked).toBe(true);
    });
  }, 60_000);

  it.skipIf(!reachable)('makes every repointed entry reachable as an id', async () => {
    await withFixture(async (_c, f) => {
      const p = await previewAccountMerge(f.companyId, f.sourceId, f.targetId);
      expect(p.entriesTotal).toBe(2);
      expect(p.entries).toHaveLength(2);
      for (const e of p.entries) {
        expect(e.journalEntryId).toMatch(/^[0-9a-f-]{36}$/);
        expect(e.lines).toHaveLength(1);
        expect(e.lines[0]!.journalLineId).toMatch(/^[0-9a-f-]{36}$/);
      }
      expect(p.linesToRepoint).toBe(2);
    });
  }, 60_000);

  it.skipIf(!reachable)('names the children it would reparent, and their new levels', async () => {
    await withFixture(async (_c, f) => {
      const p = await previewAccountMerge(f.companyId, f.sourceId, f.targetId);
      const ids = p.childAccounts.map((c) => c.accountId).sort();
      expect(ids).toEqual([f.childId, f.grandchildId].sort());
      // source level 1 -> target level 2, so the whole subtree shifts by +1.
      const child = p.childAccounts.find((c) => c.accountId === f.childId);
      expect(child?.level).toBe(2);
      expect(child?.levelAfter).toBe(3);
      const grand = p.childAccounts.find((c) => c.accountId === f.grandchildId);
      expect(grand?.levelAfter).toBe(4);
    });
  }, 60_000);

  it.skipIf(!reachable)('reports the system-account standing of both accounts', async () => {
    await withFixture(async (_c, f) => {
      const p = await previewAccountMerge(f.companyId, f.sourceId, f.targetId);
      expect(p.source.isSystemAccount).toBe(false);
      expect(p.systemAccountImpact.sourceClaimsSubtype).toBeNull();
      expect(p.systemAccountImpact.note).toMatch(/subtype/i);
    });
  }, 60_000);

  it.skipIf(!reachable)('reports postedThrough from the lines it consumed', async () => {
    await withFixture(async (_c, f) => {
      const p = await previewAccountMerge(f.companyId, f.sourceId, f.targetId);
      expect(p.postedThrough).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  }, 60_000);
});

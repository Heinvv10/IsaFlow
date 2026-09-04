/**
 * What the database remembers about a merge, and what the write refuses to do
 * when the ledger moves underneath it.
 *
 * Before `gl_account_merges` existed the only record of a merge was a COUNT in
 * `mcp_tool_calls.result`. Merging back does not undo one — a reverse merge
 * moves the target's original lines too — so without the identity of the lines
 * that moved, a wrong merge is unrecoverable. These tests assert the record is
 * written, complete, and matches the digest the dry run printed.
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
import {
  mergeAccounts, repointMovableLines, AccountMergeError,
} from '@/modules/accounting/services/gl/accountMergeService';
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
    await als.run(ctxFor(client, fixture.companyId), () => fn(client, fixture));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

interface MergeRow {
  moved_line_ids: string[];
  moved_line_ids_digest: string;
  lines_repointed: number;
  reparented_account_ids: string[];
  level_delta: number;
  merged_by: string | null;
  actor_type: string | null;
  source_account_code: string;
}

describe('the merge record', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('names every line that moved, and matches the previewed digest', async (t) => {
    await withFixture(async (c, f) => {
      const before = await previewAccountMerge(f.companyId, f.cleanSourceId, f.targetId);
      const movedIds = await c.query<{ id: string }>(
        'SELECT id FROM gl_journal_lines WHERE gl_account_id = $1 AND company_id = $2 ORDER BY id',
        [f.cleanSourceId, f.companyId],
      );

      const result = await mergeAccounts(
        f.companyId, f.cleanSourceId, f.targetId,
        '00000000-0000-0000-0000-0000000000aa',
        { actorType: 'agent', actorTokenJti: 'jti-1' },
      );

      const rows = await c.query<MergeRow>(
        'SELECT * FROM gl_account_merges WHERE company_id = $1 AND source_account_id = $2',
        [f.companyId, f.cleanSourceId],
      );
      expect(rows.rowCount).toBe(1);
      const rec = rows.rows[0]!;
      expect(rec.lines_repointed).toBe(result.linesRepointed);
      expect([...rec.moved_line_ids].sort()).toEqual(movedIds.rows.map((r) => r.id).sort());
      // The digest the human signed in the dry run is the digest of what moved.
      expect(rec.moved_line_ids_digest).toBe(before.movedLinesDigest);
      expect(rec.moved_line_ids_digest).toBe(result.movedLinesDigest);
      expect(rec.merged_by).toBe('00000000-0000-0000-0000-0000000000aa');
      expect(rec.actor_type).toBe('agent');
      expect(rec.source_account_code).toMatch(/^ZK-/);
      t.expect(rec.moved_line_ids.length).toBeGreaterThan(0);
    });
  }, 60_000);

  it.skipIf(!reachable)('records the tree work a reversal would have to undo', async (c0) => {
    void c0;
    await withFixture(async (c, f) => {
      await c.query(
        `UPDATE gl_journal_entries SET fiscal_period_id = $1
          WHERE company_id = $2 AND id IN (
            SELECT journal_entry_id FROM gl_journal_lines WHERE gl_account_id = $3)`,
        [f.openPeriodId, f.companyId, f.sourceId],
      );
      await mergeAccounts(f.companyId, f.sourceId, f.targetId);
      const rows = await c.query<MergeRow>(
        'SELECT * FROM gl_account_merges WHERE company_id = $1 AND source_account_id = $2',
        [f.companyId, f.sourceId],
      );
      const rec = rows.rows[0]!;
      expect(rec.reparented_account_ids).toEqual([f.childId]);
      expect(rec.level_delta).toBe(1);
    });
  }, 60_000);
});

describe('the write re-checks the row state it classified', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('refuses when a line stops being movable between preview and UPDATE', async () => {
    await withFixture(async (c, f) => {
      // Simulate the TOCTOU window: the classification says two lines move, and
      // one of their periods is closed before the UPDATE runs. The predicate on
      // the UPDATE must exclude it, and the count mismatch must abort the whole
      // merge rather than move half of it.
      await c.query(
        `UPDATE gl_journal_entries SET fiscal_period_id = $1
          WHERE company_id = $2 AND id IN (
            SELECT journal_entry_id FROM gl_journal_lines WHERE gl_account_id = $3)`,
        [f.openPeriodId, f.companyId, f.sourceId],
      );
      // Two of the source's four entries now sit in the SAME open period. Close
      // it after classification by moving one entry into the closed period from
      // inside a patched preview is not reachable here, so assert the predicate
      // directly: with the period closed up front, the merge refuses.
      await c.query(
        `UPDATE gl_journal_entries SET fiscal_period_id = $1
          WHERE company_id = $2 AND id = (
            SELECT journal_entry_id FROM gl_journal_lines WHERE gl_account_id = $3 LIMIT 1)`,
        [f.closedPeriodId, f.companyId, f.sourceId],
      );
      await expect(mergeAccounts(f.companyId, f.sourceId, f.targetId))
        .rejects.toBeInstanceOf(AccountMergeError);

      // Nothing moved.
      const left = await c.query<{ n: string }>(
        'SELECT COUNT(*) n FROM gl_journal_lines WHERE gl_account_id = $1', [f.sourceId]);
      expect(Number(left.rows[0]!.n)).toBe(4);
      const recs = await c.query('SELECT 1 FROM gl_account_merges WHERE company_id = $1', [f.companyId]);
      expect(recs.rowCount).toBe(0);
    });
  }, 60_000);

  it.skipIf(!reachable)('moves ONLY the lines the write-time predicate still accepts', async (t) => {
    await withFixture(async (c, f) => {
      // The source carries four posted lines: two in an open period, one in a
      // CLOSED period, one in no period at all. Called directly — bypassing the
      // `blocked` refusal, which is what a race would do — the UPDATE itself has
      // to leave the last two behind. Drop the predicate and this moves all four.
      const moved = await repointMovableLines(f.companyId, f.sourceId, f.targetId);
      t.expect(moved).toHaveLength(2);

      const left = await c.query<{ status: string; fiscal_period_id: string | null }>(
        `SELECT e.status, e.fiscal_period_id
           FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id
          WHERE l.gl_account_id = $1 AND l.company_id = $2`,
        [f.sourceId, f.companyId],
      );
      expect(left.rowCount).toBe(2);
      const reasons = left.rows.map((r) => (r.fiscal_period_id === null ? 'no_period' : 'closed')).sort();
      expect(reasons).toEqual(['closed', 'no_period']);
    });
  }, 60_000);

  it.skipIf(!reachable)('the digest commits to the SET of lines, not their order', async () => {
    await withFixture(async (c, f) => {
      await c.query(
        `UPDATE gl_journal_entries SET fiscal_period_id = $1
          WHERE company_id = $2 AND id IN (
            SELECT journal_entry_id FROM gl_journal_lines WHERE gl_account_id = $3)`,
        [f.openPeriodId, f.companyId, f.sourceId],
      );
      const before = await previewAccountMerge(f.companyId, f.sourceId, f.targetId);
      expect(before.linesToRepoint).toBe(4);
      const result = await mergeAccounts(f.companyId, f.sourceId, f.targetId);
      // Four lines: the preview lists them by entry date, the UPDATE returns
      // them in whatever order it pleases. The digests must still agree.
      expect(result.movedLinesDigest).toBe(before.movedLinesDigest);
    });
  }, 60_000);
});

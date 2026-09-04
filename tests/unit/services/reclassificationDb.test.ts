/**
 * Reclassification against a real Postgres.
 *
 * WHY THESE EXIST. `yearEndService.closeFiscalYear` INSERTed two columns that
 * exist in no environment and every one of its tests passed, because they mock
 * the `sql` tagged template — a statement Postgres rejects outright has exactly
 * the same shape as one it accepts. So every table this feature writes gets at
 * least one test that actually executes: `reclassification_batches`,
 * `reclassification_batch_lines`, `gl_journal_entries` and `gl_journal_lines`.
 *
 * What they prove beyond the schema:
 *
 *   - the posted lines are UNTOUCHED. The original still sits on the source
 *     account, with the account it was posted to, after the batch.
 *   - the reclassification journal BALANCES and the source account nets to zero.
 *   - the batch REVERSES cleanly through the ordinary reverse_journal_entry
 *     path, and both accounts return to where they started.
 *   - a partially-failing batch leaves NOTHING behind.
 *   - the guards refuse from real rows: a closed period skips, a reversed entry
 *     skips, an already-moved line skips, and a contra leg is not offered again.
 *
 * Everything runs inside one transaction that is rolled back.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';
import { assertNotProductionDb } from '../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests } from '@/lib/neon';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import {
  planReclassification,
  isRefusal,
  type ReclassPlan,
} from '@/modules/accounting/services/gl/reclassification/plan';
import { postReclassBatch } from '@/modules/accounting/services/gl/reclassification/post';

type Ctx = Parameters<typeof als.run>[0];
const USER_ID = '00000000-0000-0000-0000-0000000000aa';

function ctxFor(client: PoolClient, companyId: string): Ctx {
  return { client, userId: USER_ID, companyId, claims: {} } as unknown as Ctx;
}

interface Fixture {
  companyId: string;
  sourceAccountId: string;
  targetAccountId: string;
  entryId: string;
  lineId: string;
}

/**
 * A COMPANY OF ITS OWN, created inside this test's transaction.
 *
 * `uq_gl_je_company_entry_number` is unique on (company_id, entry_number) and
 * `createJournalEntry` derives the number from that company's existing maximum.
 * Every DB-gated test that borrowed "the first company with an open period" was
 * therefore racing every other one for the next number, and under parallel file
 * execution that surfaces as a 23505 in whichever test lost — a documented flake
 * in this repo which these tests were making MORE likely by posting more
 * journals into the shared company. A private company takes this file out of
 * that contention entirely.
 *
 * Rolled back with everything else, so nothing is left behind.
 */
async function makeCompany(client: PoolClient): Promise<{ companyId: string; today: string }> {
  const { rows: co } = await client.query<{ id: string }>(
    "INSERT INTO companies (name) VALUES ('Reclass fixture co') RETURNING id",
  );
  const companyId = co[0]!.id;
  // One open period covering today, so every journal this file posts resolves a
  // fiscal_period_id and postJournalEntry's open-period check passes.
  await client.query(
    `INSERT INTO fiscal_periods
       (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
     VALUES ($1, 'Fixture period', 1, EXTRACT(YEAR FROM CURRENT_DATE)::int,
             date_trunc('year', CURRENT_DATE)::date,
             (date_trunc('year', CURRENT_DATE) + interval '1 year - 1 day')::date,
             'open')`,
    [companyId],
  );
  const { rows: today } = await client.query<{ d: string }>(
    "SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d",
  );
  return { companyId, today: today[0]!.d };
}

/** A private company, an open period covering today, and its own accounts. */
async function buildFixture(client: PoolClient): Promise<Fixture | null> {
  const period = { company_id: (await makeCompany(client)).companyId };

  // Accounts CREATED for this test rather than borrowed. A borrowed account
  // carries whatever the seed put on it — on `isaflow_dev` account 5200 already
  // holds more than the 500-line cap — and the batch would then be measuring
  // the fixture rather than the code.
  const suffix = Math.floor(Math.random() * 1e9).toString().padStart(9, '0');
  const accounts: { id: string }[] = [];
  for (const side of ['SRC', 'TGT']) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, is_active)
       VALUES ($1, $2, $3, 'expense', 'debit', true) RETURNING id`,
      [period.company_id, `RCL${side}${suffix}`, `Reclass fixture ${side}`],
    );
    accounts.push({ id: rows[0]!.id });
  }

  const { rows: entries } = await client.query<{ id: string }>(
    `INSERT INTO gl_journal_entries
       (company_id, entry_date, fiscal_period_id, description, source, status, created_by, posted_at)
     SELECT $1, CURRENT_DATE, fp.id, 'reclass fixture', 'manual', 'posted', $2, now()
       FROM fiscal_periods fp
      WHERE fp.company_id = $1 AND fp.start_date <= CURRENT_DATE AND fp.end_date >= CURRENT_DATE
      LIMIT 1
     RETURNING id`,
    [period.company_id, USER_ID],
  );
  const entryId = entries[0]!.id;

  const { rows: lines } = await client.query<{ id: string }>(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
     VALUES ($1, $2, $3, 1234.56, 0, 'reclass fixture line') RETURNING id`,
    [period.company_id, entryId, accounts[0]!.id],
  );
  // The balancing leg, on neither account under test.
  const { rows: contra } = await client.query<{ id: string }>(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, is_active)
     VALUES ($1, $2, 'Reclass fixture contra', 'liability', 'credit', true) RETURNING id`,
    [period.company_id, `RCLLIA${suffix}`],
  );
  if (!contra[0]) return null;
  await client.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
     VALUES ($1, $2, $3, 0, 1234.56)`,
    [period.company_id, entryId, contra[0].id],
  );

  return {
    companyId: period.company_id,
    sourceAccountId: accounts[0]!.id,
    targetAccountId: accounts[1]!.id,
    entryId,
    lineId: lines[0]!.id,
  };
}

async function accountMovement(
  client: PoolClient, companyId: string, accountId: string,
): Promise<number> {
  const { rows } = await client.query<{ net: string }>(
    `SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::TEXT AS net
       FROM gl_journal_lines jl
       JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
      WHERE jl.company_id = $1 AND jl.gl_account_id = $2 AND je.status = 'posted'`,
    [companyId, accountId],
  );
  return Number(rows[0]!.net);
}

const today = new Date().toISOString().slice(0, 10);

async function planFor(
  client: PoolClient, f: Fixture, lockCandidateLines = false,
): Promise<ReclassPlan> {
  const plan = await als.run(ctxFor(client, f.companyId), () =>
    planReclassification({
      companyId: f.companyId,
      sourceAccountId: f.sourceAccountId,
      targetAccountId: f.targetAccountId,
      // Bounded to the fixture's own day: an unbounded window over a borrowed
      // company would sweep in whatever else the seed posted.
      from: today, to: today, postingDate: null, lockCandidateLines,
    }));
  if (isRefusal(plan)) throw new Error(`unexpected refusal: ${plan.refused}`);
  return plan;
}

describe('reclassification (real DB)', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('posts a balanced batch and leaves the ORIGINAL line untouched', async (ctx) => {
    assertNotProductionDb('This test inserts journal entries and lines.');
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      const f = await buildFixture(client);
      if (!f) { ctx.skip('no company with an open period and two expense accounts'); return; }

      const sourceBefore = await accountMovement(client, f.companyId, f.sourceAccountId);
      const targetBefore = await accountMovement(client, f.companyId, f.targetAccountId);

      const plan = await planFor(client, f);
      expect(plan.movable.map((m) => m.lineId)).toContain(f.lineId);

      // THE UNIVERSE, checked against a count this test issues itself.
      //
      // `buildEnvelope`'s identity is `rowsTotal + excluded === universeTotal`,
      // so a universe derived from those two quantities can never fault — the
      // 21-instance defect class this repo has a gate for. Asserting it against
      // an independent COUNT(*) is the only check that can actually fail; a
      // source-text grep passes on a comment and cannot see a mutation spelled
      // another way.
      const { rows: universe } = await client.query<{ n: string }>(
        `SELECT COUNT(*)::TEXT AS n
           FROM gl_journal_lines jl
           JOIN gl_journal_entries je
             ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
          WHERE jl.company_id = $1 AND jl.gl_account_id = $2 AND je.status = 'posted'
            AND je.entry_date = $3::DATE`,
        [f.companyId, f.sourceAccountId, today],
      );
      expect(plan.universeTotal).toBe(Number(universe[0]!.n));
      expect(plan.movable.length + plan.skipped.length).toBe(plan.universeTotal);

      const result = await als.run(ctxFor(client, f.companyId), () =>
        postReclassBatch(f.companyId, USER_ID, {
          tool: 'post_reclassification_batch',
          sourceAccountId: f.sourceAccountId,
          targetAccountId: f.targetAccountId,
          postingDate: null,
          idempotencyKey: 'db-test-1',
          drafts: plan.drafts,
        }));

      expect(result.movedLineCount).toBe(plan.movable.length);

      // THE ORIGINAL IS UNTOUCHED. This is the assertion the whole design rests
      // on: an in-place UPDATE would make the account below wrong.
      const { rows: original } = await client.query<{ gl_account_id: string; debit: string }>(
        'SELECT gl_account_id, debit FROM gl_journal_lines WHERE id = $1', [f.lineId],
      );
      expect(original[0]!.gl_account_id).toBe(f.sourceAccountId);
      expect(Number(original[0]!.debit)).toBe(1234.56);

      // The contra exactly undoes what the batch moved off the source.
      const movedNet = plan.movable.reduce((t, m) => t + m.debit - m.credit, 0);
      expect(await accountMovement(client, f.companyId, f.sourceAccountId))
        .toBeCloseTo(sourceBefore - movedNet, 2);
      expect(await accountMovement(client, f.companyId, f.targetAccountId))
        .toBeCloseTo(targetBefore + movedNet, 2);

      // Every reclassification journal balances to the cent, and carries a period.
      const { rows: totals } = await client.query<{ d: string; c: string; fp: string | null }>(
        `SELECT SUM(jl.debit)::TEXT AS d, SUM(jl.credit)::TEXT AS c, MAX(je.fiscal_period_id::TEXT) AS fp
           FROM gl_journal_entries je
           JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
          WHERE je.id = ANY($1::UUID[]) GROUP BY je.id`,
        [result.journals.map((j) => j.journalEntryId)],
      );
      for (const t of totals) {
        expect(Number(t.d)).toBeCloseTo(Number(t.c), 2);
        expect(t.fp).not.toBeNull();
      }

      // Both new tables actually accepted their INSERTs.
      const { rows: batchLines } = await client.query<{ n: string }>(
        'SELECT COUNT(*)::TEXT AS n FROM reclassification_batch_lines WHERE company_id = $1 AND batch_id = $2',
        [f.companyId, result.batchId],
      );
      expect(Number(batchLines[0]!.n)).toBe(result.movedLineCount);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 60_000);

  it.skipIf(!reachable)('reverses cleanly and returns both accounts to where they started', async (ctx) => {
    assertNotProductionDb('This test inserts journal entries and lines.');
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      const f = await buildFixture(client);
      if (!f) { ctx.skip('no company with an open period and two expense accounts'); return; }

      const sourceBefore = await accountMovement(client, f.companyId, f.sourceAccountId);
      const targetBefore = await accountMovement(client, f.companyId, f.targetAccountId);

      const plan = await planFor(client, f);
      const result = await als.run(ctxFor(client, f.companyId), () =>
        postReclassBatch(f.companyId, USER_ID, {
          tool: 'post_reclassification_batch',
          sourceAccountId: f.sourceAccountId,
          targetAccountId: f.targetAccountId,
          postingDate: null, idempotencyKey: null, drafts: plan.drafts,
        }));

      // The documented undo route: the ordinary reversal, once per journal.
      for (const j of result.journals) {
        await als.run(ctxFor(client, f.companyId), () =>
          reverseJournalEntry(f.companyId, j.journalEntryId, USER_ID));
      }

      expect(await accountMovement(client, f.companyId, f.sourceAccountId))
        .toBeCloseTo(sourceBefore, 2);
      expect(await accountMovement(client, f.companyId, f.targetAccountId))
        .toBeCloseTo(targetBefore, 2);

      // And the line is movable AGAIN: a reversed reclassification did not stick,
      // so refusing it forever would make a corrected mistake unfixable.
      const replan = await planFor(client, f);
      expect(replan.movable.map((m) => m.lineId)).toContain(f.lineId);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 60_000);

  it.skipIf(!reachable)('skips a line an un-reversed batch already moved, and its own contra leg', async (ctx) => {
    assertNotProductionDb('This test inserts journal entries and lines.');
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      const f = await buildFixture(client);
      if (!f) { ctx.skip('no company with an open period and two expense accounts'); return; }

      const plan = await planFor(client, f);
      await als.run(ctxFor(client, f.companyId), () =>
        postReclassBatch(f.companyId, USER_ID, {
          tool: 'post_reclassification_batch',
          sourceAccountId: f.sourceAccountId,
          targetAccountId: f.targetAccountId,
          postingDate: null, idempotencyKey: null, drafts: plan.drafts,
        }));

      const second = await planFor(client, f);
      const bySource = new Map(second.skipped.map((s) => [s.lineId, s.reason]));
      expect(bySource.get(f.lineId)).toBe('already_reclassified');
      // The contra the batch just posted on the source account is offered to
      // nobody: moving it would move the correction, not the amount.
      expect(second.movable.map((m) => m.lineId)).not.toContain(f.lineId);
      expect([...bySource.values()]).toContain('reclassification_contra');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 60_000);

  it.skipIf(!reachable)('row-locks the candidate lines on the WRITE path, and not on a preview', async (ctx) => {
    // The lock helper has its own contention tests. This one tests the WIRING:
    // deleting the `lockReclassLinesForUpdate` call from plan.ts leaves every
    // one of those green, because they call the helper directly. Observed on
    // the ROW, which is the only thing that can tell "the lock was taken" from
    // "the code says it takes a lock".
    assertNotProductionDb('This test inserts journal entries and lines.');
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      const f = await buildFixture(client);
      if (!f) { ctx.skip('no company with an open period and two expense accounts'); return; }

      // Row locks are recorded against the TUPLE, and a granted FOR UPDATE
      // shows as the transaction holding an exclusive lock on its own xid plus
      // the row carrying that xmax. `pg_locks` alone cannot name which rows, so
      // ask the row itself: FOR UPDATE stamps xmax, and `pg_xact_status` says
      // whether the stamping transaction is ours and still in progress.
      const held = async (): Promise<number> => {
        const { rows } = await client.query<{ n: string }>(
          `SELECT COUNT(*)::TEXT AS n FROM gl_journal_lines
            WHERE id = $1 AND xmax::TEXT::BIGINT <> 0
              AND xmax::TEXT::BIGINT = pg_current_xact_id()::TEXT::BIGINT`,
          [f.lineId],
        );
        return Number(rows[0]!.n);
      };

      expect(await held()).toBe(0);
      await planFor(client, f, false);
      // A preview must NOT hold a lock that blocks every real batch on the
      // account for its duration.
      expect(await held()).toBe(0);

      await planFor(client, f, true);
      expect(await held()).toBe(1);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 60_000);

  it.skipIf(!reachable)('skips BOTH halves of a real reversal pair', async (ctx) => {
    // The defect this catches, verified in production: `reversed_at` marks the
    // entry that WAS reversed and `reversal_of_id` marks the entry that DID the
    // reversing. Guarding on the first alone moves the second — the charge
    // stays on the source and its cancellation lands on the target, and neither
    // nets to zero. R15,477,616.91 on 49775626 and R407,422.11 on 49775627.
    //
    // Mocked rows cannot prove this: the pairing is a relationship between two
    // gl_journal_entries rows that only reverseJournalEntry creates.
    assertNotProductionDb('This test inserts journal entries and lines.');
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      const f = await buildFixture(client);
      if (!f) { ctx.skip('no company with an open period and two expense accounts'); return; }

      // A REAL reversal, made by the service that makes them in production.
      const reversal = await als.run(ctxFor(client, f.companyId), () =>
        reverseJournalEntry(f.companyId, f.entryId, USER_ID));

      const { rows: pair } = await client.query<{ id: string; rev_at: string | null; rev_of: string | null }>(
        `SELECT id, reversed_at AS rev_at, reversal_of_id AS rev_of
           FROM gl_journal_entries WHERE id = ANY($1::UUID[])`,
        [[f.entryId, reversal.id]],
      );
      // The fixture is only meaningful if the pair really is a pair.
      expect(pair.find((r) => r.id === f.entryId)!.rev_at).not.toBeNull();
      expect(pair.find((r) => r.id === reversal.id)!.rev_of).toBe(f.entryId);

      const plan = await planFor(client, f);
      const reasons = new Map(plan.skipped.map((sk) => [sk.lineId, sk.reason]));

      // NOTHING on the source account is movable: both halves are skipped.
      expect(plan.movable).toEqual([]);
      expect(reasons.get(f.lineId)).toBe('entry_reversed');
      expect([...reasons.values()]).toContain('entry_is_reversal');
      // And they net to zero, which is why leaving them changes no figure.
      const net = plan.skipped.reduce((t, sk) => t + sk.amount, 0);
      expect(net).toBeCloseTo(0, 2);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 60_000);

  it.skipIf(!reachable)('leaves NOTHING behind when a journal in the batch fails to post', async (ctx) => {
    assertNotProductionDb('This test inserts journal entries and lines.');
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      const f = await buildFixture(client);
      if (!f) { ctx.skip('no company with an open period and two expense accounts'); return; }

      const plan = await planFor(client, f);
      // A second draft on a DEACTIVATED account. The failure has to land at
      // POST time, not at create time: `createJournalEntry` accepts an inactive
      // account and `postJournalEntry` refuses it, which is the boundary the
      // no-catch rule guards. A draft naming an account that does not exist at
      // all would throw inside createJournalEntry and never reach it — that
      // version of this test passed against a `catch { break; }` mutation.
      const { rows: dead } = await client.query<{ id: string }>(
        `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, is_active)
         VALUES ($1, $2, 'Reclass fixture DEAD', 'expense', 'debit', false) RETURNING id`,
        [f.companyId, `RCLDEAD${Math.floor(Math.random() * 1e9)}`],
      );
      const poisoned = [
        ...plan.drafts,
        {
          ...plan.drafts[0]!,
          lines: plan.drafts[0]!.lines.map((l, i) => ({
            ...l, glAccountId: i === 0 ? dead[0]!.id : l.glAccountId,
          })),
        },
      ];

      await client.query('SAVEPOINT batch_attempt');
      await expect(
        als.run(ctxFor(client, f.companyId), () =>
          postReclassBatch(f.companyId, USER_ID, {
            tool: 'post_reclassification_batch',
            sourceAccountId: f.sourceAccountId,
            targetAccountId: f.targetAccountId,
            postingDate: null, idempotencyKey: null, drafts: poisoned,
          })),
      ).rejects.toThrow();

      // ASSERTED BEFORE THE ROLLBACK, which is the whole point. Asserted after
      // it, `COUNT(*) = 0` is true by the rollback whatever the code did —
      // hoisting createReclassBatch above the journal loop would leave that
      // version green. Before the rollback it is a real claim: no batch row may
      // exist at the moment of the throw, because the batch is opened only once
      // every journal has posted.
      const { rows: mid } = await client.query<{ n: string }>(
        'SELECT COUNT(*)::TEXT AS n FROM reclassification_batches WHERE company_id = $1',
        [f.companyId],
      );
      expect(Number(mid[0]!.n)).toBe(0);
      // Nor may any batch LINE, for the same reason.
      const { rows: midLines } = await client.query<{ n: string }>(
        'SELECT COUNT(*)::TEXT AS n FROM reclassification_batch_lines WHERE company_id = $1',
        [f.companyId],
      );
      expect(Number(midLines[0]!.n)).toBe(0);

      await client.query('ROLLBACK TO SAVEPOINT batch_attempt');

      // And the savepoint — what the registry gives a write tool — unwinds the
      // journals the first drafts DID post before the throw.
      const { rows } = await client.query<{ n: string }>(
        `SELECT COUNT(*)::TEXT AS n FROM gl_journal_entries
          WHERE company_id = $1 AND description LIKE 'Reclassification:%'`,
        [f.companyId],
      );
      expect(Number(rows[0]!.n)).toBe(0);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 60_000);
});

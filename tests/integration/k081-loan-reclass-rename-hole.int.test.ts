/**
 * K-081 review round 5 — M1 and M2, against the migration files themselves.
 *
 * M1: migration 659 resolves a loan per JOURNAL. A loan whose `reference`
 * changed between two closes therefore has its earlier journals refused ("no
 * loan carries this reference") while its later ones still reconstruct, so the
 * running sum starts at the rename. The recorded prior is then LOWER than what
 * the current-portion account holds and the next close journals
 * `target − understated_prior` — a fabricated movement, posted silently. That
 * is the defect 659 exists to eliminate, in a different guise. A rename INTO a
 * key another loan carries is round 6's M1, in k081-loan-reclass-key-swap.
 *
 * M2: migration 645's backfill is the defective reconstruction 659 replaces,
 * and it is not idempotent. On a database that has run 659 but lost its
 * schema_migrations rows, re-running 645 writes those rows back stamped with
 * the 'app' default 659 leaves behind — and 659 only ever deletes its own
 * 'backfill' rows, so nothing can clear them again.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  ORIGINAL_BACKFILL, REBUILD, account, glNet, harness, recorded, refusals, seedCompany,
  seedLoan, seedReclassJournal, seedScheduleRow,
} from './k081-loan-reclass.helpers';

assertDisposable();
const h = harness();
const journal = seedReclassJournal;

beforeAll(h.setUp);
afterAll(h.tearDown);

it('refuses a loan renamed between two closes instead of recording half its history (M1)', async () => {
  await h.inRollback(async (c) => {
    const ctx = await seedCompany(c, 'M1');
    const loan = await seedLoan(c, ctx, 'PRB-1');
    // The 202602 close ran while the loan was still OLD-1; the reference was
    // renamed through updateLoan before the 202603 close.
    await journal(c, ctx, h.user, 'OLD-1', '202602', 100_000);
    await journal(c, ctx, h.user, 'PRB-1', '202603', 92_000);
    await seedScheduleRow(c, ctx, loan, '202602', 100_000);
    await seedScheduleRow(c, ctx, loan, '202603', 192_000);

    await c.query(REBUILD);

    // The general ledger holds 192 000. Recording 92 000 would make the next
    // close journal a fabricated 100 000 movement nobody was told about.
    expect(await glNet(c, ctx.company, ctx.cp)).toBeCloseTo(192_000, 2);
    expect(await recorded(c, ctx.company)).toEqual([]);
    expect(await refusals(c, ctx.company)).toEqual([
      { loan_key: 'PRB-1', yyyymm: '202603',
        reason: 'an unattributable reclass journal moved this loan\'s current-portion account, '
          + 'so its reconstructed prior would start mid-history' },
      { loan_key: 'OLD-1', yyyymm: '202602', reason: 'no loan carries this reference' },
    ]);
  });
});

it('refuses only the loans on the account the orphan journal moved', async () => {
  await h.inRollback(async (c) => {
    const ctx = await seedCompany(c, 'SPLIT');
    const other = await account(c, ctx.company, '2411', 'payable');
    await seedLoan(c, ctx, 'PRB-2');                                        // renamed
    const clean = await seedLoan(c, ctx, 'LN-CLEAN', { cpAccount: other }); // own account
    await journal(c, ctx, h.user, 'OLD-2', '202602', 100_000);
    await journal(c, ctx, h.user, 'PRB-2', '202603', 92_000);
    await journal(c, ctx, h.user, 'LN-CLEAN', '202603', 70_000, { cpAccount: other });
    await seedScheduleRow(c, ctx, clean, '202603', 70_000);

    await c.query(REBUILD);

    // The orphan never touched `other`, so LN-CLEAN's history has no hole in
    // it and refusing it would be a needless overstatement at its next close.
    expect(await recorded(c, ctx.company))
      .toEqual([{ loan_id: clean, yyyymm: '202603', st: 70_000 }]);
  });
});

it('refuses a loan whose account a description it cannot parse moved', async () => {
  await h.inRollback(async (c) => {
    const ctx = await seedCompany(c, 'UNPARSED');
    const loan = await seedLoan(c, ctx, 'LN-U');
    await journal(c, ctx, h.user, 'LN-U', '202603', 92_000);
    await seedScheduleRow(c, ctx, loan, '202603', 192_000);
    // A hyphen where closeLoanPeriod writes an en dash — the same movement,
    // narrated by a hand-written or imported entry the parse rejects. The hole
    // it leaves in the loan's history is identical to a rename's.
    const id = randomUUID();
    await c.query(
      `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,status,
         source,created_by) VALUES($1,$2,$3,'2026-02-28',$4,'posted','manual',$5)`,
      [id, ctx.company, `JE-${id.slice(0, 8)}`,
        'Reclassification - loan LN-U for 202602', h.user]);
    for (const [acct, debit, credit] of [[ctx.lt, 100_000, 0], [ctx.cp, 0, 100_000]] as const) {
      await c.query(
        `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
         VALUES($1,$2,$3,$4,$5,$6)`, [randomUUID(), ctx.company, id, acct, debit, credit]);
    }

    await c.query(REBUILD);

    expect(await glNet(c, ctx.company, ctx.cp)).toBeCloseTo(192_000, 2);
    expect(await recorded(c, ctx.company)).toEqual([]);
  });
});

it('refuses only the loans an ambiguous reference could name', async () => {
  await h.inRollback(async (c) => {
    const ctx = await seedCompany(c, 'AMBIG');
    await seedLoan(c, ctx, 'DUP');
    await seedLoan(c, ctx, 'DUP');
    const solo = await seedLoan(c, ctx, 'SOLO');
    await journal(c, ctx, h.user, 'DUP', '202602', 100_000);
    await journal(c, ctx, h.user, 'SOLO', '202603', 70_000);
    await seedScheduleRow(c, ctx, solo, '202603', 70_000);

    await c.query(REBUILD);

    // Every loan here shares one current-portion account, but the ambiguous
    // key names only the two DUPs — SOLO's own history is complete.
    expect(await recorded(c, ctx.company))
      .toEqual([{ loan_id: solo, yyyymm: '202603', st: 70_000 }]);
  });
});

it('refuses a renamed loan under the tenant that owns it and no other', async () => {
  await h.inRollback(async (c) => {
    const one = await seedCompany(c, 'T1');
    const two = await seedCompany(c, 'T2');
    await seedLoan(c, one, 'PRB-3');
    const untouched = await seedLoan(c, two, 'PRB-3');
    await journal(c, one, h.user, 'OLD-3', '202602', 100_000);
    await journal(c, one, h.user, 'PRB-3', '202603', 92_000);
    await journal(c, two, h.user, 'PRB-3', '202603', 55_000);
    await seedScheduleRow(c, two, untouched, '202603', 55_000);

    await c.query(REBUILD);

    expect(await recorded(c, one.company)).toEqual([]);
    expect(await recorded(c, two.company))
      .toEqual([{ loan_id: untouched, yyyymm: '202603', st: 55_000 }]);
    expect(await refusals(c, two.company)).toEqual([]);
  });
});

it('does not resurrect 645\'s reconstruction on a database that already ran 659 (M2)', async () => {
  await h.inRollback(async (c) => {
    const ctx = await seedCompany(c, 'M2');
    // The exact shape 645 gets wrong: two loans sharing a reference, one
    // journal. 645 wrote 100 000 for BOTH of them.
    await seedLoan(c, ctx, 'LN-DUP');
    await seedLoan(c, ctx, 'LN-DUP');
    await journal(c, ctx, h.user, 'LN-DUP', '202602', 100_000);

    await c.query(REBUILD);
    expect(await recorded(c, ctx.company)).toEqual([]);

    // A runner whose schema_migrations rows were lost re-applies 645.
    await c.query(ORIGINAL_BACKFILL);

    // Nothing came back — and in particular nothing stamped 'app', which 659
    // would never be able to delete again.
    expect(await recorded(c, ctx.company)).toEqual([]);
  });
});

it('still backfills on a database that has never run 659', async () => {
  await h.inRollback(async (c) => {
    const ctx = await seedCompany(c, 'FRESH');
    const loan = await seedLoan(c, ctx, 'LN-FRESH');
    await journal(c, ctx, h.user, 'LN-FRESH', '202602', 100_000);

    // Rewind the fixture to the state 645 ships into on a fresh database.
    // Rolled back with the rest of the transaction.
    await c.query('ALTER TABLE loan_reclass_postings DROP COLUMN source');
    await c.query(ORIGINAL_BACKFILL);

    const { rows } = await c.query(
      `SELECT yyyymm, st_liability::float8 AS st FROM loan_reclass_postings
        WHERE company_id=$1 AND loan_id=$2`, [ctx.company, loan]);
    expect(rows).toEqual([{ yyyymm: '202602', st: 100_000 }]);
  });
});

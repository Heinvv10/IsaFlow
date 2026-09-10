/**
 * GL_ENTRY_SOURCES must mirror the gl_journal_entries_source_check constraint.
 *
 * These two lists silently drifted apart and four write paths ended up emitting
 * a `source` the database rejected with 23514:
 *
 *   'asset_disposal'       — postAssetDisposalToGL, error swallowed -> returned
 *                            null, so dispose.ts answered 200 with a null
 *                            journalEntryId and the asset left the register
 *                            with no GL effect at all (confirmed in prod).
 *   'asset_expense'        — postCapitalizationExpenseToGL, same swallow.
 *   'import'               — glImportExecuteService, threw.
 *   'auto_expense_receipt' — receipt-to-journal + capture post-expense, threw.
 *
 * A type union cannot be checked against SQL at compile time, so the lock is
 * here: parse the CHECK constraint out of the migration that owns it and
 * compare it to the exported const. Adding a source to either side alone fails.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { GL_ENTRY_SOURCES } from '@/modules/accounting/types/gl.types';

const MIGRATIONS_DIR = join(process.cwd(), 'scripts/migrations/sql');

/**
 * The constraint is redefined in full by whichever migration last touches it,
 * so resolve it by numeric prefix rather than hard-coding 509 — otherwise this
 * test pins a stale definition the moment a later migration widens the list.
 */
function latestSourceConstraintSql(): string {
  const owning = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .filter(f => readFileSync(join(MIGRATIONS_DIR, f), 'utf8').includes('gl_journal_entries_source_check'))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  expect(owning.length, 'no migration defines gl_journal_entries_source_check').toBeGreaterThan(0);
  return readFileSync(join(MIGRATIONS_DIR, owning[owning.length - 1]!), 'utf8');
}

/** Pull the quoted values out of the ADD CONSTRAINT ... ARRAY[...] block. */
function sourcesInConstraint(sql: string): string[] {
  const addClause = sql.slice(sql.lastIndexOf('ADD CONSTRAINT gl_journal_entries_source_check'));
  const array = addClause.slice(addClause.indexOf('ARRAY['), addClause.indexOf(']::text[]'));
  return [...array.matchAll(/'([a-z_]+)'/g)].map(m => m[1]!);
}

describe('GLEntrySource ↔ gl_journal_entries_source_check', () => {
  it('every source the TypeScript union allows is accepted by the DB constraint', () => {
    const allowed = new Set(sourcesInConstraint(latestSourceConstraintSql()));
    const rejected = GL_ENTRY_SOURCES.filter(s => !allowed.has(s));

    // A member here that the constraint omits is not a type nit: it is an
    // INSERT that will fail with 23514 at runtime.
    expect(rejected, `GLEntrySource members the CHECK constraint rejects: ${rejected.join(', ')}`).toEqual([]);
  });

  it('every source the DB constraint accepts is present in the TypeScript union', () => {
    const declared = new Set<string>(GL_ENTRY_SOURCES);
    const missing = sourcesInConstraint(latestSourceConstraintSql()).filter(s => !declared.has(s));

    expect(missing, `constraint values missing from GLEntrySource: ${missing.join(', ')}`).toEqual([]);
  });

  it('carries the four sources whose absence broke asset, import and receipt posting', () => {
    // Regression pins — these are the values that were being emitted against a
    // constraint that rejected them.
    expect(GL_ENTRY_SOURCES).toContain('auto_asset_disposal');
    expect(GL_ENTRY_SOURCES).toContain('auto_asset_expense');
    expect(GL_ENTRY_SOURCES).toContain('auto_gl_import');
    expect(GL_ENTRY_SOURCES).toContain('auto_expense_receipt');
  });

  /**
   * SCOPE WARNING — this test does NOT prove "no unvalidated INSERT-at-posted
   * path exists". It proves only that these three specific sources stay
   * rejected. The constraint can never gate a path that uses an ALREADY-VALID
   * source, so a green run here says nothing about those.
   *
   * sageImportService.importLedgerTransactions was one such path
   * (status='posted', source='manual', no validateJournalEntry) and HAS since
   * been converted to createJournalEntry/postJournalEntry — see
   * tests/unit/services/sageLedgerImport.test.ts. postAssetDepreciationToGLThrows
   * still INSERTs at posted with 'auto_depreciation'; it is balanced by
   * construction and savepoint-atomic, and its deterministic entry_number is
   * load-bearing for idempotency, so it was deliberately left alone.
   *
   * These two are emitted by live code and rejected by the constraint, so
   * those features are dead — and they must STAY dead until their code is
   * converted.
   *
   *   'opening_balance' — pages/api/accounting/opening-balances.ts
   *   'bank_transfer'   — pages/api/accounting/bank-transfers.ts
   *
   * Each still INSERTs its header straight to status='posted' without
   * validateJournalEntry, and trg_gl_je_balanced is BEFORE UPDATE only, so
   * nothing would check the result. Admitting the source would un-gate an
   * unvalidated posting path — exactly what happened when migration 509 added
   * 'auto_expense_receipt' and receipt-to-journal.ts had to be converted in the
   * same change to stay safe.
   *
   * The constraint is currently the only thing protecting the ledger from
   * these two. Without this test the next person debugging their 23514 fixes
   * it by widening the list, which is the trap. Convert the code first, then
   * delete the relevant line here.
   *
   * 'year_end' WAS on this list and came off in migration 627. It is still an
   * INSERT-at-posted path and cannot become postJournalEntry — the year-end
   * close requires every period CLOSED and postJournalEntry refuses a period
   * that is not OPEN — so what came off the list is the guard, not the
   * requirement: yearEndJournalPoster.postClosingJournal now runs
   * validateJournalEntry over the closing lines itself, before the transaction
   * opens. The test below pins that, so removing the check puts the union and
   * the constraint back in an unsafe state loudly rather than silently.
   *
   * The guard set is NOT identical, and the difference is deliberate. The
   * canonical path is createJournalEntry + postJournalEntry, and the second
   * half also refuses lines on a DEACTIVATED account
   * (journalEntryPostingService.assertNoInactiveAccountLines). The close does
   * not, because closing a withdrawn account is precisely how its balance gets
   * zeroed: refusing would strand the tenant, whose account cannot be cleared
   * without the close and cannot be closed without being reactivated first,
   * every year, forever. The equity side needs no exemption — systemAccountResolver
   * only caches accounts with is_active = true, so an inactive retained-earnings
   * account is refused as no_retained_earnings well before the poster runs.
   */
  it('keeps the two unconverted direct-INSERT sources OUT of the union and the constraint', () => {
    const allowed = new Set(sourcesInConstraint(latestSourceConstraintSql()));

    for (const dead of ['opening_balance', 'bank_transfer']) {
      expect(
        GL_ENTRY_SOURCES as readonly string[],
        `${dead}: convert its writer to createJournalEntry before adding it`,
      ).not.toContain(dead);
      expect(
        allowed.has(dead),
        `${dead}: admitting this source un-gates an unvalidated INSERT-at-posted path`,
      ).toBe(false);
    }
  });

  it('admits year_end only while its writer validates the journal itself', () => {
    const allowed = new Set(sourcesInConstraint(latestSourceConstraintSql()));
    expect(allowed.has('year_end'), 'migration 627 admits year_end').toBe(true);
    expect(GL_ENTRY_SOURCES as readonly string[]).toContain('year_end');

    // The source is only safe to admit because postClosingJournal replaces the
    // guard the constraint was providing. If this call goes away, the
    // INSERT-at-posted path is unvalidated again and year_end must go back on
    // the dead list above. This is a grep and a grep alone: it would pass on a
    // commented-out or conditional call, so the BEHAVIOURAL cover is
    // tests/unit/services/yearEndClosePostingGuard.test.ts, which drives an
    // unbalanced preview through the close and expects the refusal.
    const poster = readFileSync(
      join(process.cwd(), 'src/modules/accounting/services/gl/yearEndJournalPoster.ts'), 'utf8');
    const postClosing = poster.slice(poster.indexOf('export async function postClosingJournal'));
    expect(
      postClosing,
      'postClosingJournal must validate the closing journal before writing it',
    ).toContain('validateJournalEntry(');
  });

  it('no longer carries the pre-509 spellings the constraint never accepted', () => {
    expect(GL_ENTRY_SOURCES as readonly string[]).not.toContain('asset_disposal');
    expect(GL_ENTRY_SOURCES as readonly string[]).not.toContain('asset_expense');
    expect(GL_ENTRY_SOURCES as readonly string[]).not.toContain('import');
  });
});

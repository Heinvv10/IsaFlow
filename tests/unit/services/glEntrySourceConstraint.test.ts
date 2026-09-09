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

  // These legacy source labels remain unsupported. Bank transfers now use
  // auto_bank_transfer. year_end is admitted by637 for controlledYearEnd's
  // draft/shared-post path, proven by glYearEndWriters.int.test.ts. A source
  // catalogue alone is not evidence that every writer enforces controls.
  it('keeps unsupported opening balance and old bank transfer labels out', () => {
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

  it('no longer carries the pre-509 spellings the constraint never accepted', () => {
    expect(GL_ENTRY_SOURCES as readonly string[]).not.toContain('asset_disposal');
    expect(GL_ENTRY_SOURCES as readonly string[]).not.toContain('asset_expense');
    expect(GL_ENTRY_SOURCES as readonly string[]).not.toContain('import');
  });
});

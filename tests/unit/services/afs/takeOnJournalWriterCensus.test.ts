/**
 * Who writes journals with source 'auto_migration' — the census behind the
 * changes-in-equity report's "Balances taken on" row (changesInEquityService).
 *
 * The report reads an equity posting from such a journal as a balance brought
 * in by a take-on. That is only true while every writer IS a take-on, so the
 * writers are pinned here, read from the repo (git ls-files) rather than from
 * memory: a new writer fails this until it is judged and listed.
 *
 * scripts/import-sage-britech.ts wrote Sage's LIVE journal history as
 * 'auto_migration' (dev's Brightsphere holds 54 such journals, 2023-02-28 to
 * 2025-08-31). It now writes 'auto_gl_import'; the rows it already wrote carry
 * its entry numbers 'SAGE-<id>', which the report excludes (LEGACY_LIVE_HISTORY).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../../..');

/** Every take-on writer, and what it writes. */
const TAKE_ON_WRITERS: Record<string, string> = {
  'src/modules/accounting/services/core/migrationWizardOpeningBalanceService.ts': 'wizard opening balances',
  'src/modules/accounting/services/core/migrationImportService.ts': 'take-on AR invoice documents',
  'src/modules/accounting/services/ap/migrationApService.ts': 'take-on AP invoice documents',
  'src/modules/accounting/services/core/migrationOpeningBalanceService.ts': 'file migration opening balances',
  'src/lib/mcp/tools/writeOpeningBalance.ts': 'MCP set_opening_balance',
};

/** A journal write naming the source: createJournalEntry's input, or a raw INSERT carrying the literal. */
const WRITES = [
  /\bsource\s*:\s*'auto_migration'/,
  /INSERT\s+INTO\s+gl_journal_entries[^`]*'auto_migration'/i,
];

function trackedSources(): string[] {
  return execFileSync('git', ['ls-files', '--', 'src', 'pages', 'scripts', 'lib'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => /\.(ts|tsx|js|mjs)$/.test(f));
}

describe('auto_migration journal writers', () => {
  it('are exactly the take-on writers listed here', () => {
    const writers = trackedSources().filter((f) => {
      const text = readFileSync(resolve(ROOT, f), 'utf8');
      return WRITES.some((re) => re.test(text));
    });
    expect(writers.sort()).toEqual(Object.keys(TAKE_ON_WRITERS).sort());
  });

  it('the Britech live-history import writes as a GL import, not a take-on', () => {
    const text = readFileSync(resolve(ROOT, 'scripts/import-sage-britech.ts'), 'utf8');
    expect(text).toMatch(/'auto_gl_import'/);
    expect(text).not.toMatch(/'auto_migration'/);
    // The rows it wrote before carry these entry numbers; the report excludes them.
    expect(text).toMatch(/\$\{'SAGE-' \+ je\.ID\}/);
  });
});

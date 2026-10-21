/**
 * Who names the journal source 'auto_migration' — the census behind
 * gl/takeOnJournalSource: the report SOCE's "Balances taken on" row and the AFS
 * SOCE's dividends paid read a journal with that source as a TAKE-ON. That is
 * only true while every writer is a take-on, so:
 *
 *   1. every tracked file naming the token in any quoting (', " or `) is on the
 *      allowlist below with its reason — a new mention fails until judged;
 *   2. the WRITERS among them are exactly the five take-on writers;
 *   3. every file that imports or uses the shared constant
 *      (gl/takeOnJournalSource's TAKE_ON_JOURNAL_SOURCE) is allowlisted with
 *      its reason — the constant is the same marker, so a reader of it is
 *      judged like a reader of the literal — and the AFS readers take the
 *      marker from it, so they cannot drift apart.
 *
 * Read from the repo (git ls-files), not from memory. scripts/import-sage-britech.ts
 * wrote Sage's LIVE history with the token until PR #768 (it now writes
 * auto_gl_import); migration 908 relabelled the rows it wrote.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../../..');
const TOKEN = /['"`]auto_migration['"`]/;

/** The five take-on writers: every journal they write with the source is a take-on or opening balance. */
const WRITERS: Record<string, string> = {
  'src/modules/accounting/services/core/migrationWizardOpeningBalanceService.ts': 'writer: wizard opening balances (also Import from Sage); also reads its own re-run',
  'src/modules/accounting/services/core/migrationImportService.ts': 'writer: take-on AR invoice documents',
  'src/modules/accounting/services/ap/migrationApService.ts': 'writer: take-on AP invoice documents',
  'src/modules/accounting/services/core/migrationOpeningBalanceService.ts': 'writer: file migration opening balances',
  'src/lib/mcp/tools/writeOpeningBalance.ts': 'writer: MCP set_opening_balance',
};

/** Every other file allowed to name the token, and why. */
const OTHERS: Record<string, string> = {
  'src/modules/accounting/services/gl/takeOnJournalSource.ts': 'the shared marker constant',
  'src/modules/accounting/types/gl.types.ts': 'GL_ENTRY_SOURCES, the source enum',
  'src/modules/accounting/services/core/migrationPostingSupport.ts': 'comment: why take-on documents post no P&L/VAT lines',
  'src/modules/accounting/services/core/migrationService.ts': 'reader: the take-on OBE residual check',
  'src/modules/accounting/services/gl/openingBalanceReadService.ts': 'reader: posted bank opening balances',
  'src/modules/accounting/services/sage/sageTakeOnContext.ts': 'reader: a prior opening-balance entry blocks a Sage take-on',
  'pages/accounting/reports/journal-entries.tsx': 'reader: the journal list source filter / label',
  'scripts/migrations/sql/255b_migration_wizard.sql': 'migration: admitted the source',
  'scripts/migrations/sql/422_je_source_expense_claim.sql': 'migration: source CHECK list',
  'scripts/migrations/sql/509_gl_je_source_asset_and_import.sql': 'migration: source CHECK list',
  'scripts/migrations/sql/627_gl_je_source_year_end.sql': 'migration: source CHECK list',
  'scripts/migrations/sql/701_vat_input_late_claim_account.sql': 'migration: source CHECK list',
  'scripts/migrations/sql/908_relabel_sage_history_journals.sql': 'migration: relabels the Sage live history away from it',
  'src/lib/mcp/.claude.md': 'docs: the MCP set_opening_balance writer',
  'src/lib/mcp/AGENTS.md': 'docs: generated mirror of src/lib/mcp/.claude.md',
  'src/modules/accounting/services/afs/.claude.md': 'docs: the SOCE take-on row',
  'src/modules/accounting/services/afs/AGENTS.md': 'docs: generated mirror of afs/.claude.md',
  'src/modules/accounting/services/sage/.claude.md': 'docs: the Sage take-on',
  'src/modules/accounting/services/sage/AGENTS.md': 'docs: generated mirror of sage/.claude.md',
  'PRD-MIGRATION-WIZARD.md': 'docs: the wizard PRD',
  'docs/audits/remediation/K-015/fix.md': 'docs: audit record',
  'docs/audits/remediation/K-015/review-response.md': 'docs: audit record',
  'docs/audits/remediation/K-015/takeon-posting.md': 'docs: audit record',
  'docs/audits/remediation/K-089/fix.md': 'docs: audit record',
  'docs/audits/remediation/K-089/review-response.md': 'docs: audit record',
  'docs/audits/remediation/K-089/takeon-posting.md': 'docs: audit record',
  'docs/audits/remediation/R-001/design.md': 'docs: audit record',
  'tests/unit/services/afs/takeOnJournalWriterCensus.test.ts': 'test: this census',
  'tests/unit/services/afs/changesInEquityTakeOn.test.ts': 'test: the SOCE take-on row',
  'tests/integration/sage-connect-soce.int.test.ts': 'test: both SOCE readers after a Sage take-on',
  'tests/integration/m908-relabel-sage-history.int.test.ts': 'test: migration 908',
  'tests/integration/afs-take-on-dividends.int.test.ts': 'test: take-on dividends across the AFS pack',
  'tests/integration/r001-r002-r020-takeon-posting.int.test.ts': 'test: take-on posting',
  'tests/unit/mcp/setOpeningBalanceTool.test.ts': 'test: MCP set_opening_balance',
  'tests/unit/services/ap/migrationApService.test.ts': 'test: AP take-on',
  'tests/unit/services/core/migrationImportService.test.ts': 'test: AR take-on',
  'tests/unit/services/migrationOpeningBalances.test.ts': 'test: file migration opening balances',
  'tests/unit/services/reports/unusualJournalsDocumentPostings.test.ts': 'test: unusual-journals report fixture',
};

/** Every file allowed to import or use TAKE_ON_JOURNAL_SOURCE, and why. */
const CONSTANT_USERS: Record<string, string> = {
  'src/modules/accounting/services/gl/takeOnJournalSource.ts': 'defines it',
  'src/modules/accounting/services/afs/changesInEquityService.ts': 'reader: the report SOCE take-on row',
  'src/modules/accounting/services/afs/noteGenerators/primaryStatements/dividendsPaid.ts': 'reader: AFS SOCE dividends paid leaves take-ons out',
  'src/modules/accounting/services/afs/noteGenerators/primaryStatements/_helpers.ts': 'reader: income statement IS484 leaves take-ons out',
  'src/modules/accounting/services/afs/noteGenerators/primaryStatements/takeOnEquity.ts': 'reader: AFS SOCE balances taken on column',
  'src/modules/accounting/services/afs/noteGenerators/primaryStatements/derivedAccumulatedProfit.ts': 'reader: income statement "Balances taken on" line in the IS485 chain',
  'tests/unit/services/afs/changesInEquityTakeOn.test.ts': 'test: the report SOCE query binds it',
  'tests/unit/services/afs/takeOnJournalWriterCensus.test.ts': 'test: this census',
};
const CONSTANT = /\bTAKE_ON_JOURNAL_SOURCE\b|from\s+['"][^'"]*takeOnJournalSource['"]/;

/** A journal WRITE naming the source: createJournalEntry's input, or a raw INSERT carrying it. */
const WRITES = [
  /\bsource\s*:\s*['"`]auto_migration['"`]/,
  /INSERT\s+INTO\s+gl_journal_entries[\s\S]{0,600}?['"`]auto_migration['"`]/i,
];

function tracked(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
}

function mentions(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of tracked()) {
    let text: string;
    try { text = readFileSync(resolve(ROOT, f), 'utf8'); } catch { continue; } // a submodule or removed path: not text we own
    if (TOKEN.test(text)) out.set(f, text);
  }
  return out;
}

describe('auto_migration census', () => {
  const found = mentions();

  it('every file naming the token is allowlisted with a reason', () => {
    const allowed = new Set([...Object.keys(WRITERS), ...Object.keys(OTHERS)]);
    expect([...found.keys()].filter((f) => !allowed.has(f)).sort()).toEqual([]);
    for (const reason of [...Object.values(WRITERS), ...Object.values(OTHERS)]) expect(reason.trim()).not.toBe('');
  });

  it('no allowlist entry is stale', () => {
    expect([...Object.keys(WRITERS), ...Object.keys(OTHERS)].filter((f) => !found.has(f)).sort()).toEqual([]);
  });

  it('the writers are exactly the five take-on writers', () => {
    const writers = [...found].filter(([f, text]) => !f.endsWith('.md') && !f.startsWith('tests/') && !f.startsWith('scripts/migrations/')
      && WRITES.some((re) => re.test(text))).map(([f]) => f);
    expect(writers.sort()).toEqual(Object.keys(WRITERS).sort());
  });

  it('the Britech live-history import writes as a GL import', () => {
    const text = readFileSync(resolve(ROOT, 'scripts/import-sage-britech.ts'), 'utf8');
    expect(text).toMatch(/'auto_gl_import'/);
    expect(TOKEN.test(text)).toBe(false);
  });

  it('every file importing or using the shared constant is allowlisted with a reason, and none is stale', () => {
    const users = tracked().filter((f) => {
      try { return CONSTANT.test(readFileSync(resolve(ROOT, f), 'utf8')); } catch { return false; } // not text we own
    });
    expect(users.sort()).toEqual(Object.keys(CONSTANT_USERS).sort());
    for (const reason of Object.values(CONSTANT_USERS)) expect(reason.trim()).not.toBe('');
  });

  it('the AFS readers take the marker from the one shared constant', () => {
    for (const reader of Object.keys(CONSTANT_USERS).filter((f) => f.startsWith('src/') && !f.endsWith('takeOnJournalSource.ts'))) {
      const text = readFileSync(resolve(ROOT, reader), 'utf8');
      expect(text).toMatch(/import \{ TAKE_ON_JOURNAL_SOURCE \} from '@\/modules\/accounting\/services\/gl\/takeOnJournalSource'/);
      expect(text).toMatch(/\$\{TAKE_ON_JOURNAL_SOURCE\}/);
      expect(TOKEN.test(text)).toBe(false);
    }
  });
});

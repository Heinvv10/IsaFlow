/**
 * D1 — every writer of gl_journal_lines meets the header-account rule (ratchet).
 *
 * THIS IS A RATCHET (a source-text census), NOT A BEHAVIOUR TEST, in the shape
 * of provisionalLinkWriterCensus.test.ts. `gl/headerAccountGuard` refuses a new
 * journal line on a balance-sheet header, but only where a writer calls it, and
 * there is no trigger behind it. So:
 *   1. Every tracked file under src/ and pages/ that writes gl_journal_lines in
 *      any shape (INSERT, UPDATE, MERGE, DELETE, COPY) must be listed below,
 *      with why it is covered.
 *   2. For each listed file, the exact write lines are pinned. A new INSERT in
 *      a listed file goes red too, and whoever updates the pin has to say how
 *      the new line meets the rule.
 * The behaviour itself is pinned by tests/integration/header-account-guard*.
 * scripts/ is out of scope: seeds, one-off imports and repairs are run by hand
 * against a database someone chose, not by the app.
 * Scope limits, inherent to a source-text census; review catches these: a table
 * name built at runtime, and a write through a view or a function.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const GL = 'src/modules/accounting/services/gl';

/** Why each file is covered, and every line (trimmed) where it writes the table. */
const CLASSIFICATION: Record<string, { why: string; lines: string[] }> = {
  [`${GL}/journalEntryCrudService.ts`]: {
    why: 'THE WRITER: createJournalEntryInTransaction calls assertNoHeaderAccountLines before its first INSERT',
    lines: ['INSERT INTO gl_journal_lines ('],
  },
  [`${GL}/assetDepreciationPosting.ts`]: {
    why: 'calls assertNoHeaderAccountLines on both accounts before the INSERTs',
    lines: [
      'INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description, company_id)',
      'INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description, company_id)',
    ],
  },
  [`${GL}/yearEndJournalPoster.ts`]: {
    why: 'calls assertNoHeaderAccountLines on tx before the INSERT loop (the retained-earnings leg)',
    lines: ['INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description, created_at, company_id)'],
  },
  [`${GL}/accountMergeService.ts`]: {
    why: 'moves lines to the merge target, which accountMergeGuards refuses when it is a header (K-051)',
    lines: ['UPDATE gl_journal_lines l'],
  },
  [`${GL}/vatLateClaimSplit.ts`]: {
    why: 'moves a VAT line to the late-claim clearing account, a role holder, which roleBarringChildren keeps childless; '
      + 'the other three write vat_type / late_claim_base only',
    lines: [
      'UPDATE gl_journal_lines SET gl_account_id = ${clearingId}::UUID, vat_type = NULL',
      'UPDATE gl_journal_lines SET vat_type = NULL',
      'UPDATE gl_journal_lines SET late_claim_base = ${t.base}',
      'UPDATE gl_journal_lines l SET late_claim_base = -o.late_claim_base',
    ],
  },
  [`${GL}/dimensions/dimensionTagApply.ts`]: {
    why: 'writes cc1_id / cc2_id / bu_id only; never the account',
    lines: ['UPDATE gl_journal_lines jl', 'UPDATE gl_journal_lines jl'],
  },
  [`${GL}/reclassification/journals.ts`]: {
    why: 'comment only: reclassification posts journals through createJournalEntry',
    lines: ['* `UPDATE gl_journal_lines SET gl_account_id = …` would produce the same'],
  },
  [`${GL}/reclassification/planGuards.ts`]: {
    why: 'comment only',
    lines: ['// (`UPDATE gl_journal_lines SET gl_account_id = target`) takes only FOR KEY'],
  },
  'src/lib/mcp/tools/writeReclassification.ts': {
    why: 'comment only',
    lines: ['* original exactly as posted. `UPDATE gl_journal_lines SET gl_account_id = …`'],
  },
};

function trackedSourceFiles(): string[] {
  return execFileSync('git', ['ls-files', '--', 'src', 'pages'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((f) => !/\.test\.tsx?$/.test(f) && !/\.md$/.test(f))
    .filter((f) => !/\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|zip|gz|svg)$/i.test(f));
}

const WRITE = /\b(?:UPDATE(?:\s+ONLY)?|INSERT\s+INTO|MERGE\s+INTO|DELETE\s+FROM|COPY)\s+(?:"?public"?\s*\.\s*)?"?gl_journal_lines\b/i;

function writeLines(src: string): string[] {
  return src.split('\n').filter((l) => WRITE.test(l)).map((l) => l.trim()).sort();
}

describe('gl_journal_lines writer census (ratchet)', () => {
  it('sees every write shape', () => {
    for (const s of [
      'INSERT INTO gl_journal_lines (a) VALUES (1)',
      'insert into public.gl_journal_lines select * from x',
      'UPDATE ONLY gl_journal_lines SET gl_account_id = ${x}',
      'UPDATE "gl_journal_lines" SET gl_account_id = ${x}',
      'MERGE INTO gl_journal_lines t USING s ON true WHEN MATCHED THEN UPDATE SET gl_account_id = s.a',
      'COPY gl_journal_lines FROM STDIN',
    ]) expect(WRITE.test(s), s).toBe(true);
    expect(WRITE.test('SELECT 1 FROM gl_journal_lines')).toBe(false);
    expect(WRITE.test('INSERT INTO gl_journal_lines_archive (a) VALUES (1)')).toBe(false);
  });

  it('lists every file that writes gl_journal_lines', () => {
    const actual = trackedSourceFiles().filter((f) => WRITE.test(readFileSync(resolve(ROOT, f), 'utf8')));
    expect(actual.sort()).toEqual(Object.keys(CLASSIFICATION).sort());
  });

  it('pins every write line in a listed file', () => {
    for (const [file, { lines }] of Object.entries(CLASSIFICATION)) {
      expect(writeLines(readFileSync(resolve(ROOT, file), 'utf8')), file).toEqual([...lines].sort());
    }
  });

  it('the INSERT writers call the guard', () => {
    for (const f of [`${GL}/journalEntryCrudService.ts`, `${GL}/assetDepreciationPosting.ts`, `${GL}/yearEndJournalPoster.ts`]) {
      expect(readFileSync(resolve(ROOT, f), 'utf8'), f).toMatch(/await assertNoHeaderAccountLines\(companyId,/);
    }
  });
});

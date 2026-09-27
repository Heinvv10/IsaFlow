/**
 * R-107 — who may LINK a bank line to a provisional journal (ratchet).
 *
 * THIS IS A RATCHET (a source-text census), NOT A BEHAVIOUR TEST, in the same
 * shape as bankFeedStateReaderCensus.test.ts. `provisionalEvidenceAttach`
 * peeks the bank lines of a provisional journal unlocked and then locks them
 * one by one. That is safe only while nothing links a line to an EXISTING
 * provisional journal: `postProvisional` links a line to the journal it has
 * just created in the same transaction, which no other request can see yet.
 * Unlinking (`provisional_je_id = NULL`) is fine — the attach's UPDATE
 * re-checks the link.
 *
 * Fail-closed, in two steps, because a pattern for "a link" can always be
 * evaded by one more SQL shape (tuple SET, INSERT column list, MERGE, ON
 * CONFLICT, UPDATE ONLY, quoting, the posted view):
 *   1. Every tracked text file under src/, pages/ and scripts/ that mentions
 *      provisional_je_id AND writes bank_transactions in any of those shapes
 *      must be listed below.
 *   2. For each listed file, the exact lines that mention provisional_je_id
 *      are pinned. ANY edit to how a listed file uses the column goes red, and
 *      whoever updates the pin has to re-read the attach's lock order.
 *   A trigger that assigns `NEW.provisional_je_id` counts as touching too.
 * Scope limits, inherent to a source-text census; review catches these: a
 * column name built at runtime (`SET ${col}`, a camelCase field map into a
 * generic updater), and a whole-row copy (`INSERT ... SELECT *` / `(row).*`)
 * that carries the link without naming it — the realistic way in would be a
 * future "split bank line" feature.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');

/** Why each file touches the column, and every line (trimmed) where it does. */
const CLASSIFICATION: Record<string, { why: string; lines: string[] }> = {
  'src/modules/accounting/services/capture/provisionalPostingService.ts': {
    why: 'THE LINK: postProvisional links a line to the journal it created in the same transaction',
    lines: ['provisional_je_id = ${je.id}::UUID,'],
  },
  'src/modules/accounting/services/bank/autoPostUndoService.ts': {
    why: 'unlink only (= NULL); the other two lines read the column',
    lines: [
      'if (tx.matched_journal_line_id && tx.provisional_je_id) {',
      "SET status = 'imported', provisional_je_id = NULL, updated_at = NOW()",
      'SELECT id, status, matched_journal_line_id, provisional_je_id, reconciliation_id',
    ],
  },
  'src/modules/accounting/services/ap/provisionalSettlementVoid.ts': {
    why: 'unlink only (= NULL): undoing a bank-first settlement (R-127) frees its bank line; the other line reads the link',
    lines: [
      "UPDATE bank_transactions SET status = 'imported', provisional_je_id = NULL, updated_at = NOW()",
      'WHERE provisional_je_id = ${payment.settlesProvisionalJeId}::UUID AND company_id = ${companyId}::UUID',
    ],
  },
  'src/modules/accounting/services/bank/provisionalDismissService.ts': {
    why: 'unlink only (= NULL), keyed on the link',
    lines: [
      "SET status = 'imported', provisional_je_id = NULL, updated_at = NOW()",
      'WHERE provisional_je_id = ${jeId}::UUID AND company_id = ${companyId}::UUID',
    ],
  },
  'src/modules/accounting/services/bank/feed/bankIngestionPersistence.ts': {
    why: 'reads only: IS NULL / IS NOT NULL predicates',
    lines: ['OR provisional_je_id IS NOT NULL) AS processed', 'AND provisional_je_id IS NULL'],
  },
  'src/modules/accounting/services/capture/evidenceAttachmentService.ts': {
    why: 'reads only: joins on the link; writes status',
    lines: [
      'JOIN bank_transactions bt ON bt.provisional_je_id = je.id',
      'JOIN bank_transactions bt ON bt.provisional_je_id = je.id',
    ],
  },
  'scripts/migrations/sql/675_bank_feed_canonical_ingestion.sql': {
    why: 'reads only: the feed-state CHECK and the guard trigger compare NEW/OLD, never assign',
    lines: [
      'AND provisional_je_id IS NULL AND allocation_type IS NULL)) NOT VALID;',
      'NEW.provisional_je_id, NEW.auto_post_run_id, NEW.allocation_batch_id, NEW.allocation_rule_id',
      'OLD.provisional_je_id, OLD.auto_post_run_id, OLD.allocation_batch_id, OLD.allocation_rule_id',
      'OR OLD.reconciliation_id IS NOT NULL OR OLD.provisional_je_id IS NOT NULL)',
    ],
  },
  'src/modules/accounting/services/capture/provisionalEvidenceAttach.ts': {
    why: 'reads only: peeks and filters on the link; writes status',
    lines: [
      '// provisional_je_id, so a line unlinked while this waited for its lock is skipped. (A line',
      'WHERE provisional_je_id = ${jeId}::UUID AND company_id = ${companyId}::UUID',
      'WHERE provisional_je_id = ${jeId}::UUID AND company_id = ${companyId}::UUID',
    ],
  },
};

function trackedTextFiles(): string[] {
  return execFileSync('git', ['ls-files', '--', 'src', 'pages', 'scripts'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((f) => !/\.test\.tsx?$/.test(f))
    .filter((f) => !/\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|zip|gz)$/i.test(f));
}

const WRITES_BANK_TRANSACTIONS =
  /\b(?:UPDATE(?:\s+ONLY)?|INSERT\s+INTO|MERGE\s+INTO)\s+(?:"?public"?\s*\.\s*)?"?bank_transactions(?:_posted)?"?/i;

function touchesLink(src: string): boolean {
  return /\bNEW\s*\.\s*"?provisional_je_id/i.test(src)
    || (/provisional_je_id/i.test(src) && WRITES_BANK_TRANSACTIONS.test(src));
}

function mentionLines(src: string): string[] {
  return src.split('\n').filter((l) => /provisional_je_id/i.test(l)).map((l) => l.trim()).sort();
}

describe('provisional_je_id link-writer census (ratchet)', () => {
  it('sees every write shape', () => {
    for (const sql of [
      "UPDATE bank_transactions SET (status, provisional_je_id) = ('p', ${x}) WHERE id = ${y}",
      'UPDATE ONLY bank_transactions SET provisional_je_id = ${x}',
      'UPDATE public.bank_transactions SET provisional_je_id = ${x}',
      'UPDATE "bank_transactions" SET "provisional_je_id" = ${x}',
      'INSERT INTO bank_transactions (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET provisional_je_id = ${x}',
      'MERGE INTO bank_transactions t USING s ON true WHEN MATCHED THEN UPDATE SET provisional_je_id = s.j',
      'UPDATE bank_transactions_posted SET provisional_je_id = ${x}',
      'INSERT INTO bank_transactions SELECT * FROM staging -- provisional_je_id carried',
      'CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN NEW.provisional_je_id := (SELECT 1); RETURN NEW; END $$',
    ]) expect(touchesLink(sql), sql).toBe(true);
    expect(touchesLink('SELECT 1 FROM bank_transactions WHERE provisional_je_id = ${x}')).toBe(false);
  });

  it('lists every file that mentions the link and writes bank_transactions', () => {
    const actual = trackedTextFiles().filter((f) => touchesLink(readFileSync(resolve(ROOT, f), 'utf8')));
    expect(actual.sort()).toEqual(Object.keys(CLASSIFICATION).sort());
  });

  it('pins every line where a listed file uses the column', () => {
    for (const [file, { lines }] of Object.entries(CLASSIFICATION)) {
      expect(mentionLines(readFileSync(resolve(ROOT, file), 'utf8')), file).toEqual([...lines].sort());
    }
  });
});

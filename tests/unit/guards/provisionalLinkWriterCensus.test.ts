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
 * Two rules. COARSE: every tracked file under src/, pages/ and scripts/ (the
 * fix scripts and SQL migrations included) that mentions provisional_je_id AND
 * writes bank_transactions in any shape (UPDATE / INSERT INTO / MERGE INTO,
 * schema-qualified or quoted, or the bank_transactions_posted view) must be
 * classified below — so a tuple SET, a quoted column, an ON CONFLICT DO UPDATE
 * or a MERGE cannot slip past a narrow pattern. FINE: of those, only a file
 * classified 'link' may set provisional_je_id to a value in a plain SET list.
 * Scope limit, stated honestly: a column name built at runtime (`SET ${col}`)
 * is invisible to any source-text census; review catches that.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');

const CLASSIFICATION: Record<string, `link: ${string}` | `unlink-only: ${string}` | `reads-only: ${string}`> = {
  'src/modules/accounting/services/capture/provisionalPostingService.ts':
    'link: postProvisional links a line to the journal it created in the same transaction',
  'src/modules/accounting/services/bank/autoPostUndoService.ts': 'unlink-only: provisional_je_id = NULL on undo',
  'src/modules/accounting/services/bank/provisionalDismissService.ts': 'unlink-only: provisional_je_id = NULL on dismiss',
  'src/modules/accounting/services/bank/feed/bankIngestionPersistence.ts':
    'reads-only: IS NULL / IS NOT NULL predicates; its writes do not touch the column',
  'src/modules/accounting/services/capture/evidenceAttachmentService.ts':
    'reads-only: joins and filters on the link; writes status only',
  'src/modules/accounting/services/capture/provisionalEvidenceAttach.ts':
    'reads-only: peeks and filters on the link; writes status only',
};

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '--', 'src', 'pages', 'scripts'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(tsx?|mjs|js|sql)$/.test(f))
    .filter((f) => !/\.test\.tsx?$/.test(f));
}

const WRITES_BANK_TRANSACTIONS =
  /\b(?:UPDATE|INSERT\s+INTO|MERGE\s+INTO)\s+(?:"?public"?\s*\.\s*)?"?bank_transactions(?:_posted)?"?/i;

/** Coarse: mentions the column and writes the table (or its view), in any shape. */
function touchesLink(src: string): boolean {
  return /provisional_je_id/i.test(src) && WRITES_BANK_TRANSACTIONS.test(src);
}

/** Fine: a plain SET list that gives provisional_je_id a non-NULL value. */
function setsLinkValue(src: string): boolean {
  const setLists = src.match(/\bSET\b([\s\S]*?)(?:\bWHERE\b|\bFROM\b|\bRETURNING\b|;|`|$)/gi) ?? [];
  return setLists.some((s) => /"?provisional_je_id"?\s*=\s*(?!NULL\b)\S/i.test(s));
}

describe('provisional_je_id link-writer census (ratchet)', () => {
  it('the coarse rule sees every write shape the narrow one could miss', () => {
    for (const sql of [
      "UPDATE bank_transactions SET (status, provisional_je_id) = ('p', ${x}) WHERE id = ${y}",
      'UPDATE public.bank_transactions SET provisional_je_id = ${x}',
      'UPDATE "bank_transactions" SET "provisional_je_id" = ${x}',
      'INSERT INTO bank_transactions (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET provisional_je_id = ${x}',
      'MERGE INTO bank_transactions t USING s ON true WHEN MATCHED THEN UPDATE SET provisional_je_id = s.j',
      'UPDATE bank_transactions_posted SET provisional_je_id = ${x}',
      'INSERT INTO bank_transactions SELECT * FROM staging -- provisional_je_id carried',
    ]) expect(touchesLink(sql), sql).toBe(true);
    expect(touchesLink('SELECT 1 FROM bank_transactions WHERE provisional_je_id = ${x}')).toBe(false);
  });

  it('the fine rule tells a link from an unlink and from a predicate', () => {
    expect(setsLinkValue("UPDATE bank_transactions SET status = 'p', provisional_je_id = ${x} WHERE id = ${y}")).toBe(true);
    expect(setsLinkValue('UPDATE bank_transactions SET provisional_je_id = COALESCE(${x}, provisional_je_id)')).toBe(true);
    expect(setsLinkValue("UPDATE bank_transactions SET provisional_je_id = NULL, status = 'imported' WHERE id = ${y}")).toBe(false);
    expect(setsLinkValue("UPDATE bank_transactions SET status = 'matched' WHERE provisional_je_id = ${x}")).toBe(false);
  });

  it('classifies every file that mentions the link and writes bank_transactions', () => {
    const actual = trackedFiles().filter((f) => touchesLink(readFileSync(resolve(ROOT, f), 'utf8')));
    expect(actual.sort()).toEqual(Object.keys(CLASSIFICATION).sort());
  });

  it("only a file classified 'link' gives provisional_je_id a value", () => {
    const linking = Object.keys(CLASSIFICATION)
      .filter((f) => setsLinkValue(readFileSync(resolve(ROOT, f), 'utf8')));
    const allowed = Object.entries(CLASSIFICATION).filter(([, c]) => c.startsWith('link:')).map(([f]) => f);
    expect(linking.sort()).toEqual(allowed.sort());
  });
});

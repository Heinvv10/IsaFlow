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
 * re-checks the link. A new writer that sets `provisional_je_id` to a value
 * fails this test; read the attach's lock order before adding it here.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');

/** The one file allowed to set provisional_je_id to a non-NULL value, and why. */
const LINK_WRITERS: Record<string, string> = {
  'src/modules/accounting/services/capture/provisionalPostingService.ts':
    'postProvisional: links a line to the journal it created in the same transaction',
};

function sourceFiles(): string[] {
  return execFileSync('git', ['ls-files', '--', 'src', 'pages'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => !/\.test\.tsx?$/.test(f));
}

/** True when the SQL text sets provisional_je_id to anything but NULL, in an UPDATE's SET list or an INSERT's columns. */
function linksProvisionalJournal(src: string): boolean {
  const setLists = src.match(/UPDATE\s+bank_transactions\b[\s\S]*?\bSET\b([\s\S]*?)\bWHERE\b/gi) ?? [];
  if (setLists.some((s) => /provisional_je_id\s*=\s*(?!NULL\b)\S/i.test(s.replace(/\bWHERE\b[\s\S]*$/i, '')))) return true;
  const inserts = src.match(/INSERT\s+INTO\s+bank_transactions\s*\(([^)]*)\)/gi) ?? [];
  return inserts.some((s) => /provisional_je_id/i.test(s));
}

describe('provisional_je_id link-writer census (ratchet)', () => {
  it('recognises a link, and ignores unlinks and WHERE predicates', () => {
    expect(linksProvisionalJournal("UPDATE bank_transactions SET status = 'provisional', provisional_je_id = ${x} WHERE id = ${y}")).toBe(true);
    expect(linksProvisionalJournal('INSERT INTO bank_transactions (id, provisional_je_id) VALUES (1, 2)')).toBe(true);
    expect(linksProvisionalJournal("UPDATE bank_transactions SET provisional_je_id = NULL, status = 'imported' WHERE id = ${y}")).toBe(false);
    expect(linksProvisionalJournal("UPDATE bank_transactions SET status = 'matched' WHERE provisional_je_id = ${x}")).toBe(false);
  });

  it('only postProvisional links a bank line to a provisional journal', () => {
    const writers = sourceFiles().filter((f) => linksProvisionalJournal(readFileSync(resolve(ROOT, f), 'utf8')));
    expect(writers.sort()).toEqual(Object.keys(LINK_WRITERS).sort());
  });
});

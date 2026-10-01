/**
 * V-05 census, mechanised. Every file whose SQL reads gl_journal_lines against
 * the VAT control subtypes (a return, lock, export, recon or exception reader)
 * must leave out vatSubmissionService's clearing journal through the ONE
 * shared marker — `VAT_SUBMISSION_CLEARING_SOURCE` (reports/vatSubmissionClearing)
 * or the `vatEntrySourceAdmitsSql` fragment built on it — or be listed below,
 * reviewed, with the reason it does not sum a period's VAT. A NEW reader that
 * nobody classified fails. So does a file that inlines the literal again, and
 * an allow-list entry that has gone stale.
 *
 * A source-text ratchet, not a behaviour test: the behaviour is pinned by
 * tests/integration/vat-submission-clearing-excluded.int.test.ts and
 * tests/unit/services/reports/vatExceptionsExcludesSubmissionJournalDb.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');

const ALLOWED: Record<string, string> = {
  'src/modules/accounting/services/bank/bankAllocationService.ts': 'posting path: writes a VAT leg, sums no period',
  'src/modules/accounting/services/bank/bankRuleAutoPostLine.ts': 'posting path: writes a VAT leg, sums no period',
  'src/modules/accounting/services/bank/bankTxQueryFragments.ts': 'reads the VAT of ONE bank line\'s own allocation journal (documented V-05 census note)',
  'src/modules/accounting/services/gl/controlAccountService.ts': 'resolves which accounts are control accounts; sums nothing',
  'src/modules/accounting/services/gl/integrityChecks/accountChecks.ts': 'chart-of-accounts shape checks, not a VAT figure',
  'src/modules/accounting/services/gl/integrityChecks/vatChecks.ts': 'per bank-line displayed-vs-posted code check; the clearing journal has no bank line',
  'src/modules/accounting/services/gl/journalVatLockGuard.ts': 'post-time guard: refusing a clearing journal into a locked period is conservative, not a figure',
  'src/modules/accounting/services/gl/nonControlPostingAccounts.ts': 'account eligibility lists, sums nothing',
  'src/modules/accounting/services/gl/reclassification/planGuards.ts': 'account reclassification guards, sums nothing',
  'src/modules/accounting/services/reports/vat201NilRatedSupplies.ts': 'reads zero_rated/exempt CODED lines; every clearing-journal line is uncoded',
  'src/modules/accounting/services/reports/vatAllocationMismatchService.ts': 'bank-allocation journals only (documented V-05 census note)',
  'src/modules/accounting/services/reports/vatBalanceSheetExceptions.ts': 'deliberately includes it: a miscoded clearing line must still be caught (documented)',
  'src/modules/accounting/services/reports/vatNonSupplyExceptions.ts': 'flags CODED lines on non-supply accounts; every clearing-journal line is uncoded',
};

const MARKERS = /VAT_SUBMISSION_CLEARING_SOURCE|vatEntrySourceAdmitsSql/;
const READS_VAT_LINES = (src: string) =>
  /gl_journal_lines/.test(src) && /'vat_input'|'vat_output'|VAT_TAX_SUBTYPES|vatEntryMemberLineSql/.test(src);

function files(): string[] {
  return execFileSync('git', ['ls-files', '--', 'src', 'pages'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
}

describe('V-05: the VAT submission clearing journal is excluded through one shared marker', () => {
  const all = files().map((f) => ({ f, src: readFileSync(resolve(ROOT, f), 'utf8') }));

  it('every VAT-line reader uses the marker or is classified', () => {
    const readers = all.filter(({ src }) => READS_VAT_LINES(src));
    expect(readers.length).toBeGreaterThan(15);
    const unclassified = readers.filter(({ f, src }) => !MARKERS.test(src) && !(f in ALLOWED)).map(({ f }) => f);
    expect(unclassified).toEqual([]);
  });

  it('no allow-list entry is stale (gone, no longer a reader, or now using the marker)', () => {
    const byFile = new Map(all.map(({ f, src }) => [f, src]));
    const stale = Object.keys(ALLOWED).filter((f) => {
      const src = byFile.get(f);
      return src === undefined || !READS_VAT_LINES(src) || MARKERS.test(src);
    });
    expect(stale).toEqual([]);
  });

  it('nobody inlines the literal predicate again', () => {
    // Comments excluded: several files quote the predicate when explaining V-05.
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const inline = all.filter(({ src }) => /DISTINCT FROM 'auto_vat_submission'/.test(code(src))).map(({ f }) => f);
    expect(inline).toEqual([]);
  });
});

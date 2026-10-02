/**
 * Page 4's derived title, and the failed-checks clause it shares with page
 * 11's. Moved out of `derivedSentences.ts` unchanged to keep that file under
 * the 300-line cap; `derivedSentences.ts` re-exports both, so every existing
 * import path still resolves.
 */

import { inScale, type MoneyScale } from '@/lib/format/money';
import type { PackMatter } from '@/modules/accounting/services/packs/pages/packMatters';
import { money } from './derivedProseFigures';

/**
 * "One check could not be run and is listed as a matter." — or nothing.
 *
 * ONE SENTENCE FOR BOTH TITLES. A failed check is a `PackMatter` and is not a
 * finding: page 11's title has always counted it apart from the matters that
 * require a decision, and page 4's must count it the same way — see
 * `narrativeTitle`.
 */
export function failedChecksClause(matters: readonly PackMatter[]): string {
  const failed = matters.filter((m) => m.kind === 'checkFailed').length;
  if (failed === 0) return '';
  return ` ${failed === 1 ? 'One check' : `${failed} checks`} could not be run and ${failed === 1 ? 'is' : 'are'} listed as a matter.`;
}

/**
 * Page 4's title — ABOUT THE PAGE'S OWN PAYLOAD.
 *
 * It was `Net profit of ${…} for the period.` on both companies: a value
 * restatement, of a figure already headlined on page 3 and page 6, on a sheet
 * whose payload is the board's commentary beside a panel of decisions the
 * board is being asked to take. The tenth visual gate failed criterion 1 on
 * it in both packs ("the reader is told the net profit … and nothing about
 * the six or seven decisions the page exists to raise"), and cited it again
 * under 15.
 *
 * So it counts what is ON THIS SHEET, against what the pack raises in total,
 * and names the largest of them. Both halves are checkable off the paper: the
 * panel below lists the first number, and page 11's own title carries the
 * second. Scoped explicitly — "N of the M matters" — because page 11 says
 * "29 matters require a board decision" and a bare "3 matters" on the sheet
 * before it reads as a contradiction rather than as a selection.
 *
 * `shown` is the panel's OWN list, from `boardActionMatters`, not
 * `selection.printed`: matters that fit page 11 but not this panel are
 * carried by the panel's "N further matters follow" line and are not on this
 * sheet, so counting them here would title the page after content it does not
 * print — the two-pages-disagreeing defect one page over.
 *
 * `raised` is every matter the pack carries, printed or not. BOTH ARE COUNTED
 * AS PAGE 11 COUNTS THEM — findings only.
 *
 * This took `printed.length + omitted.length`, and "every check ran clean" is
 * a `PackMatter` too (kind `none`), as is a check that could not be run. A
 * clean pack therefore read "1 of 1 matters requiring a board decision is put
 * to the board on this page" two sheets before a page titled "0 matters
 * require a board decision this period. Every check ran clean." The panel
 * still prints those lines; the title does not call them decisions.
 */
export function narrativeTitle(
  shown: readonly PackMatter[],
  raised: readonly PackMatter[],
  scale: MoneyScale,
): string {
  const failed = failedChecksClause(raised);
  const findings = raised.filter((m) => m.kind === 'finding').length;
  if (findings === 0) {
    return `0 matters require a board decision this period; this page carries the commentary on it.${failed}`;
  }
  const shownFindings = shown.filter((m) => m.kind === 'finding');
  const scope = `${shownFindings.length} of ${findings} matters requiring a board decision `
    + `${shownFindings.length === 1 ? 'is' : 'are'} put to the board on this page`;
  const quantified = shownFindings.filter((m) => m.quantum !== null);
  if (quantified.length === 0) {
    return `${scope}; none of them carries a single rand amount.${failed}`;
  }
  const largest = quantified.reduce((a, b) => (Math.abs(b.quantum!) > Math.abs(a.quantum!) ? b : a));
  // ONE PLACEMENT FOR THE UNIT, and it is page 11's. This sentence put the
  // scale clause INSIDE the phrase — "the largest carrying 1 869, in R'000 of
  // exposure" — while page 11, the facing sheet, wrote "27 of them carrying
  // 3 544 of exposure, in R'000". The same clause, two positions, on adjacent
  // pages, in the largest type either page sets: that is what reads as a
  // slot-filled string rather than as written prose. `inScale` takes the
  // WHOLE phrase, so the unit ends the sentence in both places.
  return `${scope}, the largest carrying ${inScale(`${money(largest.quantum!, scale)} of exposure`, scale)}.${failed}`;
}

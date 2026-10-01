/**
 * Page 11's four spec §4.A sources — aged debtor concentration, unreconciled
 * bank items, unusual journals, overdue statutory filings — and the list
 * `buildMatters` walks. Moved out of `packMatters.ts` unchanged to keep that
 * file under the 300-line cap; `packMatters.ts` re-exports `SOURCES` and
 * `NO_PRIOR_MEETING_RECORD`, so existing import paths still resolve.
 */

import { getAgingReport } from '@/modules/accounting/services/reports/agingReportService';
import { formatMoney, inScale } from '@/lib/format/money';
import { PACK_SCALE } from './packBasis';
import { getBankAccountsStatus } from '@/modules/accounting/services/bank/bankAccountStatusService';
import { getUnusualJournals } from '@/modules/accounting/services/reports/unusualJournalsService';
import { getOverdueStatutoryFilings } from '@/modules/accounting/services/reports/statutoryFilingsService';
import { round2 } from '@/modules/accounting/services/reconciliation/reconciliationMath';
import { formatPackDate } from './packPeriodLabel';
import { BOARD_DECISIONS } from './packMatterDecisions';
import type { PeriodWindow } from '@/modules/accounting/services/reports/priorPeriod';
import type { PackMatter } from './packMatters';

/**
 * WHAT A §4.A SOURCE HANDS BACK: its matters, and — for the one source that
 * reads a total the pack goes on to print — that total.
 *
 * Three of the four sources return matters alone and say so by omitting the
 * field. The aged-debtors source is the exception because page 11 PRINTS its
 * base (4 146 on the live client) beside a balance sheet that states a
 * different receivables figure, and the sheet has to carry the difference.
 * The alternative was a second `getAgingReport` call from
 * `boardPackDocument.ts` — the same subledger scan twice per render — or a
 * string match against the issue prose this file writes, which is the
 * technique `PackMatterKind` exists to avoid.
 */
export interface SourceResult {
  matters: PackMatter[];
  /** The aged debtors report's total, in rand. Present only where that
   *  report was read AND its total is a figure the pack prints. */
  agedDebtorsTotal?: number;
  /**
   * The FULL open subledger including documents that cannot be aged, present
   * whenever the aging report was read at all — which is not the same
   * condition as `agedDebtorsTotal` above.
   *
   * Page 7 needs it on EVERY pack, not only the ones that print a debtors
   * total: the memorandum there states the trade-receivable control account
   * as the numerator of debtor days, and on the live demo company that
   * account holds 0.6% of what the subledger says customers owe. A pack that
   * prints 213 days off a base like that has to say what the base is, and it
   * cannot say so without this number. See `receivablesBaseNote`.
   */
  subledgerTotal?: number;
}

const CONCENTRATION_THRESHOLD_PCT = 20;
export const NO_PRIOR_MEETING_RECORD = 'Not tracked — no prior board pack is stored to compare against.';

/**
 * EVERY MATTER ON THIS PAGE IS A SENTENCE A DIRECTOR READS, so it is written
 * the way a sentence is written.
 *
 * The rendered pack printed "is 739 day(s) overdue", "12 unreconciled bank
 * item(s)" and "across 3 account(s)" on the two governance pages: a
 * developer's plural, three times, in the part of the pack whose whole
 * purpose is to be read rather than scanned. `(s)` is what a template writes
 * when nobody has decided whether the sentence is about one thing or several,
 * and this model always knows which.
 */
function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

/**
 * A COUNT, GROUPED LIKE EVERY OTHER FIGURE ON THE SHEET. A template literal
 * printed "1012 unreconciled bank items" beside a quantum column reading
 * `1 012`: two ways of writing a thousand in one table row. The pack has one
 * whole-number formatter and one separator (`GROUP_SEPARATOR`), and this is
 * that formatter — a count is never nil where it is printed, so the en dash
 * it gives a measured zero is not reachable here.
 */
function count(n: number): string {
  return formatMoney(n, { pack: true });
}

async function agedDebtorConcentrationMatters(
  companyId: string,
  window: PeriodWindow,
): Promise<SourceResult> {
  const report = await getAgingReport(companyId, 'ar', window.end);
  // READ BEFORE THE EARLY RETURNS, because it is owed on every pack. The
  // three `return { matters: [] }` below are the concentration failing to
  // reach its threshold, which is a statement about one debtor and not about
  // whether the subledger agrees with the ledger.
  const base = { subledgerTotal: report.subledgerTotal };
  if (report.totals.total <= 0 || report.buckets.length === 0) return { ...base, matters: [] };

  // TIE-BROKEN ON THE ENTITY, for the same reason `getUnusualJournals` now
  // carries an ORDER BY: this sentence prints a CUSTOMER'S NAME, and two
  // debtors owing the identical amount would otherwise be separated by
  // whatever order the aging snapshot happened to come back in. `entityId` is
  // the unique key; the name is compared first only so an equal pair reads in
  // an order a person can predict.
  const largest = [...report.buckets].sort((a, b) => b.total - a.total
    || a.entityName.localeCompare(b.entityName)
    || a.entityId.localeCompare(b.entityId))[0]!;
  if (largest.total <= 0) return { ...base, matters: [] };

  const pct = (largest.total / report.totals.total) * 100;
  if (pct < CONCENTRATION_THRESHOLD_PCT) return { ...base, matters: [] };

  // AND THE BASE THE PERCENTAGE IS A SHARE OF IS PRINTED.
  //
  // It read "…is 77.0% of total debtors owed" with a quantum of 3 192, and NO
  // receivables figure appears anywhere in the twelve sheets — so the one
  // percentage in the governance table was the one claim in the pack a
  // director could not check. Worse, 3 192 is also Brightsphere's Total
  // assets on page 7, so the sheet offered a reader a plausible base that is
  // the wrong one. (The two are R3 191 824 and R3 191 945: different figures
  // that round to the same R'000. The concentration is computed against
  // `getAgingReport(...).totals.total`, the trade-receivable subledger, and
  // is correct — the equality is arithmetic coincidence, not a wrong field.)
  //
  // Stating the base makes the division reproducible off the sheet, and it is
  // stated in the pack's ONE prose form for a unit (`inScale`) because the
  // quantum column beside it is headed in R'000 and an unmarked figure in the
  // issue column would be read in rands.
  // AND THE NUMERATOR TOO, BECAUSE PAGE 4 HAS NO QUANTUM COLUMN. The sentence
  // stated the share and the base and left this matter's own exposure to page
  // 11's column, so Brightsphere's page 4 headlined "the largest carrying
  // 4 128 of exposure" over a panel whose largest printed figure was 4 146 —
  // the debtors BASE — with the 3 192 that ranks the row two sheets away. The
  // headline was true and the sheet's own biggest number argued against it;
  // the twelfth gate called it the pack's most damaging defect. Three figures,
  // all three named. It repeats page 11's quantum column deliberately, as the
  // credit-month matter does: a row quoting a ratio carries its numerator.
  //
  // AND THE BASE NAMES THE REPORT IT COMES OFF. Brightsphere's page 11 states
  // debtors of 4 146 and its page 7 states trade receivables of (330); the
  // first is the aged debtors report's total of what customers owe and the
  // second the trade-receivable control account in the general ledger.
  // Nothing on either sheet said they were different measures, so a director
  // comparing the two read a flat contradiction. The clause costs no page:
  // the demo sheet composes at 250.97mm of 255 with it exactly as it did
  // without it, and prints the same seven matters.
  //
  // NAMING THE SOURCE WAS NOT THE FIX, AND THE ROUND THAT THOUGHT IT WAS HAD
  // NOT LOOKED AT THE LEDGER. The wording this replaces said page 7's figure
  // was "the trade-receivable control account, which carries the credit
  // balances the aging total does not" — an explanation, offered without
  // measurement, of a 4 476 gap. It accounts for 330 of it. Read off
  // `isaflow_dev` at 7 September 2026, Brightsphere's account 1120 holds no
  // receivable at all: none of the 29 open customer invoices totalling
  // R4 164 721.50 was ever posted to the general ledger, and the R329 700
  // CREDIT that is the whole of the control balance is residue from a
  // reversal run on 13 April 2026 that reversed two months' sales invoices
  // twice against their receipts once, plus a R10 000 customer payment with
  // no invoice behind it. The two figures do not reconcile because on these
  // books they genuinely disagree.
  //
  // So the base goes back to the CALLER rather than being explained here.
  // Naming a source tells a reader the two figures are measured differently;
  // it does not tell them that the difference is unexplained, which is the
  // thing a board needs before it takes the write-off decision this matter
  // asks for. `packReceivablesReconciliation.ts` prints that on page 11,
  // and it needs this number — which only this function has read.
  return {
    ...base,
    agedDebtorsTotal: report.totals.total,
    matters: [{
    kind: 'finding',
    issue: `Aged debtor concentration: ${largest.entityName} owes `
      + `${formatMoney(round2(largest.total), { scale: PACK_SCALE })}, ${pct.toFixed(1)}% of all `
      + 'debtors owed on the aged debtors report, which come to '
      // A FULL STOP, like every other matter's issue. This one ended on its
      // unit — "…which come to 4 146, in R'000" — and sat in a column beside
      // cells that close properly.
      + `${inScale(formatMoney(report.totals.total, { scale: PACK_SCALE }), PACK_SCALE)}.`,
    quantum: round2(largest.total),
    owner: 'Credit control',
    movement: NO_PRIOR_MEETING_RECORD,
    decisionRequired: BOARD_DECISIONS.agedDebtorConcentration,
    }],
  };
}

async function unreconciledBankMatters(companyId: string): Promise<PackMatter[]> {
  // A MONEY QUESTION, SO INACTIVE ACCOUNTS ARE IN. The service leaves them out
  // by default for the pickers; a deactivated account still holds its
  // unmatched lines.
  const rows = await getBankAccountsStatus(companyId, { includeInactive: true });
  // THE SERVICE'S OWN KEYS. It maps every row to camelCase before returning
  // it; this read `unreconciled_count` and `unreconciled_balance`, the column
  // names, which are on no row it returns — so the count was always 0 and
  // the matter could not fire on any tenant.
  //
  // AND THE COUNT IS OF WHAT THE AMOUNT SUMS. `unreconciledBalance` is every
  // posted line with no journal line that is not excluded. The service's
  // `unreconciledCount` is a different population (status imported or
  // allocated); `suggestedCount` and `unallocatedCount` split the amount's
  // own population in two, so their sum is the count that belongs beside it.
  const itemsOn = (r: Record<string, unknown>): number =>
    Number(r.suggestedCount ?? 0) + Number(r.unallocatedCount ?? 0);
  const items = rows.reduce((s, r) => s + itemsOn(r), 0);
  // THE COUNT RAISES THE MATTER, NOT THE AMOUNT. `unreconciledBalance` is each
  // account's NET unmatched amount, and it was also the gate: an unmatched
  // receipt and an unmatched payment of the same size net to nil, and took
  // every other unreconciled item on the account off the page with them.
  if (items === 0) return [];
  // What the service can give: the net per account. Added WITHOUT sign across
  // accounts, so an inflow on one cannot cancel an outflow on another — and
  // said to be that, because it is not the gross value of the items.
  const total = round2(rows.reduce((s, r) => s + Math.abs(Number(r.unreconciledBalance ?? 0)), 0));
  const amountClause = total === 0
    ? '; receipts and payments among them net to nil on each account, so no amount is stated'
    : '; the amount is the net unmatched amount on each account, added without regard to sign';

  const accountCount = rows.filter((r) => itemsOn(r) > 0).length;
  return [{
    kind: 'finding',
    // NO RAND AMOUNT IN THE SENTENCE. `toLocaleString('en-ZA')` printed
    // `R1,234,567.89` — comma-separated, in rands, unbracketed — beside a
    // quantum column stated in R'000 with spaces and brackets: one figure,
    // two conventions, in the same table row. The amount IS the quantum, and
    // the quantum column prints it in the pack's own convention.
    //
    // AND IT SAYS WHICH DATE IT IS TRUE AT. `getBankAccountsStatus` takes no
    // as-at date, so a pack dated to an earlier period end prints the bank
    // position at the moment it was extracted. Every other matter on this
    // page is read as at the window's end; this one cannot be, and says so.
    issue: `${plural(items, 'unreconciled bank item')} across ${plural(accountCount, 'bank account')}`
      + ', as at the time this pack was extracted rather than at the period end'
      + amountClause,
    quantum: total,
    owner: 'Bookkeeping',
    movement: NO_PRIOR_MEETING_RECORD,
    decisionRequired: BOARD_DECISIONS.unreconciledBank,
  }];
}

async function unusualJournalMatters(
  companyId: string,
  window: PeriodWindow,
): Promise<PackMatter[]> {
  const flags = await getUnusualJournals(companyId, window);
  return flags.map((f) => ({
    kind: 'finding' as const,
    issue: `Journal ${f.entryNumber ?? f.entryId} (${
      f.reason === 'round_number' ? 'large round-number amount' : 'recorded well after its entry date'
    }): ${f.description ?? 'no description on the entry'}`,
    quantum: round2(f.amount),
    owner: 'Finance',
    movement: NO_PRIOR_MEETING_RECORD,
    decisionRequired: BOARD_DECISIONS.unusualJournal,
  }));
}

async function overdueFilingMatters(companyId: string, window: PeriodWindow): Promise<PackMatter[]> {
  // AS AT THE REPORTING DATE, not the clock. The pack printed "739 days
  // overdue" under a cover, a footer and a period line all reading 7
  // September — 739 is the count to the 6th, and it moved with the hour the
  // render ran. See `wholeDaysBetween`.
  const filings = await getOverdueStatutoryFilings(companyId, window.end);
  return filings.map((f) => ({
    kind: 'finding' as const,
    // The deadline as a DATE, not as an ISO string. `2024-08-28` in a
    // sentence on a governance page is the pack showing a reader its storage
    // format; every other date in the document is set in words.
    // NO VERB BETWEEN THE FILING AND ITS COUNT. It read "<type> for FY2024 is
    // N days overdue", and `filingType` is ledger text: "Annual Financial
    // Statements is 739 days overdue" printed four times per pack, in the
    // first action item a director reads. A verb cannot agree with a subject
    // this module does not choose — "are" is wrong for VAT201 the moment that
    // filing type is tracked — so the sentence takes the colon and states the
    // count, which is number-agnostic and one word shorter on a page budgeted
    // in lines of paper.
    issue: `${f.filingType} for FY${f.fiscalYear}: ${plural(f.daysOverdue, 'day')} overdue `
      + `(due ${formatPackDate(String(f.deadline))})`,
    quantum: null,
    owner: 'Company secretary',
    movement: NO_PRIOR_MEETING_RECORD,
    decisionRequired: BOARD_DECISIONS.overdueFiling,
  }));
}

/**
 * One entry per spec §4.A source, in listed order.
 *
 * TWO NAMES PER SOURCE, because the pack says its name in two different
 * sentences. `label` completes "<label> could not be assessed" when the
 * source throws, and reads as the THING the check looks at — "aged debtors
 * could not be assessed". `check` completes pages 4 and 11's enumeration of
 * what was checked, and has to name the TEST — "aged debtor concentration",
 * because "aged debtors" there would describe a report rather than a check
 * and would be the fourth different name the pack has for that page's rows.
 * Three of the four are the same string and are still written twice, so a
 * source whose two sentences need to diverge can do so without anyone
 * discovering that they share a field.
 */
export const SOURCES: ReadonlyArray<{
  label: string;
  check: string;
  build: (companyId: string, window: PeriodWindow) => Promise<SourceResult>;
}> = [
  { label: 'aged debtors', check: 'aged debtor concentration', build: agedDebtorConcentrationMatters },
  { label: 'unreconciled bank items', check: 'unreconciled bank items', build: async (companyId) => ({ matters: await unreconciledBankMatters(companyId) }) },
  { label: 'unusual journals', check: 'unusual journals', build: async (c, w) => ({ matters: await unusualJournalMatters(c, w) }) },
  { label: 'overdue statutory filings', check: 'overdue statutory filings', build: async (c, w) => ({ matters: await overdueFilingMatters(c, w) }) },
];

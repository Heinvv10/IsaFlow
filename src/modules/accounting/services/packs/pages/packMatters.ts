/**
 * Page 11 — the matters requiring board attention.
 *
 * This is the page a board pack exists for: the issues a director has to
 * decide on, not the numbers everyone can already read on the statements.
 * Spec §4.A names four sources — aged debtor concentration, unreconciled
 * bank items, unusual journals, overdue statutory filings — ranked by
 * quantum, largest first.
 *
 * The rule this file exists to enforce: a source that fails becomes a NAMED
 * matter, never a silent omission. A board pack that claims to check aged
 * debtors and quietly drops the section because a query timed out is worse
 * than one that says the check failed — a reader sees an empty page as
 * "nothing to worry about", which is the one conclusion a failed check has
 * not earned. Spec §7.1 criterion 3 is symmetric with this: an empty result
 * is also never an empty page — it is an explicit "no matters" item.
 *
 * "Movement since last meeting" is spec'd per matter, but nothing in this
 * codebase persists what a prior board pack said, so there is no baseline to
 * diff against. Every matter states that honestly rather than fabricating a
 * trend; see the task report for why inventing one would fail the same test
 * this file exists to pass.
 */

import { log } from '@/lib/logger';
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

/**
 * WHAT KIND OF LINE THIS IS, as data rather than as a sentence to re-parse.
 *
 * Page 11's title has to state a conclusion about the period — how many
 * matters are open and what they come to — and "no matters this period" is a
 * `PackMatter` too, as is "this check could not be run". Deriving that from
 * the issue text would make the page's headline depend on a string match
 * against prose the next author is free to reword.
 */
export type PackMatterKind =
  /** A real finding: a concentration, an unreconciled balance, a journal, a filing. */
  | 'finding'
  /** The explicit "every check ran clean" line (§7.1 criterion 3). */
  | 'none'
  /** A source that threw. It is a matter precisely because it is not a clean result. */
  | 'checkFailed';

/** One line of page 11 — a decision a director must make. */
export interface PackMatter {
  kind: PackMatterKind;
  issue: string;
  /** Rand value behind the matter. Null for a matter with no single amount
   *  (a filing overdue, or the "no matters" / "check failed" fallbacks).
   *  Ranking treats null as zero. */
  quantum: number | null;
  owner: string;
  /** Movement since the last board meeting — see the file header for why
   *  this is always the same honest statement rather than a computed trend. */
  movement: string;
  decisionRequired: string;
}

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
interface SourceResult {
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

/** Everything page 11 needs from the ledger: its matters, and the aged
 *  debtors total page 11's own reconciliation note is taken against. */
export interface PackMattersRead {
  matters: PackMatter[];
  /** Null where no aged-debtors total is printed anywhere in the pack — in
   *  which case there is no contradiction on the paper to reconcile. */
  agedDebtorsTotal: number | null;
  /** The full open AR subledger. Null only where the aging report could not
   *  be read at all, in which case the check is already a named matter. */
  subledgerTotal: number | null;
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
  return `${n} ${n === 1 ? one : many}`;
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
      + `${inScale(formatMoney(report.totals.total, { scale: PACK_SCALE }), PACK_SCALE)}`,
    quantum: round2(largest.total),
    owner: 'Credit control',
    movement: NO_PRIOR_MEETING_RECORD,
    decisionRequired: BOARD_DECISIONS.agedDebtorConcentration,
    }],
  };
}

async function unreconciledBankMatters(companyId: string): Promise<PackMatter[]> {
  const rows = await getBankAccountsStatus(companyId);
  const count = rows.reduce((s, r) => s + Number(r.unreconciled_count ?? 0), 0);
  const total = rows.reduce((s, r) => s + Math.abs(Number(r.unreconciled_balance ?? 0)), 0);
  if (count === 0 || round2(total) === 0) return [];

  const accountCount = rows.filter((r) => Number(r.unreconciled_count ?? 0) > 0).length;
  return [{
    kind: 'finding',
    // NO RAND AMOUNT IN THE SENTENCE. `toLocaleString('en-ZA')` printed
    // `R1,234,567.89` — comma-separated, in rands, unbracketed — beside a
    // quantum column stated in R'000 with spaces and brackets: one figure,
    // two conventions, in the same table row. The amount IS the quantum, and
    // the quantum column prints it in the pack's own convention.
    issue: `${plural(count, 'unreconciled bank item')} across ${plural(accountCount, 'bank account')}`,
    quantum: round2(total),
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
 * What a swallowed exception is allowed to say in the log: its class and, for
 * a Postgres error, its SQLSTATE. Never its message — see the call site.
 */
function errorClass(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)
    ? `${error.name} (SQLSTATE ${code})`
    : error.name;
}

/** One entry per spec §4.A source, in listed order. Pairs the normal builder
 *  with the label used when that source throws. */
const SOURCES: ReadonlyArray<{
  label: string;
  build: (companyId: string, window: PeriodWindow) => Promise<SourceResult>;
}> = [
  { label: 'aged debtors', build: agedDebtorConcentrationMatters },
  { label: 'unreconciled bank items', build: async (companyId) => ({ matters: await unreconciledBankMatters(companyId) }) },
  { label: 'unusual journals', build: async (c, w) => ({ matters: await unusualJournalMatters(c, w) }) },
  { label: 'overdue statutory filings', build: async (c, w) => ({ matters: await overdueFilingMatters(c, w) }) },
];

/**
 * A FAILED CHECK IS A MATTER, AND THE EXCEPTION IS NOT PART OF IT.
 *
 * The matter still appears — that is this file's whole rule, and it is why
 * the pack cannot present a timed-out query as a clean page. What came off is
 * `String(error)`, which put a driver's message, and whatever a database
 * chooses to put in one, into the issue column of a document a director
 * forwards to their bank. The reader's decision is the same either way: re-run
 * the check. The exception is logged, where the person who can act on it
 * looks.
 */
function failedSourceMatter(label: string): PackMatter {
  return {
    kind: 'checkFailed',
    issue: `${label} could not be assessed — the check failed and was not silently skipped`,
    quantum: null,
    owner: 'Finance',
    movement: NO_PRIOR_MEETING_RECORD,
    decisionRequired: BOARD_DECISIONS.checkFailed,
  };
}

// NOT IN `BOARD_DECISIONS`, deliberately — see that module: this row says
// there is nothing to decide, and phrasing that as a decision would invent one.
const NO_MATTERS: PackMatter = {
  kind: 'none',
  issue: 'No matters require board attention this period — every check ran clean.',
  quantum: null,
  owner: 'Finance',
  movement: NO_PRIOR_MEETING_RECORD,
  decisionRequired: 'None. Note for the record.',
};

export async function buildMatters(
  companyId: string,
  window: PeriodWindow,
): Promise<PackMattersRead> {
  const matters: PackMatter[] = [];
  let agedDebtorsTotal: number | null = null;
  let subledgerTotal: number | null = null;

  // Sequential, not Promise.all — `sql` in @/lib/neon routes every query
  // through the ONE request-scoped pg connection held in the async-local
  // store (see packFigureSet.ts for the same discipline and its reason).
  for (const source of SOURCES) {
    try {
      const result = await source.build(companyId, window);
      matters.push(...result.matters);
      if (result.agedDebtorsTotal !== undefined) agedDebtorsTotal = result.agedDebtorsTotal;
      if (result.subledgerTotal !== undefined) subledgerTotal = result.subledgerTotal;
    } catch (error) {
      // NOT `String(error)`, WHICH IS THE DRIVER'S OWN SENTENCE. A
      // node-postgres message carries whatever the server put in it —
      // "duplicate key value violates unique constraint … Key (email)=(…)"
      // is a real one — so the free text is a tenant's data in a log line
      // that outlives the request. The class and the SQLSTATE are what
      // triage actually reads, and `source.label` is the stable identifier
      // that says WHICH check failed.
      log.warn(
        'packMatters: source failed, recorded as a named matter rather than omitted',
        { companyId, source: source.label, error: errorClass(error) },
        'packs',
      );
      matters.push(failedSourceMatter(source.label));
    }
  }

  if (matters.length === 0) return { matters: [NO_MATTERS], agedDebtorsTotal, subledgerTotal };

  return {
    matters: matters.sort((a, b) => Math.abs(b.quantum ?? 0) - Math.abs(a.quantum ?? 0)),
    agedDebtorsTotal,
    subledgerTotal,
  };
}

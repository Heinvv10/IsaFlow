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
): Promise<PackMatter[]> {
  const report = await getAgingReport(companyId, 'ar', window.end);
  if (report.totals.total <= 0 || report.buckets.length === 0) return [];

  // TIE-BROKEN ON THE ENTITY, for the same reason `getUnusualJournals` now
  // carries an ORDER BY: this sentence prints a CUSTOMER'S NAME, and two
  // debtors owing the identical amount would otherwise be separated by
  // whatever order the aging snapshot happened to come back in. `entityId` is
  // the unique key; the name is compared first only so an equal pair reads in
  // an order a person can predict.
  const largest = [...report.buckets].sort((a, b) => b.total - a.total
    || a.entityName.localeCompare(b.entityName)
    || a.entityId.localeCompare(b.entityId))[0]!;
  if (largest.total <= 0) return [];

  const pct = (largest.total / report.totals.total) * 100;
  if (pct < CONCENTRATION_THRESHOLD_PCT) return [];

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
  return [{
    kind: 'finding',
    issue: `Aged debtor concentration: ${largest.entityName} is ${pct.toFixed(1)}% of all debtors `
      + `owed, which come to ${inScale(formatMoney(report.totals.total, { scale: PACK_SCALE }), PACK_SCALE)}`,
    quantum: round2(largest.total),
    owner: 'Credit control',
    movement: NO_PRIOR_MEETING_RECORD,
    decisionRequired: 'Approve escalation, a credit hold, or a write-off review for this account.',
  }];
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
    decisionRequired: 'Approve time and resource to clear the reconciliation backlog.',
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
    decisionRequired: 'Confirm supporting evidence for this entry or refer it for reversal.',
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
    decisionRequired: 'Approve immediate filing and confirm any penalty exposure.',
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
  build: (companyId: string, window: PeriodWindow) => Promise<PackMatter[]>;
}> = [
  { label: 'aged debtors', build: agedDebtorConcentrationMatters },
  { label: 'unreconciled bank items', build: (companyId) => unreconciledBankMatters(companyId) },
  { label: 'unusual journals', build: unusualJournalMatters },
  { label: 'overdue statutory filings', build: overdueFilingMatters },
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
    decisionRequired: 'Re-run this check before the meeting; do not treat the omission as clean.',
  };
}

const NO_MATTERS: PackMatter = {
  kind: 'none',
  issue: 'No matters require board attention this period — every check ran clean.',
  quantum: null,
  owner: 'Finance',
  movement: NO_PRIOR_MEETING_RECORD,
  decisionRequired: 'None. Note for the record.',
};

export async function buildMatters(companyId: string, window: PeriodWindow): Promise<PackMatter[]> {
  const matters: PackMatter[] = [];

  // Sequential, not Promise.all — `sql` in @/lib/neon routes every query
  // through the ONE request-scoped pg connection held in the async-local
  // store (see packFigureSet.ts for the same discipline and its reason).
  for (const source of SOURCES) {
    try {
      matters.push(...(await source.build(companyId, window)));
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

  if (matters.length === 0) return [NO_MATTERS];

  return matters.sort((a, b) => Math.abs(b.quantum ?? 0) - Math.abs(a.quantum ?? 0));
}

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
import { getBankAccountsStatus } from '@/modules/accounting/services/bank/bankAccountStatusService';
import { getUnusualJournals } from '@/modules/accounting/services/reports/unusualJournalsService';
import { getOverdueStatutoryFilings } from '@/modules/accounting/services/reports/statutoryFilingsService';
import { round2 } from '@/modules/accounting/services/reconciliation/reconciliationMath';
import type { PeriodWindow } from '@/modules/accounting/services/reports/priorPeriod';

/** One line of page 11 — a decision a director must make. */
export interface PackMatter {
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
const NO_PRIOR_MEETING_RECORD = 'Not tracked — no prior board pack is stored to compare against.';

async function agedDebtorConcentrationMatters(
  companyId: string,
  window: PeriodWindow,
): Promise<PackMatter[]> {
  const report = await getAgingReport(companyId, 'ar', window.end);
  if (report.totals.total <= 0 || report.buckets.length === 0) return [];

  const largest = [...report.buckets].sort((a, b) => b.total - a.total)[0]!;
  if (largest.total <= 0) return [];

  const pct = (largest.total / report.totals.total) * 100;
  if (pct < CONCENTRATION_THRESHOLD_PCT) return [];

  return [{
    issue: `Aged debtor concentration: ${largest.entityName} is ${pct.toFixed(1)}% of total debtors owed`,
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
    issue: `${count} unreconciled bank item(s) totalling R${round2(total).toLocaleString('en-ZA')} across ${accountCount} account(s)`,
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
    issue: `Journal ${f.entryNumber ?? f.entryId} (${
      f.reason === 'round_number' ? 'large round-number amount' : 'recorded well after its entry date'
    }): ${f.description ?? 'no description on the entry'}`,
    quantum: round2(f.amount),
    owner: 'Finance',
    movement: NO_PRIOR_MEETING_RECORD,
    decisionRequired: 'Confirm supporting evidence for this entry or refer it for reversal.',
  }));
}

async function overdueFilingMatters(companyId: string): Promise<PackMatter[]> {
  const filings = await getOverdueStatutoryFilings(companyId);
  return filings.map((f) => ({
    issue: `${f.filingType} for FY${f.fiscalYear} is ${f.daysOverdue} day(s) overdue (due ${f.deadline})`,
    quantum: null,
    owner: 'Company secretary',
    movement: NO_PRIOR_MEETING_RECORD,
    decisionRequired: 'Approve immediate filing and confirm any penalty exposure.',
  }));
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
  { label: 'overdue statutory filings', build: (companyId) => overdueFilingMatters(companyId) },
];

function failedSourceMatter(label: string, error: unknown): PackMatter {
  return {
    issue: `${label} could not be assessed — the check failed and was not silently skipped (${String(error)})`,
    quantum: null,
    owner: 'Finance',
    movement: NO_PRIOR_MEETING_RECORD,
    decisionRequired: 'Re-run this check before the meeting; do not treat the omission as clean.',
  };
}

const NO_MATTERS: PackMatter = {
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
      log.warn(
        'packMatters: source failed, recorded as a named matter rather than omitted',
        { companyId, source: source.label, error: String(error) },
        'packs',
      );
      matters.push(failedSourceMatter(source.label, error));
    }
  }

  if (matters.length === 0) return [NO_MATTERS];

  return matters.sort((a, b) => Math.abs(b.quantum ?? 0) - Math.abs(a.quantum ?? 0));
}

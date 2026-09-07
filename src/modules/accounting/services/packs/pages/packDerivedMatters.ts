/**
 * THE MATTERS THE PACK DERIVES FROM ITS OWN SERIES, rather than from a query.
 *
 * `packMatters.ts` reads the ledger — four checks, four queries, and the whole
 * module is mocked wholesale by the tests that hold `buildBoardPackDocument`
 * to one tenant. Nothing here reads anything: it takes the trend the pack has
 * already drawn and turns one of its facts into a line on page 11, which is
 * why it is its own file rather than a fifth entry in that module's SOURCES.
 */
import { round2 } from '@/modules/accounting/services/reconciliation/reconciliationMath';
import { NO_PRIOR_MEETING_RECORD, type PackMatter } from './packMatters';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';

/**
 * A MONTH WHOSE EXPENSES ARE A NET CREDIT IS A MATTER, AND NO DATABASE CHECK
 * COULD SEE IT.
 *
 * The rendered demo pack drew a net profit of +1 908 R'000 for July 2026 in a
 * company reporting R100k of revenue for the whole period, said on the trends
 * panel that the month's expenses were a net credit — and no matter on page 11
 * referred to it. That silence was not an oversight of ranking: the cause was
 * seven payroll journals dated 2031 reversed into July, and every check that
 * feeds this page misses them by construction. `getUnusualJournals` selects on
 * `entry_date BETWEEN` the reporting window, so the 2031 originals are not in
 * the result set at all, and it flags an entry only when it was RECORDED WELL
 * AFTER its entry date — a reversal dated and posted in the same July is
 * neither late nor a round number.
 *
 * So the matter is derived from the series the pack already draws, which is
 * where the anomaly is visible: a month in which more was reversed out of
 * expense accounts than was posted into them. That is a statement about the
 * ledger taken from a field the trend already carries, it names no journal
 * this model has not read, and it is the same fact `creditMonthClause` prints
 * on the panel — one derivation, two pages, so the largest visual event in the
 * document stops being one the governance page has never heard of.
 */
export function creditMonthMatters(trend: PackTrendPoint[]): PackMatter[] {
  return trend.filter((point) => point.expenses < 0).map((point) => ({
    kind: 'finding' as const,
    issue: `${point.label}: expenses for the month are a net credit — more was reversed out of `
      + 'expense accounts than was posted into them, so the month reports a profit the period does '
      + 'not',
    quantum: round2(Math.abs(point.expenses)),
    owner: 'Finance',
    movement: NO_PRIOR_MEETING_RECORD,
    decisionRequired: 'Identify the reversals behind the credit and confirm the period they belong to.',
  }));
}

/**
 * Every matter the pack has, with the derived ones added — and the "every
 * check ran clean" line removed where they are, because a page cannot carry
 * both.
 */
export function withDerivedMatters(matters: PackMatter[], trend: PackTrendPoint[]): PackMatter[] {
  const derived = creditMonthMatters(trend);
  if (derived.length === 0) return matters;
  return [...matters.filter((m) => m.kind !== 'none'), ...derived];
}

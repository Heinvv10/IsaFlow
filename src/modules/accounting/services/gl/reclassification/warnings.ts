/**
 * What a reader has to be told before they let a reclassification post.
 *
 * THE ONE THIS FILE EXISTS FOR. On the books this was built against, 36 of the
 * 37 unclassified expense accounts are NOT misfiled: `COS - Direct Material -
 * EX2001`, `COS - Sub-Contractors - EX2005`, `Salaries & Wages - EX4000` carry
 * the right amounts under the right names and merely lack an `account_subtype`.
 * Moving their lines onto a generic target would collapse Direct Material,
 * Sub-Contractors and Wayleave into one line and destroy analysis that exists
 * today — while SETTING THE SUBTYPE achieves the same reporting goal and moves
 * nothing. The tool is general and the operator chooses; a tool that will
 * happily destroy detail without saying so is not finished.
 *
 * So: `subtype_remedy_available` fires on exactly that shape, and
 * `collapses_named_accounts` fires when the target already carries value from
 * somewhere else. Neither refuses. Both are in front of the reader before the
 * write.
 *
 * Pure, apart from `targetPriorSources`.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { ReclassCandidate } from './candidates';
import type { ReclassImpact } from './impact';
import type { ClassifiedFigures } from '../accountClassification';

/** The bands a reader judges a reclassification by. All numeric. */
type PlBand = 'revenue' | 'otherIncome' | 'costOfSales' | 'grossProfit'
  | 'operatingExpenses' | 'otherExpenses' | 'depreciation' | 'netProfit';
const PL_BANDS: readonly PlBand[] = [
  'revenue', 'otherIncome', 'costOfSales', 'grossProfit',
  'operatingExpenses', 'otherExpenses', 'depreciation', 'netProfit',
];
// Compile-time proof that every band above is a numeric field of the figures
// the classifier produces: a renamed band fails here rather than silently
// comparing two undefineds and reporting "no effect".
const _bandsAreNumeric: readonly (keyof ClassifiedFigures)[] = PL_BANDS;
void _bandsAreNumeric;

export interface ReclassWarning {
  /** Machine-stable snake_case. Callers branch on this, never on the prose. */
  code: ReclassWarningCode;
  detail: string;
}

export type ReclassWarningCode =
  | 'subtype_remedy_available'
  | 'collapses_named_accounts'
  | 'crosses_account_type'
  | 'crosses_fiscal_periods'
  | 'net_movement_near_zero'
  | 'no_profit_and_loss_effect'
  | 'basis_disagreement';

export interface WarningAccount {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
}

export interface WarningInput {
  source: WarningAccount;
  target: WarningAccount;
  movable: readonly ReclassCandidate[];
  impact: ReclassImpact;
  /** Distinct OTHER accounts already reclassified into the target. */
  priorSources: number;
}

const money = (v: number): string =>
  `R${Math.abs(v).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function reclassWarnings(input: WarningInput): ReclassWarning[] {
  const { source, target, movable, impact } = input;
  const warnings: ReclassWarning[] = [];

  if (source.subtype === null && source.type === target.type) {
    warnings.push({
      code: 'subtype_remedy_available',
      detail:
        `${source.code} ${source.name} has no account_subtype, which is why it is ` +
        'absent from the classified bands of every report. Setting that subtype with ' +
        'update_gl_account fixes the classification and MOVES NOTHING. This move ' +
        `instead merges ${source.name} into ${target.name}: after it, no report can ` +
        `tell the two apart, and ${source.code}'s own name stops appearing against ` +
        'its costs. Prefer the subtype unless the amounts are genuinely misfiled.',
    });
  }

  const targetCarries = impact.accounts.find((a) => a.accountId === target.id);
  if ((targetCarries && targetCarries.lineCountBefore > 0) || input.priorSources > 0) {
    const existing = targetCarries?.lineCountBefore ?? 0;
    warnings.push({
      code: 'collapses_named_accounts',
      detail:
        `${target.code} ${target.name} already carries ${existing} posted line` +
        `${existing === 1 ? '' : 's'} in this window` +
        (input.priorSources > 0
          ? `, and ${input.priorSources} other account${input.priorSources === 1 ? ' has' : 's have'} ` +
            'already been reclassified into it'
          : '') +
        `. After this batch, ${source.name} and whatever is already there report as one ` +
        'figure and cannot be separated again except by reversing the batch.',
    });
  }

  if (source.type !== target.type) {
    warnings.push({
      code: 'crosses_account_type',
      detail:
        `${source.code} is ${source.type} and ${target.code} is ${target.type}. This does ` +
        'not just re-band a figure — it moves the amount between the profit and loss ' +
        'and the balance sheet. Check that this is what you mean.',
    });
  }

  // With a posting date, the charge leaves the period that incurred it. That is
  // the whole point when correcting a closed month, and it is still a change to
  // two periods' reported results rather than one.
  const dates = new Set(movable.map((m) => m.entryDate.slice(0, 7)));
  if (impact.window.start.slice(0, 7) !== impact.window.end.slice(0, 7) && dates.size > 0) {
    const months = [...dates].sort();
    warnings.push({
      code: 'crosses_fiscal_periods',
      detail:
        `The source lines span ${months.length} month${months.length === 1 ? '' : 's'} ` +
        `(${months[0]} to ${months[months.length - 1]}). The before/after profit and loss ` +
        'below covers the whole span; it does not show how the move redistributes value ' +
        'between the months inside it.',
    });
  }

  // `49775626 Unallocated Income` is R31.6m gross and −R658k net: a clearing
  // account, not a revenue account. A reader shown only the net would conclude
  // the move barely matters while 109 lines change account.
  const sourceMovement = impact.accounts.find((a) => a.accountId === source.id);
  if (sourceMovement) {
    const gross = sourceMovement.grossBefore;
    const net = Math.abs(sourceMovement.before);
    if (gross > 0 && net / gross < 0.1) {
      warnings.push({
        code: 'net_movement_near_zero',
        detail:
          `${source.code} carries ${money(gross)} gross against ${money(net)} net — it is ` +
          'being used as a clearing account, so a net-based reading will understate what ' +
          'this move does. Judge it on the gross and on the line count, not the net.',
      });
    }
  }

  // On the live Velocity books, moving 414 lines and R11.3m off
  // `49775627 Unallocated Expense` onto `5100 Materials & Supplies` changes NO
  // P&L band: an expense with a NULL subtype already defaults into operating
  // expenses, and `default_expense` lands there too. The move is a great deal
  // of ledger movement for no reported difference, and it costs the source
  // account's name. A reader must be told that in the response, not left to
  // notice that two blocks of numbers happen to match.
  if (movable.length > 0 && PL_BANDS.every(
    (band) => Math.abs(impact.profitAndLossBefore[band] - impact.profitAndLossAfter[band]) < 0.01,
  )) {
    warnings.push({
      code: 'no_profit_and_loss_effect',
      detail:
        `Every profit-and-loss band is IDENTICAL before and after: ${source.code} and ` +
        `${target.code} already report in the same band, so moving ${movable.length} line` +
        `${movable.length === 1 ? '' : 's'} changes no reported figure. What it does change ` +
        'is the account name against the costs. If the goal was to get these amounts into ' +
        'the classified bands, this target does not do it — check the target\'s subtype.',
    });
  }

  if (impact.basisFault) {
    warnings.push({ code: 'basis_disagreement', detail: impact.basisFault });
  }

  return warnings;
}

/**
 * How many DISTINCT other accounts have already been reclassified into this
 * target by an un-reversed batch.
 *
 * This is the collapse question asked across calls, which is where it actually
 * arises: one call moves one account, and the detail is lost only once a second
 * account lands on the same target.
 */
export async function targetPriorSources(
  companyId: string,
  targetAccountId: string,
  excludeSourceAccountId: string,
): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(DISTINCT b.source_account_id)::INT AS n
      FROM reclassification_batches b
     WHERE b.company_id        = ${companyId}::UUID
       AND b.target_account_id = ${targetAccountId}::UUID
       AND b.source_account_id <> ${excludeSourceAccountId}::UUID
       AND EXISTS (
         SELECT 1 FROM reclassification_batch_lines l
           JOIN gl_journal_entries je
             ON je.id = l.journal_entry_id AND je.company_id = l.company_id
          WHERE l.company_id = b.company_id
            AND l.batch_id   = b.id
            AND je.reversed_at IS NULL
       )
  `) as DbRow[];
  return Number(rows[0]?.n ?? 0);
}

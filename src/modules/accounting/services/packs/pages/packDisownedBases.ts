/**
 * A RED MISS ON A BASE THE PACK DISOWNS, SAID ON THE ROW THAT SCORES IT.
 *
 * The demo pack's sheet 9 prints `Current ratio · (0.14) · target 1.50 ·
 * MISSED` in red, and its sheet 7 says of the numerator: "Current assets are
 * (464). An asset below zero is not a balance a business can hold … the
 * balances should be resolved before this sheet is relied on."
 * Brightsphere's ONLY scored target is the same ratio on current assets of
 * (3 372), and its sheet 7 says the same thing. The pack scores a judgement
 * against figures it disowns two pages earlier, and the cross-reference runs
 * one way: page 7 does not know it is being scored.
 *
 * Debtor days is the same shape with the other flag — the base is the control
 * account and the customer subledger says something else — and last round we
 * put that caveat on that one row by hand. Hand-writing the next one is how
 * this becomes true of one ratio and not the next.
 *
 * SO THE INPUTS ARE DECLARED AND THE FLAG IS DERIVED. `METRIC_INPUTS` is a
 * fact about the FORMULAS — which ledger figures each ratio is computed from,
 * the same fields `calculateExtendedRatios` reads — and the caveat follows
 * from the state of those figures. Add a metric and it is either in the table
 * or it carries no flag; change a company's books and the flag moves on its
 * own. Neither is a sentence anyone maintains.
 *
 * TWO STATES COUNT, and both are ones the pack states elsewhere in its own
 * words:
 *
 *  - IMPOSSIBLE — an asset or liability the wrong side of zero, which page
 *    7's "Balances below zero" block names and explains;
 *  - UNRECONCILED — trade receivables against the open customer subledger,
 *    which page 4 states and page 11 decomposes.
 *
 * Nothing here judges the books. It says the sheet that scored the row is
 * scoring it on a figure the pack has already qualified, and where.
 */
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { PackScorecardGroup } from './packPageModel';

/** The ledger figures a scorecard metric is computed from. Keyed by the
 *  metric name the row prints, because that is what a reader matches. */
const METRIC_INPUTS: Record<string, readonly BaseField[]> = {
  'Current ratio': ['currentAssets', 'currentLiabilities'],
  'Cash ratio': ['cash', 'currentLiabilities'],
  'Debtor days': ['accountsReceivable'],
  'Creditor days': ['accountsPayable'],
  'Debt-to-equity': ['totalLiabilities'],
  'Cash conversion cycle': ['accountsReceivable', 'accountsPayable', 'inventory'],
  'Operating cash flow': ['cash'],
};

/** The balance-sheet fields a ratio can stand on. Deliberately NOT equity or
 *  any income line: negative equity is a real position a business can hold
 *  and page 7 says so, and an income line the wrong way round is page 6's
 *  disclosure, not a balance a ratio is taken on. */
type BaseField =
  | 'currentAssets' | 'cash' | 'accountsReceivable' | 'totalAssets'
  | 'currentLiabilities' | 'totalLiabilities' | 'accountsPayable' | 'inventory';

/** How a reader sees the field named on page 7. */
const FIELD_LABEL: Record<BaseField, string> = {
  currentAssets: 'current assets',
  cash: 'cash',
  accountsReceivable: 'trade receivables',
  totalAssets: 'total assets',
  currentLiabilities: 'current liabilities',
  totalLiabilities: 'total liabilities',
  accountsPayable: 'trade payables',
  inventory: 'inventory',
};

export interface DisownedBase {
  /** The metric whose row carries the flag. */
  metric: string;
  /** The figures it stands on that the pack qualifies, in reading order. */
  fields: string[];
  /** Whether any of them is a balance page 7 says cannot be held. */
  impossible: boolean;
  /** Whether any of them is the receivables figure page 4 disowns. */
  unreconciled: boolean;
}

/**
 * Which SCORED rows stand on a figure the pack qualifies elsewhere.
 *
 * Only scored rows: a metric printing a reason instead of a number is already
 * refusing to judge, and flagging it would qualify a judgement nobody made.
 */
export function disownedBases(
  groups: PackScorecardGroup[],
  set: PackFigureSet,
  /** True where page 4's debtors-base note fires — the same condition, asked
   *  of the same builder, so the two sheets cannot come apart. */
  receivablesUnreconciled: boolean,
): DisownedBase[] {
  const out: DisownedBase[] = [];
  for (const row of groups.flatMap((g) => g.rows)) {
    if (row.status !== 'met' && row.status !== 'missed') continue;
    const inputs = METRIC_INPUTS[row.metric];
    if (inputs === undefined) continue;

    const impossible = inputs.filter((field) => (set.current[field] ?? 0) < 0);
    const unreconciled = receivablesUnreconciled && inputs.includes('accountsReceivable');
    if (impossible.length === 0 && !unreconciled) continue;

    const fields = impossible.map((field) => FIELD_LABEL[field]);
    if (unreconciled && !fields.includes(FIELD_LABEL.accountsReceivable)) {
      fields.push(FIELD_LABEL.accountsReceivable);
    }
    out.push({ metric: row.metric, fields, impossible: impossible.length > 0, unreconciled });
  }
  return out;
}

/** "a", "a and b", "a, b and c". */
function inWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The sentence page 9 prints once for every flagged row, or null where none
 * is flagged.
 *
 * ONE FOOTNOTE FOR ALL OF THEM, not one per row: the sheet's whole budget is
 * measured in lines, the reason is the same reason, and a director reading
 * two red rows needs to be sent to one place. The FIELDS are named so the
 * marker resolves to the figure rather than to a general warning.
 */
export function disownedBasesFootnoteText(bases: DisownedBase[]): string | null {
  if (bases.length === 0) return null;
  const fields = [...new Set(bases.flatMap((b) => b.fields))];
  const anyImpossible = bases.some((b) => b.impossible);
  const anyUnreconciled = bases.some((b) => b.unreconciled);
  // EACH ARM CARRIES ITS OWN SUBJECT. Written as "which ${where} and does
  // not adjust", the balance-sheet arm read "which the balance sheet says
  // cannot be held and does not adjust" — the sheet doing the not-adjusting.
  // The clause that follows names who.
  const where = anyImpossible && anyUnreconciled
    ? 'which this pack qualifies elsewhere and does not adjust'
    : anyImpossible
      ? 'which the balance sheet says cannot be held as stated; this pack does not adjust'
      : 'which the commentary page says is not reconciled; this pack does not adjust';
  return `Scored on ${inWords(fields)}, ${where}.`;
}

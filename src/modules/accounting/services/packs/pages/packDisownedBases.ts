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
 * fact about the FORMULAS — which of the balances PAGE 7 STATES each ratio is
 * computed from — and the caveat follows from what page 7 said about them.
 * Add a metric and it is either in the table or in `NO_DECLARED_INPUTS`, and
 * a coverage test refuses a metric in neither; change a company's books and
 * the flag moves on its own. Neither is a sentence anyone maintains.
 *
 * It is NOT the whole formula. `calculateExtendedRatios` takes the cash ratio
 * on cash over current liabilities and this table names only the second,
 * because cash is not a balance page 7 states and so is not one it can
 * disown. A field this pack never qualifies has nothing to contribute to a
 * flag about qualified fields.
 *
 * TWO STATES COUNT, and both are ones the pack states elsewhere in its own
 * words:
 *
 *  - IMPOSSIBLE — an asset or liability the wrong side of zero, which page
 *    7's "Balances below zero" block names and explains;
 *  - UNRECONCILED — trade receivables against the open customer subledger,
 *    which page 4 states and page 11 decomposes.
 *
 * AND BOTH ARE ASKED OF THE BUILDER THAT MAKES THE STATEMENT, never derived
 * again here. The receivables arm has always called `receivablesBaseNote`;
 * the balance-sheet arm re-derived its own rule — `set.current[field] < 0`
 * over a field list of its own — and reached a different answer from page 7.
 * It flagged `cash` and `inventory`, and page 7's block is built from the
 * asset and liability ROWS of the position table: there is no Cash row and
 * no Inventory row, and inventory is not printed anywhere in the twelve
 * sheets. So a company with an overdrawn bank was told on page 9 that the
 * balance sheet says the figure cannot be held as stated, and page 7 said
 * nothing at all — a pointer to a page that does not carry it.
 *
 * It was wrong on the merits too, which is why the fields moved rather than
 * page 7's list growing: a negative cash balance is an overdraft, a position
 * a business genuinely holds. `impossibleBalanceLines` is now the one
 * producer and this maps its labels back to the fields the formulas read.
 *
 * Nothing here judges the books. It says the sheet that scored the row is
 * scoring it on a figure the pack has already qualified, and where.
 */
import type { ImpossibleBalanceLine } from './packPageBlocks';
import type { PackScorecardGroup } from './packPageModel';

/** The ledger figures a scorecard metric is computed from. Keyed by the
 *  metric name the row prints, because that is what a reader matches.
 *
 *  A metric whose bases page 7 never states carries no entry here and is
 *  listed in `NO_DECLARED_INPUTS` instead — an omission is then a deliberate
 *  one rather than a lookup that failed open. `packDisownedBases.test.ts`
 *  fails if a scorecard metric appears in neither, so renaming a row in
 *  `packScorecard.ts` is a red test and not a flag that silently stops. */
export const METRIC_INPUTS: Record<string, readonly BaseField[]> = {
  'Current ratio': ['currentAssets', 'currentLiabilities'],
  'Cash ratio': ['currentLiabilities'],
  'Debtor days': ['accountsReceivable'],
  'Creditor days': ['accountsPayable'],
  'Debt-to-equity': ['totalLiabilities'],
  'Cash conversion cycle': ['accountsReceivable', 'accountsPayable'],
};

/**
 * The scorecard metrics that stand on NO figure page 7 qualifies, named so
 * the coverage test can tell a deliberate omission from a forgotten one.
 *
 * Gross margin, operating margin and interest cover are taken on income
 * lines; an income line the wrong way round is page 6's sign disclosure, not
 * a balance a ratio is taken on. Operating cash flow is taken on cash, and
 * cash is not a balance page 7 states or disowns — see the module docblock.
 */
export const NO_DECLARED_INPUTS: readonly string[] = [
  'Gross margin', 'Operating margin', 'Interest cover', 'Operating cash flow',
];

/** The balance-sheet fields a ratio can stand on AND page 7 can name.
 *  Deliberately NOT equity or any income line: negative equity is a real
 *  position a business can hold and page 7 says so under its own heading, and
 *  an income line the wrong way round is page 6's disclosure. Not cash or
 *  inventory either — page 7 states neither, so neither can be disowned by
 *  it. */
type BaseField =
  | 'currentAssets' | 'accountsReceivable'
  | 'currentLiabilities' | 'totalLiabilities' | 'accountsPayable';

/** How a reader sees the field named on page 7. */
const FIELD_LABEL: Record<BaseField, string> = {
  currentAssets: 'current assets',
  accountsReceivable: 'trade receivables',
  currentLiabilities: 'current liabilities',
  totalLiabilities: 'total liabilities',
  accountsPayable: 'trade payables',
};

/** Page 7's own row labels, lowercased, against the field a formula reads.
 *  A row page 7 can print and no ratio stands on — Non-current assets, Total
 *  assets — is absent, and a line that maps to nothing here simply flags no
 *  metric. */
const PAGE_SEVEN_FIELD: Record<string, BaseField> = {
  'current assets': 'currentAssets',
  'current liabilities': 'currentLiabilities',
  'total liabilities': 'totalLiabilities',
  'trade receivables': 'accountsReceivable',
  'trade payables': 'accountsPayable',
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
  /** True where page 4's debtors-base note fires — the same condition, asked
   *  of the same builder, so the two sheets cannot come apart. */
  receivablesUnreconciled: boolean,
  /** The lines page 7's "Balances below zero" block actually names, from
   *  `impossibleBalanceLines` — the builder, asked, for the same reason. */
  page7Impossible: readonly ImpossibleBalanceLine[],
): DisownedBase[] {
  const disowned = new Set<BaseField>();
  for (const line of page7Impossible) {
    const field = PAGE_SEVEN_FIELD[line.label.toLowerCase()];
    if (field !== undefined) disowned.add(field);
  }
  const out: DisownedBase[] = [];
  for (const row of groups.flatMap((g) => g.rows)) {
    if (row.status !== 'met' && row.status !== 'missed') continue;
    const inputs = METRIC_INPUTS[row.metric];
    if (inputs === undefined) continue;

    const impossible = inputs.filter((field) => disowned.has(field));
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

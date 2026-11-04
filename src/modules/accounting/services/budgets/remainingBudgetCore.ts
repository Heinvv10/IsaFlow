/**
 * Remaining budget, the pure core (budgets P5 spec §3a, census T1.4). No I/O: the reader
 * (`remainingBudget.ts`) gathers the rows and this decides, per key, the grain, the slice, the
 * budget and what counts against it.
 *
 * - Version: the primary version of the registry year holding the key's month (`versionOf`).
 * - Grain (decision 4): one per account per version, the `dim_grain` of the account's rows in
 *   that version. The key's dimensions map onto it: the grain's dimension is kept, the rest
 *   dropped. A key that lacks the grain's dimension is the UNASSIGNED slice: no budget.
 * - Budget: the stored amount for (version, account, slice, month); no row = null ("No budget"),
 *   never 0. A budgeted zero is 0 (D5).
 * - Actual: posted movement at the grain (rows from P3's `readTrackingActuals`, one read per
 *   grain level), picked by (account, month, member); the untagged member is the unassigned slice.
 * - Committed: per PO line, `line_total − billed` floored at 0 (`openPoLineCents`, the one formula the
 *   PO approval check uses too), mapped onto the grain the same way, summed per slice. Once a PO line is
 *   billed its commitment is consumed WHEREVER the bill posted (decision 8a): the bill's own spend is
 *   actual on its own slice and is checked there when the bill is approved. A bill may name only its
 *   own company's PO line (`ap/supplierInvoicePoLinks`).
 * - No grain (the account holds no budget in the version, or there is no version): actual and
 *   committed are reported at company level, budget and remaining are null.
 *
 * Money is summed in integer cents.
 */
import { fromCents, toCents } from './grid/cents';

export type RemainingGrain = 'company' | 'cc1' | 'cc2' | 'bu';

/** `budget_month_amounts.dim_grain` (947: 0 company, 1 CC1, 2 CC2, 4 BU) → grain. */
export const GRAIN_BY_DIM: Readonly<Record<number, RemainingGrain>> = { 0: 'company', 1: 'cc1', 2: 'cc2', 4: 'bu' };

export interface Dims {
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
}

export interface RemainingKey extends Dims {
  glAccountId: string;
  /** 'YYYY-MM'. */
  month: string;
}

export interface RemainingResult {
  key: RemainingKey;
  versionId: string | null;
  /** The account's grain in the version; null when it holds no budget there (or there is no version). */
  grain: RemainingGrain | null;
  /** The budget slice the key maps onto (all null at company grain and for the unassigned slice). */
  slice: Dims;
  /** The key lacks the grain's dimension. */
  unassigned: boolean;
  budget: number | null;
  actual: number;
  committed: number;
  remaining: number | null;
}

export interface BudgetAmountRow extends Dims {
  versionId: string;
  glAccountId: string;
  month: string;
  amount: number;
}

export interface GrainActualRow {
  grain: RemainingGrain;
  accountId: string;
  month: string;
  memberId: string | null;
  amount: number;
}

/** One posted (ex-VAT) bill line linked to a PO line: where it landed and how much. */
export interface BilledPosting extends Dims {
  /** null: the line names no account (it posts to default_expense). */
  glAccountId: string | null;
  /** 'YYYY-MM' of the bill's invoice_date (the journal's month). */
  month: string;
  amount: number;
}

export interface CommitmentRow extends Dims {
  poItemId: string;
  glAccountId: string;
  /** The order-date month, 'YYYY-MM'. */
  month: string;
  /** Ex-VAT PO line amount. */
  lineTotal: number;
  /** The posted bill lines linked to this PO line that count as billed. */
  billed: readonly BilledPosting[];
}

/**
 * A PO line's open (still committed) amount in cents: `line_total` less ALL its linked billing, wherever it posted,
 * floored at 0 (decision 8a). The one formula for committed and for the PO approval's checked amount.
 */
export function openPoLineCents(lineTotal: number, billed: readonly BilledPosting[]): number {
  return Math.max(0, toCents(lineTotal) - billed.reduce((s, b) => s + toCents(b.amount), 0));
}

export interface RemainingInputs {
  versionOf: (month: string) => string | null;
  /** `${versionId}|${glAccountId}` → grain. */
  grains: ReadonlyMap<string, RemainingGrain>;
  budgets: readonly BudgetAmountRow[];
  actuals: readonly GrainActualRow[];
  commitments: readonly CommitmentRow[];
}

const NO_DIMS: Dims = { cc1Id: null, cc2Id: null, buId: null };

/** The key's member at `grain` (null at company grain); `unassigned` when the key lacks the grain's dimension. */
export function memberOnGrain(dims: Dims, grain: RemainingGrain): { member: string | null; unassigned: boolean } {
  if (grain === 'company') return { member: null, unassigned: false };
  const member = grain === 'cc1' ? dims.cc1Id : grain === 'cc2' ? dims.cc2Id : dims.buId;
  return { member, unassigned: member === null };
}

function sliceOf(grain: RemainingGrain, member: string | null): Dims {
  if (member === null) return NO_DIMS;
  return { cc1Id: grain === 'cc1' ? member : null, cc2Id: grain === 'cc2' ? member : null, buId: grain === 'bu' ? member : null };
}

const cell = (account: string, month: string, member: string | null) => `${account}|${month}|${member ?? ''}`;

function add(map: Map<string, number>, k: string, cents: number): void {
  map.set(k, (map.get(k) ?? 0) + cents);
}

export function computeRemaining(keys: readonly RemainingKey[], inputs: RemainingInputs): RemainingResult[] {
  // Budget cents per version|account|month|member (a row's member is its one dimension, if any).
  const budgets = new Map<string, number>();
  for (const b of inputs.budgets) {
    add(budgets, `${b.versionId}|${cell(b.glAccountId, b.month, b.cc1Id ?? b.cc2Id ?? b.buId)}`, toCents(b.amount));
  }
  const actuals = new Map<string, number>();
  for (const a of inputs.actuals) add(actuals, `${a.grain}|${cell(a.accountId, a.month, a.memberId)}`, toCents(a.amount));

  // Committed cents per grain|account|month|member, each PO line mapped onto each grain once (not per key).
  const committedBy = new Map<string, number>();
  const grainsUsed = new Set<RemainingGrain>(['company', ...inputs.grains.values()]);
  for (const c of inputs.commitments) {
    const cents = openPoLineCents(c.lineTotal, c.billed);
    if (cents === 0) continue;
    for (const g of grainsUsed) add(committedBy, `${g}|${cell(c.glAccountId, c.month, memberOnGrain(c, g).member)}`, cents);
  }
  const committedAt = (grain: RemainingGrain, account: string, month: string, member: string | null): number =>
    committedBy.get(`${grain}|${cell(account, month, member)}`) ?? 0;

  return keys.map((key) => {
    const versionId = inputs.versionOf(key.month);
    const grain = versionId === null ? null : inputs.grains.get(`${versionId}|${key.glAccountId}`) ?? null;
    const at: RemainingGrain = grain ?? 'company';
    const { member, unassigned } = memberOnGrain(key, at);
    const actual = actuals.get(`${at}|${cell(key.glAccountId, key.month, member)}`) ?? 0;
    const committed = committedAt(at, key.glAccountId, key.month, member);
    const budgetCents = grain === null || unassigned
      ? undefined
      : budgets.get(`${versionId}|${cell(key.glAccountId, key.month, member)}`);
    const budget = budgetCents === undefined ? null : fromCents(budgetCents);
    return {
      key,
      versionId,
      grain,
      slice: grain === null ? NO_DIMS : sliceOf(grain, member),
      unassigned: grain !== null && unassigned,
      budget,
      actual: fromCents(actual),
      committed: fromCents(committed),
      remaining: budgetCents === undefined ? null : fromCents(budgetCents - actual - committed),
    };
  });
}

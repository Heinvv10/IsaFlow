/**
 * Budget check at approval, the pure core (budgets P5 spec §3b; census finding 3). No I/O.
 *
 * - `sliceLines`: the document's posted lines, mapped onto the budget slices `remainingFor` resolved,
 *   SUMMED PER SLICE: two lines whose dims differ below the account's grain hit one budget and are
 *   compared against it together (each alone may fit; the pair may not). A line with no budget (no
 *   version, no grain, the unassigned slice, no row for the slice and month) is "No budget" and is
 *   never over. A budgeted zero is a budget (D5): anything above it is over. A line whose account is
 *   budgeted in the version but whose slice is not (P5-2b, `offSlice`) is summed per slice at the grain and
 *   flagged when the document's net amount there is positive.
 * - `decideBudgetOutcome`: the policy matrix (§3b), every cell unit-tested
 *   (`tests/unit/services/budgets/budgetCheckMatrix.test.ts`).
 * - `mustRetryForLock`: the policy read at check time is `block` but this transaction did not take
 *   the company lock (it read warn/off first): refuse, retryable (§3c).
 *
 * Money is compared in integer cents.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { toCents } from './grid/cents';
import type { RemainingKey, RemainingResult } from './remainingBudgetCore';
import {
  budgetDimensionName, OFF_SLICE_WARNING_PREFIX,
  type BudgetChannel, type BudgetCheckLine, type BudgetGate, type BudgetOutcome, type BudgetPolicy,
} from './budgetCheckTypes';

/** One expense line the document will post (account, dims, ex-VAT amount). */
export interface DocumentLine {
  glAccountId: string;
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
  amount: number;
  /** 'YYYY-MM' when the line posts in another month than the document (a provisional's reclass). */
  month?: string;
}

export type UnlabelledLine = Omit<BudgetCheckLine, 'accountLabel' | 'sliceLabel'>;

const low = (v: string | null | undefined): string | null => (v ? v.toLowerCase() : null);
const keyId = (k: { glAccountId: string; cc1Id: string | null; cc2Id: string | null; buId: string | null }) =>
  `${k.glAccountId.toLowerCase()}|${low(k.cc1Id) ?? ''}|${low(k.cc2Id) ?? ''}|${low(k.buId) ?? ''}`;

/** The distinct (account, dims) keys of the lines, first-seen order, for one month. */
export function distinctKeys(lines: readonly DocumentLine[], month: string): RemainingKey[] {
  const seen = new Map<string, RemainingKey>();
  for (const l of lines) {
    const k = { glAccountId: l.glAccountId.toLowerCase(), cc1Id: low(l.cc1Id), cc2Id: low(l.cc2Id), buId: low(l.buId), month };
    if (!seen.has(keyId(k))) seen.set(keyId(k), k);
  }
  return [...seen.values()];
}

/**
 * Per budget slice: budget, actual, committed, remaining and the document's own amount on it.
 * `results` answers `keys` (the `distinctKeys` of `lines`) in the same order.
 */
export function sliceLines(
  lines: readonly DocumentLine[], keys: readonly RemainingKey[], results: readonly RemainingResult[],
): UnlabelledLine[] {
  const byKey = new Map<string, RemainingResult>();
  keys.forEach((k, i) => { if (results[i]) byKey.set(keyId(k), results[i]!); });
  const slices = new Map<string, { line: UnlabelledLine; cents: number }>();
  for (const l of lines) {
    const r = byKey.get(keyId(l));
    if (!r) throw new Error(`budget check: no remaining-budget answer for account ${l.glAccountId}`);
    // A budgeted slice and an off-slice one are both keyed by the slice at the grain; "No budget" by the line's dims.
    const atGrain = r.budget !== null || r.offSlice;
    const dims = atGrain ? r.slice : { cc1Id: low(l.cc1Id), cc2Id: low(l.cc2Id), buId: low(l.buId) };
    const id = atGrain
      ? `${r.offSlice ? 'o' : 'b'}|${r.versionId ?? ''}|${keyId({ glAccountId: l.glAccountId, ...dims })}|${r.key.month}`
      : `n|${keyId(l)}|${r.key.month}`;
    const at = slices.get(id) ?? {
      cents: 0,
      line: {
        glAccountId: l.glAccountId.toLowerCase(), month: r.key.month, grain: r.grain, ...dims, unassigned: r.unassigned,
        budget: r.budget, actual: r.actual, committed: r.committed, remaining: r.remaining, amount: 0, over: false, offSlice: r.offSlice,
      },
    };
    at.cents += toCents(l.amount);
    slices.set(id, at);
  }
  return [...slices.values()].map(({ line, cents }) => ({
    ...line,
    amount: cents / 100,
    // Over: a budget exists and this document's own amount on the slice exceeds what remains.
    over: line.remaining !== null && cents > 0 && cents > toCents(line.remaining),
    // Off-slice: only a net spend there is acted on (a credit, or lines netting to nil, cannot be refused).
    offSlice: line.offSlice && cents > 0,
  }));
}

/**
 * What a person or agent can do about an off-slice line, per line (round 4, LOW 2: say only what is possible):
 * - `assign`: a purchase order's lines are edited in the app (the PO detail editor picks CC1 / CC2 / BU);
 * - `mcp`: an agent can set the line's dimensions on a draft bill with update_supplier_invoice;
 * - `none`: a bill's lines cannot be edited in the app (the detail PUT edits the header only), and a system approval
 *   has nobody at the document: the refusal's closing sentence says what is possible instead.
 */
export type OffSliceRemedy = 'assign' | 'mcp' | 'none';

export function offSliceRemedyFor(documentNoun: string, channel: BudgetChannel): OffSliceRemedy {
  if (documentNoun !== 'this bill') return 'assign';
  return channel === 'mcp' ? 'mcp' : 'none';
}

/**
 * An off-slice line, where it landed: "6100 Opex · no cost centre 1 · 2026-06, this bill R 150.00". The slice is its
 * member at the grain, or "no <dimension>" for the unassigned slice. `figures: false`: no amount.
 */
function offSliceWhere(l: BudgetCheckLine, documentNoun: string, figures: boolean, remedy: OffSliceRemedy): { where: string; tail: string } {
  const name = budgetDimensionName(l.grain);
  const slice = l.unassigned || l.sliceLabel === '' ? `no ${name}` : l.sliceLabel;
  const where = [l.accountLabel, slice, l.month].filter((s) => s !== '').join(' · ');
  const amount = figures ? `, ${documentNoun} ${formatMoney(l.amount)}` : '';
  const what = remedy === 'assign' ? `; assign a budgeted ${name}`
    : remedy === 'mcp'
      ? `; set a budgeted ${name} on the line with update_supplier_invoice (if it refuses the edit — a purchase-order link, `
        + 'project or VAT classification on the stored lines — cancel the bill and enter it again, or have an owner or admin override)'
      : '';
  return { where, tail: `${amount}${what}` };
}

/** "6100 Opex · no cost centre 1 · 2026-06: not in a budgeted slice, this order R 150.00; assign a budgeted cost centre 1". */
export function describeOffSliceLine(l: BudgetCheckLine, documentNoun = 'this bill', figures = true, remedy: OffSliceRemedy = 'assign'): string {
  const { where, tail } = offSliceWhere(l, documentNoun, figures, remedy);
  return `${where}: not in a budgeted slice${tail}`;
}

/** The warning for an off-slice line: the prefix says what it is, once. */
const offSliceWarning = (l: BudgetCheckLine, documentNoun: string, figures: boolean, remedy: OffSliceRemedy): string => {
  const { where, tail } = offSliceWhere(l, documentNoun, figures, remedy);
  return `${OFF_SLICE_WARNING_PREFIX} ${where}${tail}`;
};

/** The distinct dimensions the off-slice lines lack, as a person reads them ("cost centre 1 or business unit"). */
const missingDimensions = (lines: readonly BudgetCheckLine[]): string =>
  [...new Set(lines.map((l) => budgetDimensionName(l.grain)))].join(' or ');

/**
 * "6100 Opex · FT Fibertime · 2026-06: remaining R 100.00, this bill R 150.00" (the one ZAR format, `formatMoney`).
 * `figures: false` (a caller not entitled to budget figures, e.g. an MCP token without read:reports): "…: over budget".
 */
export function describeOverLine(l: BudgetCheckLine, documentNoun = 'this bill', figures = true): string {
  const where = [l.accountLabel, l.sliceLabel, l.month].filter((s) => s !== '').join(' · ');
  return figures ? `${where}: remaining ${formatMoney(l.remaining ?? 0)}, ${documentNoun} ${formatMoney(l.amount)}` : `${where}: over budget`;
}

/** A budget slice's identity across documents (account, month, grain, slice dims). */
export const sliceKey = (l: Pick<BudgetCheckLine, 'glAccountId' | 'month' | 'grain' | 'cc1Id' | 'cc2Id' | 'buId'>): string =>
  `${l.glAccountId}|${l.month}|${l.grain ?? '-'}|${l.cc1Id ?? ''}|${l.cc2Id ?? ''}|${l.buId ?? ''}`;

/**
 * A batch preview (MCP bulk dry run): `lines` with each budgeted slice's remaining reduced by what
 * earlier documents of the same batch, judged approved, consume there (cents per `sliceKey`), and
 * `over` decided again on the reduced figure — what the live run, in the same order under the
 * lock, reads after posting those documents.
 */
export function applyPriorConsumption(lines: readonly BudgetCheckLine[], consumed: ReadonlyMap<string, number>): BudgetCheckLine[] {
  return lines.map((l) => {
    if (l.remaining === null) return l;
    const remainingCents = toCents(l.remaining) - (consumed.get(sliceKey(l)) ?? 0);
    const amountCents = toCents(l.amount);
    return { ...l, remaining: remainingCents / 100, over: amountCents > 0 && amountCents > remainingCents };
  });
}

/**
 * Records what an approved document adds to ACTUAL per budgeted slice (its posted amount, a reclass negative).
 * The PO commitment it releases is not here: the batch preview reads committed with the earlier bills counted
 * as billed (`alsoBilledInvoiceIds`), per PO line, on the PO line's own account and slice.
 */
export function addConsumption(consumed: Map<string, number>, lines: readonly BudgetCheckLine[]): void {
  for (const l of lines) {
    if (l.remaining === null) continue;
    const k = sliceKey(l);
    consumed.set(k, (consumed.get(k) ?? 0) + toCents(l.amount));
  }
}

/** The roles that may override a block refusal (decision 8). */
export const OVERRIDE_ROLES: readonly string[] = ['owner', 'admin'];

export const hasReason = (reason: string | null | undefined): boolean =>
  typeof reason === 'string' && reason.trim().length > 0;

export interface DecisionInput {
  policy: BudgetPolicy;
  lines: readonly BudgetCheckLine[];
  channel: BudgetChannel;
  reason?: string | null;
  override?: boolean;
  actorRole?: string | null;
  documentNoun?: string;
  /** False: name the over lines without remaining or amounts (default true). */
  figures?: boolean;
}

export type BudgetDecision =
  | { kind: 'proceed'; event: Exclude<BudgetOutcome, 'refused'> | null; warnings: string[]; reason: string | null }
  | { kind: 'reason_required'; message: string }
  | { kind: 'refuse'; message: string; overrideRefused: boolean };

/** The §3b matrix. `event` null = no event row (policy off, or nothing was checked against a budget). */
export function decideBudgetOutcome(input: DecisionInput): BudgetDecision {
  const { policy, lines, channel } = input;
  const reason = hasReason(input.reason) ? input.reason!.trim() : null;
  if (policy === 'off') return { kind: 'proceed', event: null, warnings: [], reason: null };
  const over = lines.filter((l) => l.over);
  // P5-2b: a line outside every budgeted slice of a budgeted account is acted on exactly as an over line.
  const offSlice = lines.filter((l) => l.offSlice);
  const checked = lines.some((l) => l.budget !== null || l.offSlice);
  if (over.length === 0 && offSlice.length === 0) return { kind: 'proceed', event: checked ? 'pass' : null, warnings: [], reason: null };

  const noun = input.documentNoun ?? 'this bill';
  const figures = input.figures !== false;
  // Only what is possible, per document and channel (round 2 item 3, round 4 LOW 2).
  const remedyPerLine = offSliceRemedyFor(noun, channel);
  const detail = [
    ...over.map((l) => describeOverLine(l, noun, figures)), ...offSlice.map((l) => describeOffSliceLine(l, noun, figures, remedyPerLine)),
  ].join('; ');
  const warnings = [
    ...over.map((l) => `Over budget: ${describeOverLine(l, noun, figures)}`),
    ...offSlice.map((l) => offSliceWarning(l, noun, figures, remedyPerLine)),
  ];
  const what = offSlice.length === 0 ? 'over budget' : over.length === 0 ? 'outside the budgeted slices' : 'over budget or outside the budgeted slices';
  const head = offSlice.length === 0 ? 'Over budget' : over.length === 0 ? 'Not in a budgeted slice' : 'Over budget / not in a budgeted slice';

  if (policy === 'warn') {
    // A person approving in the UI answers for the overspend with a reason; bulk, MCP and system
    // callers proceed and are reported (decision 8). A bulk batch's one reason is kept when given.
    if (channel === 'ui' && reason === null) {
      return { kind: 'reason_required', message: `Give a reason to approve ${what} — ${detail}.` };
    }
    return { kind: 'proceed', event: 'warn', warnings, reason: channel === 'mcp' || channel === 'system' ? null : reason };
  }

  // block: only a single UI approve may override, only an owner or admin, and only with a reason.
  if (channel === 'ui' && input.override === true) {
    if (!OVERRIDE_ROLES.includes(input.actorRole ?? '')) {
      return { kind: 'refuse', overrideRefused: true, message: `${head} — approval refused, and only an owner or admin can override it: ${detail}.` };
    }
    if (reason === null) return { kind: 'reason_required', message: `Give a reason to override the budget — ${detail}.` };
    return { kind: 'proceed', event: 'override', warnings, reason };
  }
  // A bill's lines cannot be edited in the app: re-entering it is the way to a budgeted slice there.
  const reenter = offSlice.length > 0 && noun === 'this bill'
    ? ` cancel it and enter it again with a budgeted ${missingDimensions(offSlice)} on ${offSlice.length === 1 ? 'its line' : 'those lines'}` : '';
  const remedy = channel === 'system' && reenter
    ? ` The bill was left as a draft: an owner or admin can approve it with an override and a reason, or${reenter}.`
    : channel === 'ui'
      ? (reenter ? ` An owner or admin can override it with a reason, or${reenter}.` : ' An owner or admin can override it with a reason.')
      : ` Approve it on its own in the app, where an owner or admin can override it${channel === 'bulk' && reenter ? `, or${reenter}` : ''}.`;
  return { kind: 'refuse', overrideRefused: false, message: `${head} — approval refused: ${detail}.${remedy}` };
}

/** The policy at check time is `block`, the caller locks (`take`/`held`), and this transaction holds no lock. */
export function mustRetryForLock(policy: BudgetPolicy, gate: BudgetGate): boolean {
  return policy === 'block' && gate.mode !== 'none' && !gate.locked;
}

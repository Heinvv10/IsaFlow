/**
 * Budget check at approval, the pure core (budgets P5 spec §3b; census finding 3). No I/O.
 *
 * - `sliceLines`: the document's posted lines, mapped onto the budget slices `remainingFor` resolved,
 *   SUMMED PER SLICE: two lines whose dims differ below the account's grain hit one budget and are
 *   compared against it together (each alone may fit; the pair may not). A line with no budget (no
 *   version, no grain, the unassigned slice, no row for the slice and month) is "No budget" and is
 *   never over. A budgeted zero is a budget (D5): anything above it is over.
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
import type { BudgetChannel, BudgetCheckLine, BudgetGate, BudgetOutcome, BudgetPolicy } from './budgetCheckTypes';

/** One expense line the document will post (account, dims, ex-VAT amount). */
export interface DocumentLine {
  glAccountId: string;
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
  amount: number;
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
    const budgeted = r.budget !== null;
    const dims = budgeted ? r.slice : { cc1Id: low(l.cc1Id), cc2Id: low(l.cc2Id), buId: low(l.buId) };
    const id = budgeted
      ? `b|${r.versionId ?? ''}|${keyId({ glAccountId: l.glAccountId, ...dims })}|${r.key.month}`
      : `n|${keyId(l)}|${r.key.month}`;
    const at = slices.get(id) ?? {
      cents: 0,
      line: {
        glAccountId: l.glAccountId.toLowerCase(), month: r.key.month, grain: r.grain, ...dims, unassigned: r.unassigned,
        budget: r.budget, actual: r.actual, committed: r.committed, remaining: r.remaining, amount: 0, over: false,
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
  }));
}

/** "6100 Opex · FT Fibertime · 2026-06: remaining R 100.00, this bill R 150.00" (the one ZAR format, `formatMoney`). */
export function describeOverLine(l: BudgetCheckLine, documentNoun = 'this bill'): string {
  const where = [l.accountLabel, l.sliceLabel, l.month].filter((s) => s !== '').join(' · ');
  return `${where}: remaining ${formatMoney(l.remaining ?? 0)}, ${documentNoun} ${formatMoney(l.amount)}`;
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

/** Records what an approved document consumes per budgeted slice: its amount less the PO commitment it releases. */
export function addConsumption(consumed: Map<string, number>, lines: readonly BudgetCheckLine[], released?: ReadonlyMap<string, number>): void {
  for (const l of lines) {
    if (l.remaining === null) continue;
    const k = sliceKey(l);
    consumed.set(k, (consumed.get(k) ?? 0) + toCents(l.amount) - toCents(released?.get(k) ?? 0));
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
  const checked = lines.some((l) => l.budget !== null);
  if (over.length === 0) return { kind: 'proceed', event: checked ? 'pass' : null, warnings: [], reason: null };

  const noun = input.documentNoun ?? 'this bill';
  const detail = over.map((l) => describeOverLine(l, noun)).join('; ');
  const warnings = over.map((l) => `Over budget: ${describeOverLine(l, noun)}`);

  if (policy === 'warn') {
    // A person approving in the UI answers for the overspend with a reason; bulk, MCP and system
    // callers proceed and are reported (decision 8). A bulk batch's one reason is kept when given.
    if (channel === 'ui' && reason === null) {
      return { kind: 'reason_required', message: `Give a reason to approve over budget — ${detail}.` };
    }
    return { kind: 'proceed', event: 'warn', warnings, reason: channel === 'mcp' || channel === 'system' ? null : reason };
  }

  // block: only a single UI approve may override, only an owner or admin, and only with a reason.
  if (channel === 'ui' && input.override === true) {
    if (!OVERRIDE_ROLES.includes(input.actorRole ?? '')) {
      return { kind: 'refuse', overrideRefused: true, message: `Over budget — approval refused, and only an owner or admin can override it: ${detail}.` };
    }
    if (reason === null) return { kind: 'reason_required', message: `Give a reason to override the budget — ${detail}.` };
    return { kind: 'proceed', event: 'override', warnings, reason };
  }
  const remedy = channel === 'ui' ? ' An owner or admin can override it with a reason.' : ' Approve it on its own in the app, where an owner or admin can override it.';
  return { kind: 'refuse', overrideRefused: false, message: `Over budget — approval refused: ${detail}.${remedy}` };
}

/** The policy at check time is `block`, the caller locks (`take`/`held`), and this transaction holds no lock. */
export function mustRetryForLock(policy: BudgetPolicy, gate: BudgetGate): boolean {
  return policy === 'block' && gate.mode !== 'none' && !gate.locked;
}

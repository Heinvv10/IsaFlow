/**
 * The revenue legs of a customer invoice journal, and of a credit note that
 * reverses one. Pure — no DB — so every allocation rule is provable against the
 * real journal validator (tests/unit/services/ar/invoiceRevenueLines.test.ts).
 *
 * INVOICE. When no line is coded (every invoice before migration 870, and
 * every writer that still writes none) the result is the single
 * `default_revenue` credit of the subtotal posted before, byte for byte, and
 * the line amounts are not read. When any line is coded, the lines are grouped
 * by (account ?? default_revenue, project, cost centre) and the posted amount
 * is split across the groups by their line totals. The VAT and AR legs are
 * the caller's and are unchanged.
 *
 * Split BY WEIGHT, not posted as the raw line sums: the journal's amount is the
 * caller's (`credit`), the lines only decide where it goes. Today `credit` is
 * the document subtotal; a functional-currency posting passes its converted
 * figure and the split follows. The lines are still checked against the
 * DOCUMENT subtotal — a split nobody entered is refused, not posted.
 *
 * CREDIT NOTE. `prorateRevenueLegs` debits the invoice journal's own revenue
 * legs pro rata to the note, so a credit note reverses to the accounts,
 * projects and cost centres the invoice actually credited — the journal, not
 * the lines, because an invoice posted before this change credited
 * default_revenue whatever its lines said.
 */
import type { JournalLineInput } from '../../types/gl.types';
import { InvoiceLineCodingRefusal, isCoded, type InvoiceLineCoding } from './invoiceLineCoding';

export interface StoredRevenueLine extends InvoiceLineCoding {
  amount: number;
}

export interface RevenueLeg {
  /** The leg's identity: the account the invoice journal credited. */
  glAccountId: string;
  /** Where a note debits the leg now — default_revenue once that account is deactivated. Defaults to glAccountId. */
  postAccountId?: string;
  projectId: string | null;
  costCenterId: string | null;
  /** Credit minus debit the invoice journal posted to this leg. */
  net: number;
}

const cents = (n: number): number => Math.round(n * 100);
const rands = (c: number): number => c / 100;
const money = (c: number): string => rands(c).toFixed(2);

/**
 * `total` (an integer, cents) split in proportion to `weights`, each share
 * rounded to the cent; the rounding residual goes to the weight largest in
 * magnitude (the first, on a tie), so the shares always sum to `total`.
 * Weights must sum to more than zero.
 */
export function allocateByWeight(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map((w) => Math.round((total * w) / sum));
  let largest = 0;
  weights.forEach((w, i) => { if (Math.abs(w) > Math.abs(weights[largest]!)) largest = i; });
  shares[largest] = shares[largest]! + (total - shares.reduce((a, b) => a + b, 0));
  return shares;
}

/** Why these lines cannot stand behind this subtotal, or null. One cent of rounding per line either way. */
export function revenueLinesInconsistency(lines: readonly StoredRevenueLine[], documentSubtotal: number): string | null {
  const lineTotal = lines.reduce((s, l) => s + cents(l.amount), 0);
  if (Math.abs(lineTotal - cents(documentSubtotal)) <= lines.length) return null;
  return `its lines add up to ${money(lineTotal)} but its subtotal is ${money(cents(documentSubtotal))}`;
}

const dims = (projectId: string | null, costCenterId: string | null) => ({
  projectId: projectId ?? undefined,
  costCenterId: costCenterId ?? undefined,
});

/** A signed amount (cents) as a journal line: positive on `side`, negative on the other, zero dropped. */
function leg(
  glAccountId: string, signed: number, side: 'debit' | 'credit', description: string,
  projectId: string | null, costCenterId: string | null,
): JournalLineInput | null {
  if (signed === 0) return null;
  const onSide = signed > 0 ? side : side === 'debit' ? 'credit' : 'debit';
  const amount = rands(Math.abs(signed));
  return {
    glAccountId,
    debit: onSide === 'debit' ? amount : 0,
    credit: onSide === 'credit' ? amount : 0,
    description,
    ...dims(projectId, costCenterId),
  };
}

/**
 * Why coded lines cannot post behind this subtotal, or null: they do not add up
 * to it, or they total zero or less (nothing to split). The ONE wording both
 * the pre-write approve check and the builder refuse with.
 */
export function revenueLinesProblem(lines: readonly StoredRevenueLine[], documentSubtotal: number): string | null {
  const inconsistency = revenueLinesInconsistency(lines, documentSubtotal);
  if (inconsistency) return `${inconsistency}. Re-save the draft so its totals are recalculated.`;
  if (lines.reduce((s, l) => s + cents(l.amount), 0) <= 0) return 'its coded lines total zero or less, so there is no revenue to split.';
  return null;
}

export function buildInvoiceRevenueLines(input: {
  invoiceNumber: string;
  documentSubtotal: number;
  credit: number;
  lines: readonly StoredRevenueLine[];
  defaultRevenueAccountId: string;
}): JournalLineInput[] {
  const { invoiceNumber, documentSubtotal, credit, lines, defaultRevenueAccountId } = input;
  const description = `Revenue: ${invoiceNumber}`;
  if (!lines.some(isCoded)) {
    return [{ glAccountId: defaultRevenueAccountId, debit: 0, credit, description }];
  }

  const problem = revenueLinesProblem(lines, documentSubtotal);
  if (problem) throw new InvoiceLineCodingRefusal(`Invoice ${invoiceNumber}: ${problem}`);

  const groups = new Map<string, { glAccountId: string; projectId: string | null; costCenterId: string | null; weight: number }>();
  for (const l of lines) {
    const glAccountId = l.glAccountId ?? defaultRevenueAccountId;
    const key = `${glAccountId}|${l.projectId ?? ''}|${l.costCenterId ?? ''}`;
    const g = groups.get(key) ?? { glAccountId, projectId: l.projectId, costCenterId: l.costCenterId, weight: 0 };
    g.weight += cents(l.amount);
    groups.set(key, g);
  }
  const list = [...groups.values()];
  const shares = allocateByWeight(cents(credit), list.map((g) => g.weight));
  return list
    .map((g, i) => leg(g.glAccountId, shares[i]!, 'credit', description, g.projectId, g.costCenterId))
    .filter((l): l is JournalLineInput => l !== null);
}

/**
 * One note's share of each leg (cents): pro rata to what each leg still
 * carries, then clamped to it — that caps a note larger than what is left, and
 * the rounding cent that can push a leg past it (it takes ten legs:
 * allocateByWeight hands the residual to the largest weight).
 */
export function noteShares(carries: readonly number[], total: number): number[] {
  const carried = carries.reduce((a, b) => a + b, 0);
  return (carried <= 0 ? carries.map(() => 0) : allocateByWeight(total, carries)).map((share, i) => {
    const cap = carries[i]!;
    return cap >= 0 ? Math.min(share, cap) : Math.max(share, cap);
  });
}

/**
 * The note's revenue debit, split over the invoice journal's revenue legs.
 *
 * What each leg still carries is REPLAYED, not read back from earlier notes'
 * journals: every earlier note on the invoice (`earlierNotes`, in approval
 * order) is allocated with this same rule, and its shares are taken off the
 * legs by the legs' own identity — whatever account that note actually posted
 * to (a leg deactivated, then reactivated, posts under different accounts).
 * No leg is debited past what it carries; whatever the legs cannot take goes
 * to `default_revenue`, untagged, merged with an untagged default leg the
 * invoice itself has, so an uncoded invoice posts exactly the one line it did
 * before. Lines landing on the same (account, project, cost centre) merge.
 */
export function prorateRevenueLegs(
  legs: readonly RevenueLeg[],
  amount: number,
  creditNoteNumber: string,
  defaultRevenueAccountId: string,
  earlierNotes: readonly number[] = [],
): JournalLineInput[] {
  let carries = legs.map((l) => cents(l.net));
  for (const earlier of earlierNotes) {
    const took = noteShares(carries, cents(earlier));
    carries = carries.map((c, i) => c - took[i]!);
  }
  const total = cents(amount);
  const shares = noteShares(carries, total);
  const merged = new Map<string, { account: string; projectId: string | null; costCenterId: string | null; amount: number }>();
  const add = (account: string, projectId: string | null, costCenterId: string | null, amountCents: number) => {
    const key = `${account}|${projectId ?? ''}|${costCenterId ?? ''}`;
    const m = merged.get(key) ?? { account, projectId, costCenterId, amount: 0 };
    m.amount += amountCents;
    merged.set(key, m);
  };
  legs.forEach((l, i) => add(l.postAccountId ?? l.glAccountId, l.projectId, l.costCenterId, shares[i]!));
  add(defaultRevenueAccountId, null, null, total - shares.reduce((a, b) => a + b, 0));
  const description = `Credit note ${creditNoteNumber}`;
  return [...merged.values()]
    .map((m) => leg(m.account, m.amount, 'debit', description, m.projectId, m.costCenterId))
    .filter((l): l is JournalLineInput => l !== null);
}

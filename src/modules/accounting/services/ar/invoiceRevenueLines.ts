/**
 * The revenue legs of a customer invoice journal, and of a credit note that
 * reverses one. Pure — no DB — so every allocation rule is provable against the
 * real journal validator (tests/unit/services/ar/invoiceRevenueLines.test.ts).
 *
 * INVOICE. When no line names an account, a job or a CC1 / CC2 / BU (every
 * invoice before migrations 870 and 874, and every writer that still writes
 * none) the result is the single `default_revenue` credit of the subtotal
 * posted before, byte for byte — and the line amounts are not read. Otherwise
 * the lines post what they STORE (#675: the customer's FNO is stamped on them
 * at save, so the approval digest covers it; nothing is filled here), grouped
 * by (account ?? default_revenue, job, CC1, CC2, BU), and the
 * posted amount is split across the groups by their line totals. A group that
 * nets negative (a discount on its own dimensions) posts as a debit on its own
 * leg. The VAT and AR legs are the caller's and are unchanged.
 *
 * Split BY WEIGHT, not posted as the raw line sums: the journal's amount is the
 * caller's (`credit`), the lines only decide where it goes. Today `credit` is
 * the document subtotal; a functional-currency posting passes its converted
 * figure and the split follows. The lines are still checked against the
 * DOCUMENT subtotal — a split nobody entered is refused, not posted.
 *
 * CREDIT NOTE. `prorateRevenueLegs` debits the invoice journal's own revenue
 * legs pro rata to the note, so a credit note reverses to the accounts, jobs
 * and CC1 / CC2 / BU the invoice actually credited — the journal, not
 * the lines, because an invoice posted before this change credited
 * default_revenue whatever its lines said.
 */
import type { JournalLineInput } from '../../types/gl.types';
import { hasDimensions, type DimensionIds } from '../gl/dimensions/dimensionTypes';
import { InvoiceLineCodingRefusal, isCoded, type InvoiceLineCoding } from './invoiceLineCoding';

export interface StoredRevenueLine extends InvoiceLineCoding, DimensionIds {
  amount: number;
}

/** What a revenue leg is tagged with besides its account: the job and the CC1 / CC2 / BU. */
export interface LegTags {
  projectId: string | null;
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
}

export const NO_TAGS: LegTags = { projectId: null, cc1Id: null, cc2Id: null, buId: null };

/** The line posts somewhere other than the untagged default leg. */
export const isRevenueCoded = (l: StoredRevenueLine): boolean => isCoded(l) || hasDimensions(l);

type Tagged = { projectId?: string | null; cc1Id?: string | null; cc2Id?: string | null; buId?: string | null };
const tagsOf = (l: Tagged): LegTags => ({
  projectId: l.projectId ?? null, cc1Id: l.cc1Id ?? null, cc2Id: l.cc2Id ?? null, buId: l.buId ?? null,
});
const tagKey = (account: string, t: LegTags): string => [account, t.projectId, t.cc1Id, t.cc2Id, t.buId].map((v) => v ?? '').join('|');

export interface RevenueLeg extends LegTags {
  /** The leg's identity: the account the invoice journal credited. */
  glAccountId: string;
  /** Where a note debits the leg now — default_revenue once that account is deactivated. Defaults to glAccountId. */
  postAccountId?: string;
  /** Credit minus debit the invoice journal posted to this leg. */
  net: number;
  /** Already taken by earlier notes, per their RECORDED allocations (credit_note_revenue_allocations). */
  taken?: number;
  /** The invoice journal line the leg was read from (its first); the allocation row references it. */
  journalLineId?: string;
}

/** What a note took, per invoice leg, plus what no leg could take (`isExcess`, default_revenue untagged). */
export interface CreditNoteAllocation extends LegTags {
  /** Null on the excess row only. */
  journalLineId: string | null;
  glAccountId: string;
  amount: number;
  isExcess: boolean;
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

const dims = (t: LegTags) => ({
  projectId: t.projectId ?? undefined,
  cc1Id: t.cc1Id ?? undefined,
  cc2Id: t.cc2Id ?? undefined,
  buId: t.buId ?? undefined,
});

/** A signed amount (cents) as a journal line: positive on `side`, negative on the other, zero dropped. */
function leg(
  glAccountId: string, signed: number, side: 'debit' | 'credit', description: string, tags: LegTags,
): JournalLineInput | null {
  if (signed === 0) return null;
  const onSide = signed > 0 ? side : side === 'debit' ? 'credit' : 'debit';
  const amount = rands(Math.abs(signed));
  return {
    glAccountId,
    debit: onSide === 'debit' ? amount : 0,
    credit: onSide === 'credit' ? amount : 0,
    description,
    ...dims(tags),
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
  const { invoiceNumber, documentSubtotal, credit, defaultRevenueAccountId } = input;
  const description = `Revenue: ${invoiceNumber}`;
  if (!input.lines.some(isRevenueCoded)) {
    return [{ glAccountId: defaultRevenueAccountId, debit: 0, credit, description }];
  }
  const lines = input.lines;

  const problem = revenueLinesProblem(lines, documentSubtotal);
  if (problem) throw new InvoiceLineCodingRefusal(`Invoice ${invoiceNumber}: ${problem}`);

  const groups = new Map<string, { glAccountId: string; tags: LegTags; weight: number }>();
  for (const l of lines) {
    const glAccountId = l.glAccountId ?? defaultRevenueAccountId;
    const tags = tagsOf(l);
    const key = tagKey(glAccountId, tags);
    const g = groups.get(key) ?? { glAccountId, tags, weight: 0 };
    g.weight += cents(l.amount);
    groups.set(key, g);
  }
  const list = [...groups.values()];
  const shares = allocateByWeight(cents(credit), list.map((g) => g.weight));
  return list
    .map((g, i) => leg(g.glAccountId, shares[i]!, 'credit', description, g.tags))
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
 * The note's revenue debit, split over the invoice journal's revenue legs, and
 * the allocation rows that record it.
 *
 * What each leg still carries is its net, less what earlier notes TOOK:
 *  - notes approved since migration 874 recorded it (`leg.taken`, from
 *    credit_note_revenue_allocations of live notes — a cancelled note's rows
 *    stop counting the moment it is cancelled);
 *  - notes approved before 874 recorded nothing, so their take is REPLAYED
 *    (`legacyNotes`, their amounts in approval order, allocated with this same
 *    rule) — the fallback only; they all predate any recorded note.
 * No leg is debited past what it carries; whatever the legs cannot take goes
 * to `default_revenue`, untagged, merged with an untagged default leg the
 * invoice itself has, so an uncoded invoice posts exactly the one line it did
 * before. Lines landing on the same (account, job, CC1, CC2, BU) merge.
 */
export function allocateCreditNote(
  legs: readonly RevenueLeg[],
  amount: number,
  creditNoteNumber: string,
  defaultRevenueAccountId: string,
  legacyNotes: readonly number[] = [],
): { lines: JournalLineInput[]; allocations: CreditNoteAllocation[] } {
  let carries = legs.map((l) => cents(l.net));
  for (const earlier of legacyNotes) {
    const took = noteShares(carries, cents(earlier));
    carries = carries.map((c, i) => c - took[i]!);
  }
  carries = carries.map((c, i) => {
    const left = c - cents(legs[i]!.taken ?? 0);
    return legs[i]!.net >= 0 ? Math.max(0, left) : Math.min(0, left);
  });
  const total = cents(amount);
  const shares = noteShares(carries, total);
  const excess = total - shares.reduce((a, b) => a + b, 0);
  const merged = new Map<string, { account: string; tags: LegTags; amount: number }>();
  const add = (account: string, tags: LegTags, amountCents: number) => {
    const key = tagKey(account, tags);
    const m = merged.get(key) ?? { account, tags, amount: 0 };
    m.amount += amountCents;
    merged.set(key, m);
  };
  legs.forEach((l, i) => add(l.postAccountId ?? l.glAccountId, tagsOf(l), shares[i]!));
  add(defaultRevenueAccountId, NO_TAGS, excess);
  const description = `Credit note ${creditNoteNumber}`;
  const allocations: CreditNoteAllocation[] = legs
    .map((l, i) => ({ journalLineId: l.journalLineId ?? null, glAccountId: l.glAccountId, ...tagsOf(l),
      amount: rands(shares[i]!), isExcess: false }))
    .filter((a) => a.amount !== 0);
  if (excess !== 0) {
    allocations.push({ journalLineId: null, glAccountId: defaultRevenueAccountId, ...NO_TAGS,
      amount: rands(excess), isExcess: true });
  }
  return {
    lines: [...merged.values()]
      .map((m) => leg(m.account, m.amount, 'debit', description, m.tags))
      .filter((l): l is JournalLineInput => l !== null),
    allocations,
  };
}

/** The journal lines alone (see allocateCreditNote). */
export function prorateRevenueLegs(
  legs: readonly RevenueLeg[],
  amount: number,
  creditNoteNumber: string,
  defaultRevenueAccountId: string,
  legacyNotes: readonly number[] = [],
): JournalLineInput[] {
  return allocateCreditNote(legs, amount, creditNoteNumber, defaultRevenueAccountId, legacyNotes).lines;
}

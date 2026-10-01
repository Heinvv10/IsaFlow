/**
 * Late input-VAT claims in the VAT201 box arithmetic.
 *
 * A late claim (VAT Act s16(3), gl/vatLateClaimSplit.ts) is a companion journal
 * DR VAT Input / CR "Input VAT - late claims", dated in the first open VAT
 * period after the locked one its bill was dated in. Its tax belongs in this
 * period's input boxes. Its base LEG does not exist here — the supply was
 * recorded on the original, in the locked period — and its clearing leg is not
 * a supply. But each of its VAT Input lines carries the base behind that claim
 * (`late_claim_base`, derived from the original exactly as the VAT201 derives a
 * journal's base — gl/vatLateClaimRules.lateClaimBases), and that base counts as
 * the box's base here. So a late claim faces the claim period's 15% check
 * exactly as it would have on time, under the one per-return tolerance: an
 * over-claim shows as variance, and no per-journal allowance can be stacked.
 *
 * A COMPANION is recognised by its source, `auto_vat_late_claim` — which its
 * reversal copies, with the base negated — and never by the clearing account: a
 * hand-made DR VAT Input / CR clearing journal is an ordinary, baseless journal
 * (the clearing leg is not a base, except in a journal with an output leg, which
 * is ordinary in every respect) and is flagged as one; createJournalEntry also
 * refuses the clearing account to any other source. A companion-sourced journal
 * with an OUTPUT tax leg is not a late claim either: output tax is never
 * deferred. `lateClaimTax` / `lateClaimInputTax` still report how much of the
 * tax was claimed late. A companion line with no recorded base is an entry
 * without base.
 *
 * A separate file so vatBoxBasis.ts does not grow; every other journal goes
 * through `deriveVatBoxes` after the coded-base rule (vatCodedBase). The INPUT
 * variance — and so `ties` — is the per-journal over-claim (vatInputOverclaim),
 * not the signed box total: an under-claim cannot absorb an over-claim.
 */
import {
  MAX_LISTED_ENTRIES_WITHOUT_BASE,
  RATE_CHECK_TOLERANCE,
  SA_VAT_RATE,
  classifyVatJournalLine,
  deriveVatBoxes,
  type VatBasisResult,
  type VatBoxRow,
  type VatLineInput,
} from './vatBoxBasis';
import { applyCodedBaseRule } from './vatCodedBase';
import { perJournalInputOverclaim } from './vatInputOverclaim';

/** The clearing account's subtype (migration 701). */
export const VAT_LATE_CLAIM_SUBTYPE = 'vat_input_late_claim';

/** The companion's source (and its reversal's, which copies it). */
export const VAT_LATE_CLAIM_SOURCE = 'auto_vat_late_claim';

/** A VAT201 line with its journal's source, which is what marks a late claim. */
export type LateClaimAwareLine = VatLineInput & {
  entrySource?: string | null;
  /** On a companion's VAT Input line: the base behind the claim (gl_journal_lines.late_claim_base). */
  lateClaimBase?: number | null;
  /** gl_journal_entries.reversal_of_id — the per-journal over-claim measures a reversal with its original. */
  reversalOfId?: string | null;
};

export interface LateClaimBoxRow extends VatBoxRow {
  /** Tax in this box claimed late (already inside `tax`). */
  lateClaimTax: number;
}

export interface VatBasisWithLateClaims extends VatBasisResult {
  boxes: LateClaimBoxRow[];
  /** Input tax claimed late in this period, across every box. */
  lateClaimInputTax: number;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function deriveVatBoxesWithLateClaims(lines: readonly LateClaimAwareLine[]): VatBasisWithLateClaims {
  const lateEntries = new Set(
    lines.filter((l) => l.entrySource === VAT_LATE_CLAIM_SOURCE).map((l) => l.journalEntryId),
  );
  // A journal with an output tax leg is ORDINARY in every respect (output tax is
  // never deferred): not a late claim, and its clearing leg is not stripped.
  const outputEntries = new Set<string>();
  for (const l of lines) {
    const c = classifyVatJournalLine(l);
    if (c.role === 'tax' && c.direction === 'output') outputEntries.add(l.journalEntryId);
  }
  for (const id of outputEntries) lateEntries.delete(id);
  // Otherwise the clearing leg is never the value of a supply: outside a
  // companion it is left out, so a hand-made DR VAT Input / CR clearing journal
  // has no base.
  // The coded-base rule (vatCodedBase) decides which base lines the tax is on.
  const ordinary = applyCodedBaseRule(lines.filter((l) => !lateEntries.has(l.journalEntryId)
    && (l.accountSubtype !== VAT_LATE_CLAIM_SUBTYPE || outputEntries.has(l.journalEntryId))));
  const basis = deriveVatBoxes(ordinary);
  const rows = new Map<string, LateClaimBoxRow>(
    basis.boxes.map((b) => [`${b.direction}:${b.vatType}`, { ...b, lateClaimTax: 0 }]),
  );

  // A companion's tax legs land in their boxes WITH the base behind each claim
  // (late_claim_base), so the claim period's 15% check sees a late claim exactly
  // as it would have seen it on time. A leg with no recorded base is a journal
  // without base, as a baseless on-time journal is.
  let taxLegCount = basis.taxLegCount;
  const lateWithoutBase = new Set<string>();
  for (const line of lines) {
    if (!lateEntries.has(line.journalEntryId)) continue;
    const c = classifyVatJournalLine(line);
    if (c.role !== 'tax' || !c.direction) continue;
    taxLegCount++;
    const vatType = c.vatType ?? 'standard';
    const key = `${c.direction}:${vatType}`;
    const row = rows.get(key)
      ?? { direction: c.direction, vatType, base: 0, tax: 0, impliedTax: 0, variance: 0, lateClaimTax: 0 };
    row.tax = r2(row.tax + c.amount);
    row.lateClaimTax = r2(row.lateClaimTax + c.amount);
    if (line.lateClaimBase == null) lateWithoutBase.add(line.journalEntryId);
    else row.base = r2(row.base + line.lateClaimBase);
    rows.set(key, row);
  }

  const boxes = [...rows.values()].map((b) => {
    const impliedTax = r2(b.base * SA_VAT_RATE);
    return { ...b, impliedTax, variance: r2(b.tax - impliedTax) };
  }).sort((a, b) =>
    (a.direction === b.direction ? a.vatType.localeCompare(b.vatType) : a.direction < b.direction ? -1 : 1));
  const sum = (d: 'input' | 'output', f: (b: LateClaimBoxRow) => number) =>
    r2(boxes.filter((b) => b.direction === d).reduce((s, b) => s + f(b), 0));
  const outputBase = sum('output', (b) => b.base);
  const inputBase = sum('input', (b) => b.base);
  const outputTax = sum('output', (b) => b.tax);
  const inputTax = sum('input', (b) => b.tax);
  const outputImpliedTax = r2(outputBase * SA_VAT_RATE);
  const inputImpliedTax = r2(inputBase * SA_VAT_RATE);
  const outputVariance = r2(outputTax - outputImpliedTax);
  // Per journal, over-claims only (vatInputOverclaim): an under-claim on one
  // bill no longer absorbs an over-claim on another. The boxes keep their
  // signed per-box variance; this is the figure `ties` and filing gate on.
  const inputVariance = perJournalInputOverclaim(
    ordinary, lines.filter((l) => lateEntries.has(l.journalEntryId)), SA_VAT_RATE,
  );
  const entriesWithoutBaseTotal = basis.entriesWithoutBaseTotal + lateWithoutBase.size;

  return {
    ...basis,
    boxes,
    outputBase, outputTax, outputImpliedTax, outputVariance,
    inputBase, inputTax, inputImpliedTax, inputVariance,
    ties: entriesWithoutBaseTotal === 0
      && Math.abs(outputVariance) <= RATE_CHECK_TOLERANCE && Math.abs(inputVariance) <= RATE_CHECK_TOLERANCE,
    entriesWithoutBase: [...basis.entriesWithoutBase, ...lateWithoutBase].slice(0, MAX_LISTED_ENTRIES_WITHOUT_BASE),
    entriesWithoutBaseTotal,
    taxLegCount,
    lateClaimInputTax: sum('input', (b) => b.lateClaimTax),
  };
}

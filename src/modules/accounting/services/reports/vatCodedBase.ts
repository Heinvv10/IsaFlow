/**
 * The coded-base rule for the VAT201's 15% check on INPUT tax.
 *
 * `deriveVatBoxes` takes a journal's base as every line that is neither tax
 * nor settlement, whatever its VAT code. On an ordinary bill that is right:
 * its expense lines carry no code, and an untaxed item beside a taxed one
 * legitimately puts the tax under 15% of the whole. But a journal whose base
 * lines DO carry codes says which of them the tax is on — and there a large
 * uncoded or zero-rated/exempt line inflates the base, turning the journal
 * into an under-claim that silently absorbs an over-claim elsewhere.
 *
 * So: in a journal with an input tax leg and NO output leg, once any base
 * line carries a TAXED code, the base is the taxed-coded lines only; uncoded
 * lines and lines coded zero_rated / export / exempt / no_vat are dropped.
 * A journal with an output leg is left alone — the output side's nil-rated
 * handling (vat201NilRatedSupplies) already gives those lines back to fields
 * 2 and 3, and applying this there would count them twice.
 *
 * One rule, used by the VAT201 basis (vatLateClaimBasis), the late-claim base
 * a companion carries (gl/vatLateClaimRules.lateClaimBases) and the late-claim
 * qualification (qualifiesForLateClaim), so the three cannot disagree.
 */
import { classifyVatJournalLine, type VatLineInput } from './vatBoxBasis';

/** Codes that put a supply in a box at nil tax: not part of the base the 15% check is run on. */
export const UNTAXED_VAT_CODES: readonly string[] = ['zero_rated', 'export', 'exempt', 'no_vat'];

/** A code that carries tax (standard, capital_goods, imported, …). NULL is uncoded, not taxed. */
export function isTaxedVatCode(vatType: string | null): boolean {
  return vatType !== null && !UNTAXED_VAT_CODES.includes(vatType);
}

interface EntryFacts {
  input: boolean;
  output: boolean;
  taxedBase: boolean;
}

/** The lines with the coded-base rule applied, journal by journal. Order is kept. */
export function applyCodedBaseRule<T extends VatLineInput>(lines: readonly T[]): T[] {
  const roles = lines.map((l) => classifyVatJournalLine(l));
  const facts = new Map<string, EntryFacts>();
  lines.forEach((l, i) => {
    const c = roles[i]!;
    const f = facts.get(l.journalEntryId) ?? { input: false, output: false, taxedBase: false };
    if (c.role === 'tax' && c.direction === 'input') f.input = true;
    if (c.role === 'tax' && c.direction === 'output') f.output = true;
    if (c.role === 'base' && isTaxedVatCode(l.vatType)) f.taxedBase = true;
    facts.set(l.journalEntryId, f);
  });
  return lines.filter((l, i) => {
    const f = facts.get(l.journalEntryId)!;
    if (!f.input || f.output || !f.taxedBase) return true;
    return roles[i]!.role !== 'base' || isTaxedVatCode(l.vatType);
  });
}

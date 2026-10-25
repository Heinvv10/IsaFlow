/** Has the ledger moved since the reviewed VAT201 draft was saved? Pure; used by the eFiling submit gate. */
import type { LedgerVAT201 } from './vat201LedgerFields';
import type { Vat201SarsField } from './vat201SarsFields';

/** The eleven statutory figures. Everything else on the form is drill-down. */
const VAT201_FIELDS = [
  'field1_standardRatedSupplies', 'field2_zeroRatedSupplies', 'field3_exemptSupplies',
  'field4_totalImports', 'field5_outputVAT', 'field6_capitalGoods', 'field7_otherGoods',
  'field8_services', 'field9_imports', 'field10_totalInputVAT', 'field11_vatPayableOrRefundable',
] as const;

export const DRAFT_NO_FIGURES_REASON = 'this draft holds no saved VAT201 figures to compare against';
export const DRAFT_PREDATES_REASON = 'draft predates SARS field mapping';

/**
 * Which of the reviewed draft's figures the regenerated return no longer
 * matches. A draft saved before `form_data` carried the fields (or with none of
 * them) cannot be compared, and is reported as such rather than passed.
 *
 * The SARS form is compared too. A reclassification can move tax between SARS
 * boxes (1, 1A and 12; 15, 17 and 18; 2 and 2A) and leave every legacy total
 * unchanged, and the reviewer approved the boxes. A draft that does not hold
 * the SARS form was never reviewed that way, so it counts as drift (re-save
 * it), never as a pass.
 */
export function draftDrift(
  saved: Record<string, unknown> | null,
  regenerated: LedgerVAT201 & { sarsFields?: Vat201SarsField[] },
): string[] {
  if (!saved || VAT201_FIELDS.every((f) => saved[f] === undefined)) {
    return [DRAFT_NO_FIGURES_REASON];
  }
  const drift: string[] = [];
  for (const field of VAT201_FIELDS) {
    const before = Number(saved[field] ?? 0);
    const after = Number(regenerated[field] ?? 0);
    if (Math.abs(before - after) >= 0.005) {
      drift.push(`${field} ${before.toFixed(2)} -> ${after.toFixed(2)}`);
    }
  }
  if (regenerated.sarsFields && !Array.isArray(saved.sarsFields)) {
    // Approved before the SARS form existed: its boxes were never reviewed, so a
    // reclassification between them could pass unseen. Re-save to re-review.
    drift.push(DRAFT_PREDATES_REASON);
  }
  if (Array.isArray(saved.sarsFields) && regenerated.sarsFields) {
    const before = new Map((saved.sarsFields as Vat201SarsField[]).map((f) => [f.field, f.amount]));
    for (const f of regenerated.sarsFields) {
      const was = before.has(f.field) ? before.get(f.field)! : undefined;
      const same = was === undefined ? false : was === null || f.amount === null
        ? was === f.amount
        : Math.abs(was - f.amount) < 0.005;
      if (!same) {
        const fmt = (n: number | null | undefined) => (n == null ? 'none' : n.toFixed(2));
        drift.push(`SARS field ${f.field} ${fmt(was)} -> ${fmt(f.amount)}`);
      }
    }
  }
  return drift;
}

/**
 * The refusal text for a non-empty drift. "The ledger has moved" is only true of a figure that moved; a draft
 * that cannot be compared says so in its own words.
 */
export function draftBlockReason(drift: string[]): string {
  const uncomparable = drift.filter((d) => d === DRAFT_NO_FIGURES_REASON || d === DRAFT_PREDATES_REASON);
  if (uncomparable.length > 0) {
    return `This ${uncomparable[0] === DRAFT_PREDATES_REASON ? 'draft predates SARS field mapping' : 'draft holds no saved VAT201 figures to compare against'} — re-save the draft and review it before filing`;
  }
  return `The ledger has moved since this draft was saved (${drift.join('; ')}) — re-save the draft and review it before filing`;
}

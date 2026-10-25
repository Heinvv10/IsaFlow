/**
 * The VAT201 page's return: the ledger fields (`getLedgerVAT201`) PLUS the SARS
 * form (`vat201SarsFields`), its review warnings and whether the return is
 * filable, all built from ONE read of the period so they cannot disagree.
 *
 * `sarsFields`, `warnings` and `filability` are deliberately NOT part of
 * `getLedgerVAT201`: that object is spread into the ISV payload and compared
 * field by field against saved drafts. They ARE saved in a draft's `form_data`
 * (the route saves this object), so `draftDrift` can tell that a
 * reclassification moved a SARS box.
 */
import {
  assembleLedger, evaluateVat201Filability, loadLedgerSources, type LedgerVAT201,
} from './vat201LedgerFields';
import {
  buildVat201SarsFields, buildVat201Warnings, type Vat201FormWarning, type Vat201SarsField,
} from './vat201SarsFields';

export interface Vat201Return extends LedgerVAT201 {
  sarsFields: Vat201SarsField[];
  warnings: Vat201FormWarning[];
  filability: { filable: boolean; reason: string | null };
}

export async function getVat201Return(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<Vat201Return> {
  const sources = await loadLedgerSources(companyId, periodStart, periodEnd);
  const ledger = assembleLedger(periodStart, periodEnd, sources);
  const sarsFields = buildVat201SarsFields(sources.report, sources.nilRated);
  return {
    ...ledger,
    sarsFields,
    warnings: buildVat201Warnings(sarsFields, sources.nilRated),
    filability: evaluateVat201Filability(ledger),
  };
}

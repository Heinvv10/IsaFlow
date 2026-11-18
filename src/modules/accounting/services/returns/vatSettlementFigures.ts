/**
 * Which figures a VAT settlement may be posted from (wave 6 VR, coordinator ruling on review round 1, M3).
 *
 *   drift       the version against the VAT201 report regenerated now (driftOf's basis: getVat201Report's totals).
 *               Output, input or net more than 1c apart: 409 VAT_SETTLEMENT_DRIFT. Never overridable: the return no
 *               longer says what the ledger says, so amend it and finalise again.
 *   ledger gap  the VAT control-account movement the settlement clears (getVATReturn) against that report. Net more
 *               than 1c apart (a document cancelled with its journal still posted, for one): 409
 *               VAT_SETTLEMENT_LEDGER_GAP naming both figures. Re-finalising cannot close it, so an owner or admin may
 *               settle anyway with a written reason (acknowledgeLedgerGap); the reason and both figures are kept on
 *               the settlement row. Login-as never reaches here (submitVATReturn refuses it first).
 *
 * The settlement still posts the ledger figures, so the control accounts clear.
 */
import { getVat201Report } from '../reports/vat201ReportService';
import { assertMayActOnReturns, visibleText } from './returnGuards';
import { ReturnRefusal } from './returnVersionTypes';
import type { VatFiguresAt } from './vatSettlementVersion';

export interface LedgerGapAck { reason: string; role: string }
export interface AcknowledgedLedgerGap { ledgerNetVat: number; reportNetVat: number; reason: string }

const cents = (n: number): number => Math.round(n * 100) / 100;
const apart = (a: number, b: number): boolean => Math.abs(cents(a - b)) > 0.01;

/** Refuses drift, and a ledger gap unless acknowledged; returns the acknowledged gap to record, or null for none. */
export async function checkSettlementFigures(
  companyId: string, periodStart: string, periodEnd: string,
  version: VatFiguresAt & { versionNo: number }, ledgerNetVat: number, ack?: LedgerGapAck,
): Promise<AcknowledgedLedgerGap | null> {
  const report = (await getVat201Report(companyId, periodStart, periodEnd, { detail: 'summary' })).totals;
  if (apart(report.outputTax, version.outputTax) || apart(report.inputTax, version.inputTax)
    || apart(report.netVat, version.netVat)) {
    throw new ReturnRefusal(409,
      `VAT201 version ${version.versionNo} (net VAT ${cents(version.netVat)}) no longer matches the VAT201 for `
      + `${periodStart} to ${periodEnd} (net VAT ${cents(report.netVat)}): the ledger changed after it was finalised. `
      + 'Amend the return and finalise it again, then settle.',
      'VAT_SETTLEMENT_DRIFT', { versionNetVat: cents(version.netVat), reportNetVat: cents(report.netVat) });
  }
  if (!apart(ledgerNetVat, report.netVat)) return null;
  const figures = { ledgerNetVat: cents(ledgerNetVat), reportNetVat: cents(report.netVat) };
  if (!ack) {
    throw new ReturnRefusal(409,
      `The VAT control accounts move net VAT ${figures.ledgerNetVat} for ${periodStart} to ${periodEnd}, but the `
      + `VAT201 says ${figures.reportNetVat}. Find the difference first, or settle anyway (owner or admin) and give `
      + 'the reason; the settlement clears the control accounts.', 'VAT_SETTLEMENT_LEDGER_GAP', figures);
  }
  assertMayActOnReturns(ack.role, 'acknowledge a ledger gap on');
  return { ...figures, reason: visibleText(ack.reason, 'The reason for the ledger gap') };
}

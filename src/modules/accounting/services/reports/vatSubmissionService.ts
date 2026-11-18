/**
 * VAT Submission Service
 *
 * Closes out a VAT period by:
 *   1. Computing the period's output/input tax via getVATReturn.
 *   2. Posting a clearing journal entry that zeroes accounts 1140 (VAT Input)
 *      and 2120 (VAT Output) and parks the net balance in:
 *        - 2130 Accrued Expenses (liability) when net VAT is PAYABLE to SARS
 *          (totalOutputTax > totalInputTax — the normal SA vendor situation).
 *        - 2130 Accrued Expenses (debit, i.e. reduces liability) when a net
 *          REFUND is due from SARS. If the chart has a dedicated receivable, swap
 *          this to 'receivable'; Accrued Expenses is used because no dedicated
 *          "VAT Payable / VAT Receivable" system account exists in the default
 *          IsaFlow chart of accounts.
 *   3. Writing a vat_returns row for idempotency and audit, linked to the VAT201 version it settles
 *      (return_version_id). A period without a finalised or filed version is refused first (409).
 *
 * Clearing-journal DATE (V-05):
 *   The clearing entry is dated the FIRST DAY OF THE FOLLOWING PERIOD, never
 *   periodEnd. `getVATReturn` derives the period's output/input tax from the
 *   MOVEMENT on the vat_output / vat_input control accounts between periodStart
 *   and periodEnd; an entry dated periodEnd falls inside that window and reverses
 *   the very movement it settles. Dating it to periodEnd + 1 day puts the
 *   settlement outside the period being reported, which is also when the
 *   liability to SARS crystallises.
 *
 * Balance formula (payable case):
 *   DR 2120 VAT Output  totalOutputTax
 *   CR 1140 VAT Input   totalInputTax
 *   CR 2130 Accrued Exp netVat              (netVat = totalOutputTax - totalInputTax)
 *   -- DR = CR: totalOutputTax = totalInputTax + netVat  ✓
 *
 * Refund case (totalInputTax > totalOutputTax):
 *   DR 2120 VAT Output  totalOutputTax
 *   DR 2130 Accrued Exp netVat              (netVat = totalInputTax - totalOutputTax, positive)
 *   CR 1140 VAT Input   totalInputTax
 *   -- DR = CR: totalOutputTax + netVat = totalInputTax  ✓
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getVATReturn } from './vatReturnService';
import { createJournalEntry, postJournalEntry, resolveUserUuid } from '../gl/journalEntryService';
import { getSystemAccount } from '../gl/systemAccountResolver';
import type { JournalLineInput } from '../../types/gl.types';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { assertClearingDateHasFiscalPeriod, nextDayISO, resolveNetVatAccount } from './vatSubmissionSupport';
import { mapRow, type VATReturnRecord, type VATSubmitInput } from './vatReturnsList';
import { settlementBasis } from '../returns/vatSettlementVersion';
import { checkSettlementFigures } from '../returns/vatSettlementFigures';
import { ReturnRefusal } from '../returns/returnVersionTypes';

const cents = (n: number): number => Math.round(n * 100) / 100;

/**
 * The settlement row's INSERT. Two settlements of one version racing past settlementBasis both post a journal; the
 * second INSERT then hits uq_vat_returns_period_settlement. That is "already settled" (409), not a raw database error,
 * and the route's savepoint rolls back the loser's journal with it (round 2 L1).
 */
async function insertSettlementRow(insert: () => Promise<unknown>, periodStart: string, periodEnd: string): Promise<Row[]> {
  try {
    return (await insert()) as Row[];
  } catch (err) {
    const e = err as { code?: unknown; constraint?: unknown };
    if (e.code === '23505' && e.constraint === 'uq_vat_returns_period_settlement') {
      throw new ReturnRefusal(409, `VAT return for ${periodStart}–${periodEnd} has just been settled by another request.`,
        'VAT_ALREADY_SETTLED');
    }
    throw err;
  }
}

export { nextDayISO } from './vatSubmissionSupport';
export { listVATReturns, type ListVATReturnsOptions, type VATReturnRecord, type VATSubmitInput } from './vatReturnsList';

type Row = DbRow;

// ── submitVATReturn ───────────────────────────────────────────────────────────

/**
 * Settle a VAT period against its live VAT201 version (wave 6 VR). Refuses (409) a period with no finalised or filed
 * version, a released lock, an overlapping settlement or a ledger that has drifted from the version; throws when the
 * version is already settled. After an amend it posts only the difference (a top-up linked to the new version).
 */
export async function submitVATReturn(
  companyId: string,
  input: VATSubmitInput,
  userId: string,
): Promise<VATReturnRecord> {
  await assertNotImpersonating(); // R-032 L5: first, before any read or write
  const { periodStart, periodEnd, sarsReference } = input;

  // Resolved up front: an unparseable periodEnd must refuse BEFORE any write,
  // not after the journal is posted.
  const clearingDate = nextDayISO(periodEnd);

  // 0. The lifecycle is the record of the VAT201 (§0a.12): the live version for exactly this period, row-locked, its
  //    VAT lock active; no overlapping settlement; and what the period already settled. Reads only, before any write.
  const basis = await settlementBasis(companyId, periodStart, periodEnd);
  if (basis.versionSettled) {
    throw new ReturnRefusal(409,
      `VAT return for ${periodStart}–${periodEnd} has already been submitted against version ${basis.version.versionNo}.`,
      'VAT_ALREADY_SETTLED');
  }

  // 1. The control accounts' movement for the period (what the settlement clears). The version must still match the
  //    VAT201 regenerated now (drift: never overridable), and the ledger must match that VAT201 unless an owner or
  //    admin acknowledges the gap with a reason (vatSettlementFigures).
  const ledger = await getVATReturn(companyId, periodStart, periodEnd);
  const ledgerNet = cents(ledger.totalOutputTax - ledger.totalInputTax);
  const gap = await checkSettlementFigures(companyId, periodStart, periodEnd, basis.version, ledgerNet,
    input.acknowledgeLedgerGap);

  // 2. Post only what the period has not settled yet: the whole return the first time, the difference after an amend
  //    (a top-up linked to the new version). An amend that moved no tax figure leaves nothing to post: a NIL top-up
  //    row still records that vN was settled (no journal, zero figures), so the period reads as submitted (round 2 M).
  const totalOutputTax = cents(ledger.totalOutputTax - basis.prior.outputTax);
  const totalInputTax = cents(ledger.totalInputTax - basis.prior.inputTax);
  const netVat = cents(totalOutputTax - totalInputTax); // positive = payable, negative = refund
  const topUp = basis.prior.count > 0;

  log.info('VAT return figures', { companyId, periodStart, periodEnd, totalOutputTax, totalInputTax, netVat }, 'accounting');

  // 3. Resolve system accounts
  const [vatOutputAcc, vatInputAcc, accruedAcc, safeUserId] = await Promise.all([
    getSystemAccount('vat_output', companyId),
    getSystemAccount('vat_input',  companyId),
    resolveNetVatAccount(companyId),   // 2130 Accrued Expenses (falls back to 2110 payable)
    resolveUserUuid(userId),
  ]);

  // 4. Build journal lines — skip any zero-amount line. A nil VAT201 (no
  // output, no input) produces no lines and we record the submission without
  // posting a journal. Use abs > 0.005 so credit notes inside the period
  // (which can flip an output/input total negative) still create a line on
  // the appropriate side.
  //    Payable:  DR vatOutput / CR vatInput / CR accruedExp (net)
  //    Refund:   DR vatOutput / DR accruedExp (net abs) / CR vatInput
  const lines: JournalLineInput[] = [];

  if (Math.abs(totalOutputTax) > 0.005) {
    // Net DR 2120 VAT Output — closes the liability accumulated during the
    // period. Negative output (credit notes > new sales) flips to a CR.
    lines.push({
      glAccountId: vatOutputAcc.id,
      debit:       totalOutputTax > 0 ? totalOutputTax : 0,
      credit:      totalOutputTax < 0 ? Math.abs(totalOutputTax) : 0,
      description: `VAT return submission ${periodStart} to ${periodEnd} — output tax`,
    });
  }

  if (Math.abs(totalInputTax) > 0.005) {
    // Net CR 1140 VAT Input — closes the asset accumulated during the
    // period. Negative input (return-to-supplier > new claims) flips to a DR.
    lines.push({
      glAccountId: vatInputAcc.id,
      debit:       totalInputTax < 0 ? Math.abs(totalInputTax) : 0,
      credit:      totalInputTax > 0 ? totalInputTax : 0,
      description: `VAT return submission ${periodStart} to ${periodEnd} — input tax`,
    });
  }

  if (Math.abs(netVat) > 0.001) {
    if (netVat > 0) {
      // Net payable to SARS: CR Accrued Expenses
      lines.push({
        glAccountId: accruedAcc.id,
        debit:       0,
        credit:      netVat,
        description: `VAT payable to SARS — ${sarsReference ?? periodEnd}`,
      });
    } else {
      // Net refund from SARS: DR Accrued Expenses (reduces liability / parks receivable)
      lines.push({
        glAccountId: accruedAcc.id,
        debit:       Math.abs(netVat),
        credit:      0,
        description: `VAT refund due from SARS — ${sarsReference ?? periodEnd}`,
      });
    }
  }

  // 5. Create and post the journal entry — skip entirely for a nil return
  let journalEntryId: string | null = null;
  if (lines.length > 0) {
    // Before the first write of the whole flow. A nil return posts no journal,
    // so it cannot go invisible and is not refused.
    await assertClearingDateHasFiscalPeriod(companyId, clearingDate);

    const je = await createJournalEntry(companyId, {
      // First day of the FOLLOWING period — see the V-05 note in the file header.
      entryDate:   clearingDate,
      description: `VAT201 submission ${periodStart} to ${periodEnd}${topUp ? ` (top-up for v${basis.version.versionNo})` : ''}`,
      source:      'auto_vat_submission',
      lines,
    }, safeUserId);

    await postJournalEntry(companyId, je.id, safeUserId);
    journalEntryId = je.id;

    log.info('VAT submission journal posted', { journalEntryId }, 'accounting');
  } else {
    log.info('Nil VAT201 submission — no journal posted', { companyId, periodStart, periodEnd }, 'accounting');
  }

  // 6. Insert vat_returns record
  const absNetVat = netVat; // signed: positive = payable, negative = refund
  const rows = await insertSettlementRow(() => sql`
    INSERT INTO vat_returns (
      company_id, period_start, period_end, status,
      total_output_tax, total_input_tax, net_vat,
      sars_reference, submitted_by, journal_entry_id,
      ledger_gap_ledger_net, ledger_gap_report_net, ledger_gap_reason, return_version_id
    ) VALUES (
      ${companyId}::UUID,
      ${periodStart}::DATE,
      ${periodEnd}::DATE,
      'submitted',
      ${totalOutputTax},
      ${totalInputTax},
      ${absNetVat},
      ${sarsReference ?? null},
      ${userId}, -- TEXT since 999w (HYb): the real user id, not resolveUserUuid's stand-in
      ${journalEntryId}::UUID,
      ${gap?.ledgerNetVat ?? null}, ${gap?.reportNetVat ?? null}, ${gap?.reason ?? null},
      ${basis.version.id}::UUID
    )
    RETURNING *
  `, periodStart, periodEnd);

  const record = mapRow(rows[0]!);
  log.info('VAT return record created', { id: record.id, netVat }, 'accounting');
  return record;
}

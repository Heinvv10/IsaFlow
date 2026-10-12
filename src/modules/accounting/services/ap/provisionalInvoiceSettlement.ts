/**
 * R-127: a bank-first provisional journal BECOMES the payment of the supplier
 * invoice raised from the slip that evidences it.
 *
 * THE DOUBLE BOOKING. `postProvisional` expenses an outgoing bank line before
 * any document exists (DR expense / DR VAT input, CR bank). When the slip
 * arrives, `attachEvidenceToProvisional` stamps it on that journal as
 * evidence — and the capture routes ALSO raise a supplier invoice from the same
 * slip. Approving that invoice posts DR expense / DR VAT, CR AP. Nothing
 * connected the two: the bill was expensed twice, its VAT claimed twice, and
 * the payable it raised sat open against a bank line that had already paid it.
 *
 * THE TREATMENT (Hein's decision). The invoice posts its normal journal. In the
 * same transaction the provisional's non-bank lines are reclassed to the
 * invoice's AP control account (DR AP, CR each expense/VAT line the provisional
 * debited), and a `supplier_payments` row carrying that journal, tied to the
 * bank line, is applied to the invoice through the ordinary application service
 * — so `amount_paid` and status move with the GL, not just the GL. Net: the
 * invoice's expense and VAT once, AP nil, the bank credited once (the
 * provisional's own line, untouched).
 *
 * AMOUNTS THAT DIFFER. The WHOLE provisional is always reclassed and the
 * payment is for the whole bank amount; only the APPLICATION is capped, at the
 * invoice's outstanding balance. Invoice above the bank line: the rest stays
 * open on the bill. Bank line above the invoice: the excess stays unapplied on
 * the payment, a debit on AP. Either way GL and subledger agree to the cent and
 * the difference sits on a named document where the AP reports show it.
 *
 * DATES. The reclass and the payment are dated with the invoice's journal, so
 * the pair nets inside one period and never posts into the provisional's
 * (possibly already filed) period; the input VAT stays claimed where the
 * provisional claimed it.
 *
 * THE CLAIM, and every refusal, is `provisionalSettlementClaim.ts`, run before
 * the approval's first write. Both callers run inside a savepoint that takes the
 * invoice's own posting down with any failure here (review HIGH: the routes answer
 * a throw 4xx, and withAuth COMMITs a 4xx).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import { resolveUserUuid } from '../gl/journalEntryCrudService';
import { buildReversalLines } from '../gl/reversalLines';
import { actorMeta, type PostingActorOpts } from '../gl/journalEntryMeta';
import type { SupplierInvoice } from '../../types/ap.types';
import { round2 } from './supplierAllocationLines';
import { applySupplierPaymentPlan, planSupplierPaymentApplication } from './supplierPaymentApplicationService';
import type { ProvisionalClaim } from './provisionalSettlementClaim';
import { withApprovalGateExemptBankFeed } from '../gl/approvalGateExempt';

export { claimEvidencedProvisional, type ProvisionalClaim } from './provisionalSettlementClaim';

export interface ProvisionalSettlement {
  provisionalJournalId: string;
  reclassJournalId: string;
  supplierPaymentId: string;
  applied: number;
  unapplied: number;
}

/**
 * Reclass the claimed provisional into the invoice's payment. Runs after the
 * invoice's journal has posted and the invoice is in an allocatable status.
 */
export async function settleInvoiceFromProvisional(
  companyId: string,
  params: {
    invoice: SupplierInvoice;
    /** The payable account the invoice's own journal credited. */
    apAccountId: string;
    claim: ProvisionalClaim;
    userId: string;
    opts?: PostingActorOpts;
  },
): Promise<ProvisionalSettlement> {
  const { invoice, apAccountId, claim, userId } = params;

  const reclass = await buildReversalLines(companyId, claim.settleLines);
  const lines = [
    {
      glAccountId: apAccountId,
      debit: claim.bankAmount,
      credit: 0,
      description: `AP: ${invoice.invoiceNumber} paid by provisional ${claim.entryNumber}`,
    },
    ...reclass.lines.map((l) => ({ ...l, description: `Settled by ${invoice.invoiceNumber}: ${l.description?.replace(/^Reversal: /, '') ?? ''}` })),
  ];
  const journal = await createJournalEntry(companyId, {
    entryDate: claim.reclassDate,
    description: `Provisional ${claim.entryNumber} becomes payment of supplier invoice ${invoice.invoiceNumber}`,
    source: 'auto_supplier_payment',
    lines,
  }, userId, actorMeta(params.opts), {
    // The lines are the provisional's, carried forward as a reversal carries them:
    // an account or cost centre retired since it posted must not refuse the reclass.
    dimensionAssignmentMode: 'historical-copy',
    // Those carried lines are contras of the provisional's; the AP leg is still judged (headerAccountGuard.ts).
    contraAccountIds: reclass.lines.map((l) => l.glAccountId).filter((id) => id !== apAccountId),
  });
  await postJournalEntry(companyId, journal.id, userId);

  const createdBy = await resolveUserUuid(userId);
  const description = `Bank-first payment of ${invoice.invoiceNumber} (provisional ${claim.entryNumber})`;
  // R-035 PR5 (Q4, D2): exempt from the payment backstop only when the line is bank evidence — the wrapper checks.
  const [payment] = (await withApprovalGateExemptBankFeed(companyId, claim.bankTxId, () => sql`
    INSERT INTO supplier_payments (
      company_id, supplier_id, payment_date, total_amount, payment_method, bank_account_id,
      reference, description, status, gl_journal_entry_id, settles_provisional_je_id,
      created_by, approved_by, approved_at, processed_at
    ) VALUES (
      ${companyId}::UUID, ${invoice.supplierId}::UUID, ${claim.reclassDate}, ${claim.bankAmount}, 'eft',
      ${claim.bankAccountId}::UUID, ${claim.bankTxId}, ${description}, 'processed', ${journal.id}::UUID,
      ${claim.journalEntryId}::UUID, ${createdBy}::UUID, ${createdBy}::UUID, NOW(), NOW()
    )
    RETURNING id
  `)) as DbRow[];
  const paymentId = String(payment!.id);

  const applied = round2(Math.min(claim.bankAmount, invoice.totalAmount - invoice.amountPaid));
  if (applied > 0) {
    const plan = await planSupplierPaymentApplication(companyId, paymentId, [{ invoiceId: invoice.id, amount: applied }]);
    await applySupplierPaymentPlan(companyId, plan, userId);
  }

  const settlement = {
    provisionalJournalId: claim.journalEntryId,
    reclassJournalId: journal.id,
    supplierPaymentId: paymentId,
    applied: Math.max(applied, 0),
    unapplied: round2(claim.bankAmount - Math.max(applied, 0)),
  };
  log.info('Provisional journal settled supplier invoice', { invoiceId: invoice.id, ...settlement }, 'accounting');
  return settlement;
}

/**
 * The one-line hook both posting paths (`approveSupplierInvoice`,
 * `postSupplierInvoiceToGL`) call once their journal is posted and linked, with
 * the payable account that journal credited:
 * settle against the provisional they claimed, if any, and return the invoice
 * row as it now stands (null when there was nothing to settle).
 */
export async function settleClaimedProvisional(
  companyId: string,
  claim: ProvisionalClaim | null,
  invoice: SupplierInvoice,
  apAccountId: string,
  userId: string,
  opts?: PostingActorOpts,
): Promise<DbRow | null> {
  if (!claim) return null;
  await settleInvoiceFromProvisional(companyId, { invoice, apAccountId, claim, userId, opts });
  const [row] = (await sql`
    SELECT * FROM supplier_invoices WHERE id = ${invoice.id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  return row ?? null;
}

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
 * THE CLAIM. `claimEvidencedProvisional` locks the provisional (bounded wait)
 * BEFORE any write of the approval and only then reads whether a live payment
 * already consumed it; the partial unique index on
 * `supplier_payments.settles_provisional_je_id` (migration 718) backs that.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, getJournalEntryById, postJournalEntry } from '../gl/journalEntryService';
import { resolveUserUuid } from '../gl/journalEntryCrudService';
import { buildReversalLines } from '../gl/reversalLines';
import { actorMeta, type PostingActorOpts } from '../gl/journalEntryMeta';
import type { JournalLine } from '../../types/gl.types';
import type { SupplierInvoice } from '../../types/ap.types';
import { withSupplierInvoiceLock } from './supplierInvoiceLock';
import { round2 } from './supplierAllocationLines';
import { applySupplierPaymentPlan, planSupplierPaymentApplication } from './supplierPaymentApplicationService';

const CENT = 0.005;

export interface ProvisionalClaim {
  journalEntryId: string;
  entryNumber: string;
  bankTxId: string;
  /** bank_transactions.bank_account_id — a gl_accounts id. */
  bankAccountId: string;
  /** The absolute bank outflow the provisional credited. */
  bankAmount: number;
  /** The provisional's expense / VAT lines — everything but its bank line. */
  settleLines: JournalLine[];
}

export interface ProvisionalSettlement {
  provisionalJournalId: string;
  reclassJournalId: string;
  supplierPaymentId: string;
  applied: number;
  unapplied: number;
}

/**
 * The evidenced provisional behind this invoice's source document, LOCKED, or
 * null when there is none this invoice may use. Call before the approval's
 * first write. Throws only for a qualifying provisional whose lines do not add
 * up to its bank line — posting the invoice beside it would double-book, and
 * reclassing it would be a guess.
 */
export async function claimEvidencedProvisional(
  companyId: string,
  invoiceId: string,
): Promise<ProvisionalClaim | null> {
  const [inv] = (await sql`
    SELECT source_document_id FROM supplier_invoices
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  const documentId = inv?.source_document_id ? String(inv.source_document_id) : null;
  if (!documentId) return null;

  // Locked before anything is decided on it; two approvals of two invoices from
  // one slip serialise here, and the loser reads the winner's payment below.
  const candidates = (await withSupplierInvoiceLock('claimEvidencedProvisional', invoiceId, () => sql`
    SELECT je.id AS je_id, je.entry_number, bt.id AS bt_id, bt.bank_account_id, bt.amount
    FROM gl_journal_entries je
    JOIN bank_transactions bt ON bt.provisional_je_id = je.id AND bt.company_id = je.company_id
    WHERE je.company_id = ${companyId}::UUID
      AND je.source_document_id = ${documentId}::UUID
      AND je.status = 'posted'
      AND je.reversed_at IS NULL
      AND je.needs_evidence = false
    ORDER BY je.id
    FOR UPDATE OF je
  `)) as DbRow[];

  for (const c of candidates) {
    const jeId = String(c.je_id);
    const taken = (await sql`
      SELECT 1 FROM supplier_payments
      WHERE company_id = ${companyId}::UUID AND settles_provisional_je_id = ${jeId}::UUID
        AND status <> 'cancelled'
    `) as DbRow[];
    if (taken.length > 0) continue;

    const entry = await getJournalEntryById(companyId, jeId);
    if (!entry) throw new Error(`Provisional journal ${jeId} not found in company ${companyId}`);
    const bankAccountId = String(c.bank_account_id);
    const bankAmount = round2(Math.abs(Number(c.amount)));
    const bankLines = entry.lines.filter((l) => l.glAccountId === bankAccountId);
    const settleLines = entry.lines.filter((l) => l.glAccountId !== bankAccountId);
    const bankCredit = round2(bankLines.reduce((s, l) => s + l.credit - l.debit, 0));
    const settleDebit = round2(settleLines.reduce((s, l) => s + l.debit - l.credit, 0));
    if (Math.abs(bankCredit - bankAmount) > CENT || Math.abs(settleDebit - bankAmount) > CENT) {
      throw new Error(
        `Provisional journal ${String(c.entry_number)} is evidenced by this invoice's document, but its lines `
        + `(bank R${bankCredit.toFixed(2)}, other R${settleDebit.toFixed(2)}) do not match its bank line of `
        + `R${bankAmount.toFixed(2)}. Approving would book the bill twice; correct or reverse the provisional first.`,
      );
    }
    return {
      journalEntryId: jeId,
      entryNumber: String(c.entry_number),
      bankTxId: String(c.bt_id),
      bankAccountId,
      bankAmount,
      settleLines,
    };
  }
  return null;
}

/**
 * Reclass the claimed provisional into the invoice's payment. Runs after the
 * invoice's journal has posted and the invoice is in an allocatable status.
 */
export async function settleInvoiceFromProvisional(
  companyId: string,
  params: {
    invoice: SupplierInvoice;
    invoiceJournalId: string;
    claim: ProvisionalClaim;
    userId: string;
    opts?: PostingActorOpts;
  },
): Promise<ProvisionalSettlement> {
  const { invoice, invoiceJournalId, claim, userId } = params;

  // The invoice's supplier control account is the one its own journal credited.
  const apRows = (await sql`
    SELECT DISTINCT gl_account_id FROM gl_journal_lines
    WHERE journal_entry_id = ${invoiceJournalId}::UUID AND company_id = ${companyId}::UUID AND credit > 0
  `) as DbRow[];
  if (apRows.length !== 1) {
    throw new Error(`Supplier invoice ${invoice.invoiceNumber}: its journal does not credit exactly one payable account`);
  }
  const apAccountId = String(apRows[0]!.gl_account_id);

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
    entryDate: invoice.invoiceDate,
    description: `Provisional ${claim.entryNumber} becomes payment of supplier invoice ${invoice.invoiceNumber}`,
    source: 'auto_supplier_payment',
    lines,
  }, userId, actorMeta(params.opts));
  await postJournalEntry(companyId, journal.id, userId);

  const createdBy = await resolveUserUuid(userId);
  const description = `Bank-first payment of ${invoice.invoiceNumber} (provisional ${claim.entryNumber})`;
  const [payment] = (await sql`
    INSERT INTO supplier_payments (
      company_id, supplier_id, payment_date, total_amount, payment_method, bank_account_id,
      reference, description, status, gl_journal_entry_id, settles_provisional_je_id,
      created_by, approved_by, approved_at, processed_at
    ) VALUES (
      ${companyId}::UUID, ${invoice.supplierId}::UUID, ${invoice.invoiceDate}, ${claim.bankAmount}, 'eft',
      ${claim.bankAccountId}::UUID, ${claim.bankTxId}, ${description}, 'processed', ${journal.id}::UUID,
      ${claim.journalEntryId}::UUID, ${createdBy}::UUID, ${createdBy}::UUID, NOW(), NOW()
    )
    RETURNING id
  `) as DbRow[];
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

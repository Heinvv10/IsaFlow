/**
 * Dispute resolution — resolve (with or without credit) and withdraw.
 * Split out of disputeService.ts to keep both files under the 300-line limit.
 */

import { sql, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import {
  mapRow,
  type Dispute,
  type DisputeStatus,
  type ResolveDisputeInput,
} from './disputeTypes';

export async function resolveDispute(
  companyId: string,
  id: string,
  userId: string,
  input: ResolveDisputeInput,
): Promise<Dispute> {
  if (input.mode === 'resolve_with_credit' && !input.creditDate) {
    throw new Error('creditDate is required when resolving with credit');
  }

  const newStatus: DisputeStatus = input.mode === 'rejected' ? 'rejected' : 'resolved';

  // Claim the dispute with a status-predicated UPDATE BEFORE raising any
  // financial document. Reading the status and then updating on id alone let
  // two concurrent resolves (the UI racing an MCP call) both see 'open', both
  // call createCreditNote for the same disputed amount, and the second UPDATE
  // overwrite credit_note_id — leaving one credit note orphaned and invisible
  // from the dispute. The loser's UPDATE now matches no row and it throws
  // before any credit note exists.
  const claimed = (await sql`
    UPDATE customer_invoice_disputes
    SET status = ${newStatus},
        resolution_mode = ${input.mode},
        resolution_note = ${input.note ?? null},
        resolved_at = NOW(),
        resolved_by = ${userId}
    WHERE id = ${id}::uuid
      AND company_id = ${companyId}::uuid
      AND status = 'open'
    RETURNING *
  `) as DbRow[];

  if (!claimed[0]) {
    const current = (await sql`
      SELECT status FROM customer_invoice_disputes
      WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
      LIMIT 1
    `) as DbRow[];
    if (!current[0]) {
      throw new Error(`Dispute ${id} not found`);
    }
    throw new Error(`Dispute ${id} is not open (current status: ${current[0].status})`);
  }

  const dispute = claimed[0];
  let creditNoteId: string | null = null;

  if (input.mode === 'resolve_with_credit') {
    const invoiceRows = (await sql`
      SELECT COALESCE(client_id, customer_id) AS client_id, subtotal, tax_amount
      FROM customer_invoices
      WHERE id = ${dispute.customer_invoice_id}::uuid
        AND company_id = ${companyId}::uuid
      LIMIT 1
    `) as DbRow[];

    const clientId = invoiceRows[0]?.client_id != null ? String(invoiceRows[0].client_id) : null;
    if (!clientId) {
      throw new Error('Cannot auto-create credit note: invoice has no client');
    }

    // disputed_amount is a slice of the invoice TOTAL, which is VAT-inclusive.
    // createCreditNote takes a VAT-EXCLUSIVE subtotal and derives tax from
    // taxRate, so passing the gross amount with taxRate 0 booked the whole
    // amount to revenue and nothing to the VAT control account. Derive the
    // invoice's own effective rate and split the disputed amount back out.
    const invoiceSubtotal = Number(invoiceRows[0]?.subtotal ?? 0);
    const invoiceTax = Number(invoiceRows[0]?.tax_amount ?? 0);
    const taxRate =
      invoiceSubtotal > 0 ? Math.round((invoiceTax / invoiceSubtotal) * 10000) / 100 : 0;
    const grossDisputed = Number(dispute.disputed_amount);
    const creditSubtotal = Math.round((grossDisputed / (1 + taxRate / 100)) * 100) / 100;
    // Pass the remainder as the tax rather than letting createCreditNote
    // re-derive it from the rate: rounding both halves independently can leave
    // subtotal + tax a cent away from the disputed amount (10.00 at 15% splits
    // to 8.70 + 1.31 = 10.01), which would relieve the debtor by the wrong
    // figure. No split of a 2-decimal gross at 15% is exact, so the cent goes
    // to VAT and the total is right by construction.
    const creditTax = Math.round((grossDisputed - creditSubtotal) * 100) / 100;

    const cn = await createCreditNote(
      companyId,
      {
        type: 'customer',
        clientId,
        customerInvoiceId: String(dispute.customer_invoice_id),
        creditDate: input.creditDate!,
        reason: `Dispute resolution: ${dispute.reason ?? ''}`.slice(0, 500),
        subtotal: creditSubtotal,
        taxRate,
        taxAmount: creditTax,
      },
      userId,
    );
    creditNoteId = String(cn.id);

    const linked = (await sql`
      UPDATE customer_invoice_disputes
      SET credit_note_id = ${creditNoteId}
      WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
      RETURNING *
    `) as DbRow[];
    if (linked[0]) {
      Object.assign(dispute, linked[0]);
    }
  }

  log.info(
    'Dispute resolved',
    { disputeId: id, mode: input.mode, creditNoteId, userId },
    'dispute',
  );

  return mapRow(dispute);
}

export async function withdrawDispute(
  companyId: string,
  id: string,
  userId: string,
  note?: string,
): Promise<Dispute> {
  const existing = (await sql`
    SELECT status FROM customer_invoice_disputes
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
    LIMIT 1
  `) as DbRow[];

  if (!existing[0]) {
    throw new Error(`Dispute ${id} not found`);
  }
  if (String(existing[0].status) !== 'open') {
    throw new Error(`Dispute ${id} is not open (current status: ${existing[0].status})`);
  }

  const rows = (await sql`
    UPDATE customer_invoice_disputes
    SET status = 'withdrawn',
        resolution_mode = 'withdrawn',
        resolution_note = ${note ?? null},
        resolved_at = NOW(),
        resolved_by = ${userId}
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
    RETURNING *
  `) as DbRow[];

  return mapRow(rows[0]!);
}


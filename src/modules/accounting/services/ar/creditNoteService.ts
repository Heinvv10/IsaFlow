/**
 * PRD-060: FibreFlow Accounting Module — Phase 3
 * Credit Note Service (Customer & Supplier) — reads and draft creation.
 *
 * The write paths (approve / cancel / apply) live in creditNoteWriteService.ts
 * and are re-exported here, so `@/modules/accounting/services/ar/creditNoteService`
 * remains the single import surface every caller and test mock already uses.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { CreditNote, CreditNoteCreateInput, CreditNoteStatus } from '../../types/ar.types';
import { validateCreditNoteLinks } from './creditNoteLinkService';
import { mapRow } from './creditNoteMapper';

export { approveCreditNote } from './creditNoteApproveService';
export { cancelCreditNote, applyCreditNoteToInvoice } from './creditNoteCancelService';

interface CreditNoteFilters {
  type?: 'customer' | 'supplier';
  status?: CreditNoteStatus;
  limit?: number;
  offset?: number;
}

export async function getCreditNotes(companyId: string, filters?: CreditNoteFilters): Promise<{
  creditNotes: CreditNote[];
  total: number;
}> {
  try {
    const limit = Math.min(filters?.limit || 50, 200);
    const offset = filters?.offset || 0;
    let rows: Record<string, unknown>[];
    let countRows: Record<string, unknown>[];

    if (filters?.type) {
      rows = (await sql`
        SELECT cn.*, c.name AS client_name, COALESCE(s.company_name, s.name) AS supplier_name,
          COALESCE(ci.invoice_number, si.invoice_number) AS invoice_number
        FROM credit_notes cn
        LEFT JOIN customers c ON c.id = cn.client_id AND c.company_id = cn.company_id
        LEFT JOIN suppliers s ON s.id = cn.supplier_id AND s.company_id = cn.company_id
        LEFT JOIN customer_invoices ci ON ci.id = cn.customer_invoice_id AND ci.company_id = cn.company_id
        LEFT JOIN supplier_invoices si ON si.id = cn.supplier_invoice_id AND si.company_id = cn.company_id
        WHERE cn.company_id = ${companyId} AND cn.type = ${filters.type}
        ORDER BY cn.credit_date DESC, cn.created_at DESC, cn.id LIMIT ${limit} OFFSET ${offset}
      `) as Record<string, unknown>[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM credit_notes WHERE company_id = ${companyId} AND type = ${filters.type}
      `) as Record<string, unknown>[];
    } else {
      rows = (await sql`
        SELECT cn.*, c.name AS client_name, COALESCE(s.company_name, s.name) AS supplier_name,
          COALESCE(ci.invoice_number, si.invoice_number) AS invoice_number
        FROM credit_notes cn
        LEFT JOIN customers c ON c.id = cn.client_id AND c.company_id = cn.company_id
        LEFT JOIN suppliers s ON s.id = cn.supplier_id AND s.company_id = cn.company_id
        LEFT JOIN customer_invoices ci ON ci.id = cn.customer_invoice_id AND ci.company_id = cn.company_id
        LEFT JOIN supplier_invoices si ON si.id = cn.supplier_invoice_id AND si.company_id = cn.company_id
        WHERE cn.company_id = ${companyId}
        ORDER BY cn.credit_date DESC, cn.created_at DESC, cn.id LIMIT ${limit} OFFSET ${offset}
      `) as Record<string, unknown>[];
      countRows = (await sql`SELECT COUNT(*) AS cnt FROM credit_notes WHERE company_id = ${companyId}`) as Record<string, unknown>[];
    }

    return { creditNotes: rows.map(mapRow), total: Number(countRows[0]!.cnt) };
  } catch (err) {
    log.error('Failed to get credit notes', { error: err }, 'accounting');
    throw err;
  }
}

export async function getCreditNoteById(companyId: string, id: string): Promise<CreditNote | null> {
  const rows = (await sql`
    SELECT cn.*, c.name AS client_name, COALESCE(s.company_name, s.name) AS supplier_name,
      COALESCE(ci.invoice_number, si.invoice_number) AS invoice_number
    FROM credit_notes cn
    LEFT JOIN customers c ON c.id = cn.client_id AND c.company_id = cn.company_id
    LEFT JOIN suppliers s ON s.id = cn.supplier_id AND s.company_id = cn.company_id
    LEFT JOIN customer_invoices ci ON ci.id = cn.customer_invoice_id AND ci.company_id = cn.company_id
    LEFT JOIN supplier_invoices si ON si.id = cn.supplier_invoice_id AND si.company_id = cn.company_id
    WHERE cn.id = ${id}::UUID AND cn.company_id = ${companyId}
  `) as Record<string, unknown>[];
  return rows.length > 0 ? mapRow(rows[0]!) : null;
}

export async function createCreditNote(companyId: string, 
  input: CreditNoteCreateInput,
  userId: string
): Promise<CreditNote> {
  try {
    // The tenant + counterparty fence lives HERE, not in a caller. None of
    // client_id / supplier_id / customer_invoice_id / supplier_invoice_id
    // carries an (id, company_id) constraint and nothing below re-reads them,
    // so a caller-supplied UUID from another company would otherwise become a
    // cross-tenant document — and approve auto-applies a linked note, paying
    // down the wrong counterparty's invoice. The REST route passes its request
    // body straight through, so a check in the MCP tool alone left that route
    // open. (The tool still pre-checks, to answer with a specific message
    // before any write rather than a generic failure.)
    const linkError = await validateCreditNoteLinks(companyId, input);
    if (linkError) throw new Error(linkError);

    const taxRate = input.taxRate ?? 15;
    const taxAmount = Math.round(input.subtotal * taxRate / 100 * 100) / 100;
    const totalAmount = input.subtotal + taxAmount;

    // supplier_id is a UUID column (migration 202) referencing suppliers(id),
    // NOT an integer. The previous `Number(input.supplierId)` turned every real
    // supplier UUID into NaN, which Postgres rejects with `invalid input syntax
    // for type uuid: "NaN"` — so creating a supplier credit note against an
    // actual supplier threw, and the only supplier notes that ever reached the
    // table were seed rows carrying supplier_id NULL. Pass the UUID through.
    const rows = (await sql`
      INSERT INTO credit_notes (
        company_id,
        type, client_id, customer_invoice_id, supplier_id, supplier_invoice_id,
        credit_date, reason, subtotal, tax_rate, tax_amount, total_amount,
        project_id, created_by
      ) VALUES (
        ${companyId}::UUID,
        ${input.type}, ${input.clientId || null}, ${input.customerInvoiceId || null},
        ${input.supplierId || null},
        ${input.supplierInvoiceId || null},
        ${input.creditDate}, ${input.reason || null},
        ${input.subtotal}, ${taxRate}, ${taxAmount}, ${totalAmount},
        ${input.projectId || null}, ${userId}::UUID
      ) RETURNING *
    `) as Record<string, unknown>[];

    log.info('Created credit note', { id: String(rows[0]!.id), type: input.type }, 'accounting');
    return mapRow(rows[0]!);
  } catch (err) {
    log.error('Failed to create credit note', { error: err }, 'accounting');
    throw err;
  }
}

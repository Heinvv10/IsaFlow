/**
 * Customer Write-Off Service
 * Phase 1 Sage Alignment: Bad debt write-offs with GL posting
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import { getSystemAccount } from '../gl/systemAccountResolver';
import { assertCustomerInCompany } from '../core/contactDirectoryService';
import { claimUnderLockTimeout } from '../core/documentClaimLock';
import type { CustomerWriteOff, WriteOffCreateInput } from '../../types/ar.types';
import type { JournalLineInput } from '../../types/gl.types';

type Row = DbRow;

export async function getWriteOffs(companyId: string, filters?: {
  status?: string;
  clientId?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: CustomerWriteOff[]; total: number }> {
  const limit = filters?.limit || 50;
  const offset = filters?.offset || 0;
  let rows: Row[];
  let countRows: Row[];

  if (filters?.clientId) {
    rows = (await sql`
      SELECT wo.*, c.name AS client_name, ci.invoice_number
      FROM customer_write_offs wo
      LEFT JOIN customers c ON c.id = wo.client_id
      LEFT JOIN customer_invoices ci ON ci.id = wo.invoice_id
      WHERE wo.company_id = ${companyId} AND wo.client_id = ${filters.clientId}::UUID
      ORDER BY wo.created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`
      SELECT COUNT(*) AS cnt FROM customer_write_offs
      WHERE company_id = ${companyId} AND client_id = ${filters.clientId}::UUID
    `) as Row[];
  } else if (filters?.status) {
    rows = (await sql`
      SELECT wo.*, c.name AS client_name, ci.invoice_number
      FROM customer_write_offs wo
      LEFT JOIN customers c ON c.id = wo.client_id
      LEFT JOIN customer_invoices ci ON ci.id = wo.invoice_id
      WHERE wo.company_id = ${companyId} AND wo.status = ${filters.status}
      ORDER BY wo.created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`
      SELECT COUNT(*) AS cnt FROM customer_write_offs
      WHERE company_id = ${companyId} AND status = ${filters.status}
    `) as Row[];
  } else {
    rows = (await sql`
      SELECT wo.*, c.name AS client_name, ci.invoice_number
      FROM customer_write_offs wo
      LEFT JOIN customers c ON c.id = wo.client_id
      LEFT JOIN customer_invoices ci ON ci.id = wo.invoice_id
      WHERE wo.company_id = ${companyId}
      ORDER BY wo.created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`SELECT COUNT(*) AS cnt FROM customer_write_offs WHERE company_id = ${companyId}`) as Row[];
  }

  return { items: rows.map(mapRow), total: Number(countRows[0]?.cnt || 0) };
}

export async function createWriteOff(companyId: string, 
  input: WriteOffCreateInput,
  userId: string
): Promise<CustomerWriteOff> {
  // R-067: only the invoice was read company-scoped; client_id went into the
  // write-off untouched, and every list query joins customers on it.
  await assertCustomerInCompany(companyId, input.clientId);
  // Validate amount against invoice balance
  const invRows = (await sql`
    SELECT total_amount, amount_paid FROM customer_invoices
    WHERE id = ${input.invoiceId}::UUID AND company_id = ${companyId}
  `) as Row[];
  if (!invRows[0]) throw new Error('Invoice not found');
  const balance = Number(invRows[0].total_amount) - Number(invRows[0].amount_paid);
  if (input.amount > balance + 0.01) {
    throw new Error(`Write-off amount R${input.amount.toFixed(2)} exceeds invoice balance R${balance.toFixed(2)}`);
  }

  const rows = (await sql`
    INSERT INTO customer_write_offs (
      company_id, client_id, invoice_id, amount, reason, write_off_date, created_by
    ) VALUES (
      ${companyId}, ${input.clientId}::UUID, ${input.invoiceId}::UUID, ${input.amount},
      ${input.reason}, ${input.writeOffDate || new Date().toISOString().split('T')[0]},
      ${userId}::UUID
    ) RETURNING *
  `) as Row[];

  log.info('Created write-off', { id: rows[0]?.id, amount: input.amount }, 'accounting');
  return mapRow(rows[0]!);
}

/**
 * Raised when the write-off is not 'draft' when the claim runs — because it
 * never was, or because a concurrent request has already approved it. Raised
 * BEFORE the journal is created, so a route may answer it with a 4xx without
 * `withAuth` committing a half-approved write-off.
 */
export class WriteOffNotApprovableError extends Error {
  readonly code = 'WRITE_OFF_NOT_APPROVABLE';
  constructor(readonly writeOffStatus: string) {
    super(`Write-off is ${writeOffStatus}, not draft — it cannot be approved.`);
    this.name = 'WriteOffNotApprovableError';
  }
}

export async function approveWriteOff(companyId: string, id: string, userId: string): Promise<CustomerWriteOff> {
  const woRows = (await sql`
    SELECT wo.*, ci.invoice_number FROM customer_write_offs wo
    LEFT JOIN customer_invoices ci ON ci.id = wo.invoice_id
    WHERE wo.id = ${id} AND wo.company_id = ${companyId}
  `) as Row[];
  if (!woRows[0]) throw new Error('Write-off not found');

  // CLAIM before anything is posted. What this replaced read
  // `woRows[0].status !== 'draft'` and then posted DR Bad Debt / CR AR (plus
  // the §22(3) VAT recovery) and added the write-off amount to the invoice's
  // `amount_paid`, with the write-off's own row rewritten unconditionally: two
  // concurrent approvals credited AR twice and marked the invoice paid against
  // money that was written off once. The status-predicated UPDATE is the guard.
  const claimed = await claimUnderLockTimeout('write-off', async () => (await sql`
    UPDATE customer_write_offs
    SET status = 'approved', approved_by = ${userId}::UUID, approved_at = NOW()
    WHERE id = ${id} AND company_id = ${companyId} AND status = 'draft'
    RETURNING id
  `) as Row[]);
  if (claimed.length === 0) {
    const now = (await sql`
      SELECT status FROM customer_write_offs WHERE id = ${id} AND company_id = ${companyId}
    `) as Row[];
    throw new WriteOffNotApprovableError(now[0] ? String(now[0].status) : 'missing');
  }

  const wo = woRows[0];
  const amount = Number(wo.amount);

  // Fetch invoice VAT details for SA VAT Act §22(3) bad debt VAT recovery
  const invVatRows = (await sql`
    SELECT total_amount, tax_amount FROM customer_invoices
    WHERE id = ${wo.invoice_id}::UUID AND company_id = ${companyId}
  `) as Row[];
  const invTotal = Number(invVatRows[0]?.total_amount || 0);
  const invTaxAmount = Number(invVatRows[0]?.tax_amount || 0);
  const vatRecoverable = invTotal > 0 && invTaxAmount > 0
    ? Math.round((amount / invTotal) * invTaxAmount * 100) / 100
    : 0;

  // GL: DR Bad Debts Expense, CR Accounts Receivable
  const [expenseAccount, arAccount] = await Promise.all([
    getSystemAccount('admin_expense', companyId),
    getSystemAccount('receivable', companyId),
  ]);

  // Net bad debt expense is the pre-VAT portion only; VAT is recovered separately
  const netWriteOff = Math.round((amount - vatRecoverable) * 100) / 100;
  const lines: JournalLineInput[] = [
    { glAccountId: expenseAccount.id, debit: netWriteOff, credit: 0,
      description: `Bad debt write-off: ${wo.invoice_number}` },
    { glAccountId: arAccount.id, debit: 0, credit: amount,
      description: `Write-off AR: ${wo.invoice_number}` },
  ];

  // VAT Act §22(3): recover output VAT on written-off debt
  if (vatRecoverable > 0) {
    const outputVatAccount = await getSystemAccount('vat_output', companyId);
    lines.push({
      glAccountId: outputVatAccount.id, debit: vatRecoverable, credit: 0,
      description: `VAT recovery on bad debt: ${wo.invoice_number}`,
      vatType: 'bad_debt',
    });
  }

  // No sourceDocumentId: gl_journal_entries.source_document_id has an FK to
  // captured_documents(id) only (migration 409); a write-off's own id would
  // violate it. The write-off <-> journal entry link is instead persisted
  // below via customer_write_offs.gl_journal_entry_id.
  const je = await createJournalEntry(companyId, {
    entryDate: fmtDate(wo.write_off_date),
    description: `Write-off ${wo.write_off_number} — ${wo.invoice_number}`,
    source: 'auto_write_off',
    lines,
  }, userId);
  await postJournalEntry(companyId, je.id, userId);

  await sql`
    UPDATE customer_invoices
    SET amount_paid = amount_paid + ${amount},
        status = CASE WHEN (total_amount - amount_paid - ${amount}) <= 0.01 THEN 'paid' ELSE status END
    WHERE id = ${wo.invoice_id}::UUID AND company_id = ${companyId}
  `;

  // Only the journal link is left to write — the status, approver and timestamp
  // were set by the claim above.
  const updated = (await sql`
    UPDATE customer_write_offs
    SET gl_journal_entry_id = ${je.id}::UUID
    WHERE id = ${id} AND company_id = ${companyId} RETURNING *
  `) as Row[];

  log.info('Approved write-off', { id, journalEntryId: je.id }, 'accounting');
  return mapRow(updated[0]!);
}

export async function cancelWriteOff(companyId: string, id: string): Promise<void> {
  const result = (await sql`UPDATE customer_write_offs SET status = 'cancelled' WHERE id = ${id} AND company_id = ${companyId} AND status = 'draft' RETURNING id`) as Row[];
  if (result.length === 0) throw new Error(`Write-off not found or not in draft status: ${id}`);
}

function mapRow(row: Row): CustomerWriteOff {
  return {
    id: String(row.id),
    writeOffNumber: row.write_off_number ? String(row.write_off_number) : '',
    clientId: String(row.client_id),
    invoiceId: String(row.invoice_id),
    amount: Number(row.amount),
    reason: String(row.reason),
    writeOffDate: fmtDate(row.write_off_date),
    status: String(row.status) as CustomerWriteOff['status'],
    glJournalEntryId: row.gl_journal_entry_id ? String(row.gl_journal_entry_id) : undefined,
    approvedBy: row.approved_by ? String(row.approved_by) : undefined,
    approvedAt: row.approved_at ? String(row.approved_at) : undefined,
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    clientName: row.client_name ? String(row.client_name) : undefined,
    invoiceNumber: row.invoice_number ? String(row.invoice_number) : undefined,
  };
}

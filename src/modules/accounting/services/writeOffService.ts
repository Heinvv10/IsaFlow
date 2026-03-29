/**
 * Customer Write-Off Service
 * Phase 1 Sage Alignment: Bad debt write-offs with GL posting
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from './journalEntryService';
import { getAccountByCode } from './chartOfAccountsService';
import type { CustomerWriteOff, WriteOffCreateInput } from '../types/ar.types';
import type { JournalLineInput } from '../types/gl.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

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
      SELECT wo.*, c.company_name AS client_name, ci.invoice_number
      FROM customer_write_offs wo
      LEFT JOIN clients c ON c.id = wo.client_id
      LEFT JOIN customer_invoices ci ON ci.id = wo.invoice_id
      WHERE wo.client_id = ${filters.clientId}::UUID
      ORDER BY wo.created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`
      SELECT COUNT(*) AS cnt FROM customer_write_offs WHERE client_id = ${filters.clientId}::UUID
    `) as Row[];
  } else if (filters?.status) {
    rows = (await sql`
      SELECT wo.*, c.company_name AS client_name, ci.invoice_number
      FROM customer_write_offs wo
      LEFT JOIN clients c ON c.id = wo.client_id
      LEFT JOIN customer_invoices ci ON ci.id = wo.invoice_id
      WHERE wo.status = ${filters.status}
      ORDER BY wo.created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`
      SELECT COUNT(*) AS cnt FROM customer_write_offs WHERE status = ${filters.status}
    `) as Row[];
  } else {
    rows = (await sql`
      SELECT wo.*, c.company_name AS client_name, ci.invoice_number
      FROM customer_write_offs wo
      LEFT JOIN clients c ON c.id = wo.client_id
      LEFT JOIN customer_invoices ci ON ci.id = wo.invoice_id
      ORDER BY wo.created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`SELECT COUNT(*) AS cnt FROM customer_write_offs`) as Row[];
  }

  return { items: rows.map(mapRow), total: Number(countRows[0]?.cnt || 0) };
}

export async function createWriteOff(companyId: string, 
  input: WriteOffCreateInput,
  userId: string
): Promise<CustomerWriteOff> {
  // Validate amount against invoice balance
  const invRows = (await sql`
    SELECT total_amount, amount_paid FROM customer_invoices WHERE id = ${input.invoiceId}::UUID
  `) as Row[];
  if (!invRows[0]) throw new Error('Invoice not found');
  const balance = Number(invRows[0].total_amount) - Number(invRows[0].amount_paid);
  if (input.amount > balance + 0.01) {
    throw new Error(`Write-off amount R${input.amount.toFixed(2)} exceeds invoice balance R${balance.toFixed(2)}`);
  }

  const rows = (await sql`
    INSERT INTO customer_write_offs (
      client_id, invoice_id, amount, reason, write_off_date, created_by
    ) VALUES (
      ${input.clientId}::UUID, ${input.invoiceId}::UUID, ${input.amount},
      ${input.reason}, ${input.writeOffDate || new Date().toISOString().split('T')[0]},
      ${userId}::UUID
    ) RETURNING *
  `) as Row[];

  log.info('Created write-off', { id: rows[0]?.id, amount: input.amount }, 'accounting');
  return mapRow(rows[0]!);
}

export async function approveWriteOff(companyId: string, id: string, userId: string): Promise<CustomerWriteOff> {
  const woRows = (await sql`
    SELECT wo.*, ci.invoice_number FROM customer_write_offs wo
    LEFT JOIN customer_invoices ci ON ci.id = wo.invoice_id
    WHERE wo.id = ${id}
  `) as Row[];
  if (!woRows[0]) throw new Error('Write-off not found');
  if (woRows[0].status !== 'draft') throw new Error('Write-off is not in draft status');

  const wo = woRows[0];
  const amount = Number(wo.amount);

  // GL: DR Bad Debts Expense (5600), CR Accounts Receivable (1120)
  const expenseAccount = await getAccountByCode('5600');
  const arAccount = await getAccountByCode('1120');
  if (!expenseAccount || !arAccount) throw new Error('Required GL accounts not found');

  const lines: JournalLineInput[] = [
    { glAccountId: expenseAccount.id, debit: amount, credit: 0,
      description: `Bad debt write-off: ${wo.invoice_number}` },
    { glAccountId: arAccount.id, debit: 0, credit: amount,
      description: `Write-off AR: ${wo.invoice_number}` },
  ];

  const je = await createJournalEntry('', {
    entryDate: String(wo.write_off_date),
    description: `Write-off ${wo.write_off_number} — ${wo.invoice_number}`,
    source: 'auto_write_off',
    sourceDocumentId: id,
    lines,
  }, userId);
  await postJournalEntry('', je.id, userId);

  // Update invoice balance
  await sql`
    UPDATE customer_invoices
    SET amount_paid = amount_paid + ${amount},
        status = CASE WHEN (total_amount - amount_paid - ${amount}) <= 0.01 THEN 'paid' ELSE status END
    WHERE id = ${wo.invoice_id}::UUID
  `;

  const updated = (await sql`
    UPDATE customer_write_offs
    SET status = 'approved', approved_by = ${userId}::UUID, approved_at = NOW(),
        gl_journal_entry_id = ${je.id}::UUID
    WHERE id = ${id} RETURNING *
  `) as Row[];

  log.info('Approved write-off', { id, journalEntryId: je.id }, 'accounting');
  return mapRow(updated[0]!);
}

export async function cancelWriteOff(companyId: string, id: string): Promise<void> {
  await sql`UPDATE customer_write_offs SET status = 'cancelled' WHERE id = ${id} AND status = 'draft'`;
}

function mapRow(row: Row): CustomerWriteOff {
  return {
    id: String(row.id),
    writeOffNumber: row.write_off_number ? String(row.write_off_number) : '',
    clientId: String(row.client_id),
    invoiceId: String(row.invoice_id),
    amount: Number(row.amount),
    reason: String(row.reason),
    writeOffDate: String(row.write_off_date),
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

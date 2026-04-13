/**
 * Company Settings Service
 * Document numbers, messages, and per-company configuration.
 * Extracted from companyService.ts for file-size compliance.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// ── Document Numbers ──────────────────────────────────────────────────────────

export interface DocumentNumber {
  id: string;
  companyId: string;
  documentType: string;
  prefix: string;
  nextNumber: number;
  padding: number;
}

const DEFAULT_DOC_NUMBERS: { type: string; prefix: string }[] = [
  { type: 'quotation', prefix: 'QUO' },
  { type: 'sales_order', prefix: 'SO' },
  { type: 'customer_invoice', prefix: 'INV' },
  { type: 'credit_note', prefix: 'CRN' },
  { type: 'customer_receipt', prefix: 'RCP' },
  { type: 'customer_write_off', prefix: 'WRI' },
  { type: 'recurring_invoice', prefix: 'RINV' },
  { type: 'customer_adjustment', prefix: 'CADJ' },
  { type: 'purchase_order', prefix: 'PO' },
  { type: 'supplier_invoice', prefix: 'SIV' },
  { type: 'supplier_return', prefix: 'RTN' },
  { type: 'supplier_payment', prefix: 'PAY' },
  { type: 'supplier_adjustment', prefix: 'SADJ' },
  { type: 'delivery_note', prefix: 'DN' },
];

export async function getDocumentNumbers(companyId: string): Promise<DocumentNumber[]> {
  const rows = (await sql`
    SELECT * FROM company_document_numbers WHERE company_id = ${companyId}::UUID ORDER BY document_type
  `) as Record<string, unknown>[];
  return rows.map((r: Record<string, unknown>) => ({
    id: String(r.id), companyId: String(r.company_id), documentType: String(r.document_type),
    prefix: String(r.prefix), nextNumber: Number(r.next_number), padding: Number(r.padding),
  }));
}

export async function ensureDocumentNumbers(companyId: string): Promise<DocumentNumber[]> {
  for (const d of DEFAULT_DOC_NUMBERS) {
    await sql`
      INSERT INTO company_document_numbers (company_id, document_type, prefix, next_number, padding)
      VALUES (${companyId}::UUID, ${d.type}, ${d.prefix}, 1, 7)
      ON CONFLICT (company_id, document_type) DO NOTHING
    `;
  }
  return getDocumentNumbers(companyId);
}

export async function updateDocumentNumber(
  companyId: string,
  documentType: string,
  prefix: string,
  nextNumber?: number,
): Promise<void> {
  if (nextNumber !== undefined) {
    await sql`
      UPDATE company_document_numbers SET prefix = ${prefix}, next_number = ${nextNumber}
      WHERE company_id = ${companyId}::UUID AND document_type = ${documentType}
    `;
  } else {
    await sql`
      UPDATE company_document_numbers SET prefix = ${prefix}
      WHERE company_id = ${companyId}::UUID AND document_type = ${documentType}
    `;
  }
}

// ── Company Messages ──────────────────────────────────────────────────────────

export interface CompanyMessage {
  messageType: string;
  message: string;
}

export async function getCompanyMessages(companyId: string): Promise<CompanyMessage[]> {
  const rows = (await sql`
    SELECT message_type, message FROM company_messages WHERE company_id = ${companyId}::UUID ORDER BY message_type
  `) as Record<string, unknown>[];
  return rows.map((r: Record<string, unknown>) => ({
    messageType: String(r.message_type ?? ''),
    message: String(r.message ?? ''),
  }));
}

export async function upsertCompanyMessage(
  companyId: string,
  messageType: string,
  message: string,
): Promise<void> {
  await sql`
    INSERT INTO company_messages (company_id, message_type, message)
    VALUES (${companyId}::UUID, ${messageType}, ${message})
    ON CONFLICT (company_id, message_type) DO UPDATE SET message = ${message}, updated_at = NOW()
  `;
  log.info('Upserted company message', { companyId, messageType }, 'accounting');
}

export async function upsertCompanyMessages(
  companyId: string,
  messages: CompanyMessage[],
): Promise<void> {
  for (const m of messages) {
    await upsertCompanyMessage(companyId, m.messageType, m.message);
  }
}

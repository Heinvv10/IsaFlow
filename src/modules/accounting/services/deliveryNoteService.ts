/**
 * Delivery Note Service — CRUD with line items
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

export interface DeliveryNoteLine {
  id: string;
  deliveryNoteId: string;
  description: string;
  quantity: number;
  unit: string | null;
  itemId: string | null;
}

export interface DeliveryNote {
  id: string;
  deliveryNoteNumber: string;
  customerId: string;
  customerName: string;
  salesOrderId: string | null;
  invoiceId: string | null;
  deliveryDate: string;
  status: string;
  deliveryAddress: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lineCount?: number;
  lines?: DeliveryNoteLine[];
}

export interface DeliveryNoteLineInput {
  description: string;
  quantity: number;
  unit?: string;
  item_id?: string;
}

export interface DeliveryNoteInput {
  customer_id: string;
  sales_order_id?: string;
  invoice_id?: string;
  delivery_date?: string;
  delivery_address?: string;
  notes?: string;
  lines: DeliveryNoteLineInput[];
}

export interface DeliveryNoteFilters {
  status?: string;
  limit?: number;
  offset?: number;
}

function mapNote(r: Row): DeliveryNote {
  return {
    id: String(r.id),
    deliveryNoteNumber: String(r.delivery_note_number),
    customerId: String(r.customer_id),
    customerName: r.customer_name ? String(r.customer_name) : '',
    salesOrderId: r.sales_order_id != null ? String(r.sales_order_id) : null,
    invoiceId: r.invoice_id != null ? String(r.invoice_id) : null,
    deliveryDate:
      r.delivery_date instanceof Date
        ? r.delivery_date.toISOString().split('T')[0]!
        : String(r.delivery_date).split('T')[0]!,
    status: String(r.status),
    deliveryAddress: r.delivery_address != null ? String(r.delivery_address) : null,
    notes: r.notes != null ? String(r.notes) : null,
    createdBy: r.created_by != null ? String(r.created_by) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    lineCount: r.line_count != null ? Number(r.line_count) : undefined,
  };
}

function mapLine(r: Row): DeliveryNoteLine {
  return {
    id: String(r.id),
    deliveryNoteId: String(r.delivery_note_id),
    description: String(r.description),
    quantity: Number(r.quantity),
    unit: r.unit != null ? String(r.unit) : null,
    itemId: r.item_id != null ? String(r.item_id) : null,
  };
}

async function nextDeliveryNoteNumber(companyId: string): Promise<string> {
  const rows = (await sql`
    INSERT INTO company_document_numbers (company_id, document_type, prefix, next_number)
    VALUES (${companyId}::UUID, 'delivery_note', 'DN-', 1)
    ON CONFLICT (company_id, document_type)
    DO UPDATE SET next_number = company_document_numbers.next_number + 1
    RETURNING next_number - 1 AS current_number, prefix
  `) as Row[];

  if (rows.length === 0) return 'DN-00001';
  const num = Number(rows[0]!.current_number);
  const prefix = String(rows[0]!.prefix || 'DN-');
  return `${prefix}${String(num).padStart(5, '0')}`;
}

export async function getDeliveryNotes(
  companyId: string,
  filters?: DeliveryNoteFilters,
): Promise<{ notes: DeliveryNote[]; total: number }> {
  const limit = filters?.limit ?? 100;
  const offset = filters?.offset ?? 0;

  let rows: Row[];
  let countRows: Row[];

  if (filters?.status) {
    rows = (await sql`
      SELECT dn.*, c.name AS customer_name,
             COUNT(dnl.id) AS line_count
      FROM delivery_notes dn
      LEFT JOIN customers c ON c.id = dn.customer_id
      LEFT JOIN delivery_note_lines dnl ON dnl.delivery_note_id = dn.id
      WHERE dn.company_id = ${companyId}::UUID
        AND dn.status = ${filters.status}
      GROUP BY dn.id, c.name
      ORDER BY dn.delivery_date DESC
      LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`
      SELECT COUNT(*) AS cnt FROM delivery_notes
      WHERE company_id = ${companyId}::UUID AND status = ${filters.status}
    `) as Row[];
  } else {
    rows = (await sql`
      SELECT dn.*, c.name AS customer_name,
             COUNT(dnl.id) AS line_count
      FROM delivery_notes dn
      LEFT JOIN customers c ON c.id = dn.customer_id
      LEFT JOIN delivery_note_lines dnl ON dnl.delivery_note_id = dn.id
      WHERE dn.company_id = ${companyId}::UUID
      GROUP BY dn.id, c.name
      ORDER BY dn.delivery_date DESC
      LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`
      SELECT COUNT(*) AS cnt FROM delivery_notes
      WHERE company_id = ${companyId}::UUID
    `) as Row[];
  }

  return {
    notes: rows.map(mapNote),
    total: Number(countRows[0]?.cnt ?? 0),
  };
}

export async function getDeliveryNote(
  companyId: string,
  id: string,
): Promise<DeliveryNote | null> {
  const rows = (await sql`
    SELECT dn.*, c.name AS customer_name
    FROM delivery_notes dn
    LEFT JOIN customers c ON c.id = dn.customer_id
    WHERE dn.id = ${id}::UUID AND dn.company_id = ${companyId}::UUID
  `) as Row[];

  if (rows.length === 0) return null;
  const note = mapNote(rows[0]!);

  const lineRows = (await sql`
    SELECT * FROM delivery_note_lines
    WHERE delivery_note_id = ${id}::UUID
    ORDER BY created_at ASC
  `) as Row[];

  note.lines = lineRows.map(mapLine);
  return note;
}

export async function createDeliveryNote(
  companyId: string,
  input: DeliveryNoteInput,
  userId: string,
): Promise<DeliveryNote> {
  if (!input.customer_id) throw new Error('customer_id is required');
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new Error('At least one line is required');
  }

  const noteNumber = await nextDeliveryNoteNumber(companyId);
  const deliveryDate = input.delivery_date ?? new Date().toISOString().split('T')[0];

  log.info('Creating delivery note', { companyId, noteNumber, customerId: input.customer_id });

  const salesOrderId = input.sales_order_id ?? null;
  const invoiceId = input.invoice_id ?? null;

  const noteRows = (await sql`
    INSERT INTO delivery_notes (
      company_id, customer_id, sales_order_id, invoice_id,
      delivery_note_number, delivery_date, delivery_address, notes, created_by
    ) VALUES (
      ${companyId}::UUID,
      ${input.customer_id}::UUID,
      ${salesOrderId}::UUID,
      ${invoiceId}::UUID,
      ${noteNumber},
      ${deliveryDate}::DATE,
      ${input.delivery_address ?? null},
      ${input.notes ?? null},
      ${userId}
    )
    RETURNING *
  `) as Row[];

  const noteId = String(noteRows[0]!.id);

  for (const line of input.lines) {
    const lineItemId = line.item_id ?? null;
    await sql`
      INSERT INTO delivery_note_lines (delivery_note_id, description, quantity, unit, item_id)
      VALUES (
        ${noteId}::UUID,
        ${line.description},
        ${line.quantity},
        ${line.unit ?? null},
        ${lineItemId}::UUID
      )
    `;
  }

  const created = await getDeliveryNote(companyId, noteId);
  if (!created) throw new Error('Failed to retrieve created delivery note');
  return created;
}

export async function updateDeliveryNoteStatus(
  companyId: string,
  id: string,
  status: string,
): Promise<DeliveryNote | null> {
  const allowed = ['draft', 'dispatched', 'delivered', 'cancelled'];
  if (!allowed.includes(status)) throw new Error(`Invalid status: ${status}`);

  const rows = (await sql`
    UPDATE delivery_notes
    SET status = ${status}, updated_at = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    RETURNING id
  `) as Row[];

  if (rows.length === 0) return null;
  return getDeliveryNote(companyId, id);
}

export async function cancelDeliveryNote(
  companyId: string,
  id: string,
): Promise<boolean> {
  const rows = (await sql`
    UPDATE delivery_notes
    SET status = 'cancelled', updated_at = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
      AND status != 'cancelled'
    RETURNING id
  `) as Row[];

  return rows.length > 0;
}

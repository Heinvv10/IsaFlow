/**
 * Customer Sales Order Service — CRUD with items
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

export interface SalesOrderItem {
  id: string;
  salesOrderId: string;
  lineNumber: number;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  lineTotal: number;
}

export interface SalesOrder {
  id: string;
  orderNumber: string;
  customerId: string | null;
  customerName: string;
  orderDate: string;
  deliveryDate: string | null;
  reference: string | null;
  status: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  notes: string | null;
  internalNotes: string | null;
  createdAt: string;
  updatedAt: string;
  items?: SalesOrderItem[];
}

interface SalesOrderFilters {
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

interface SalesOrderInput {
  customer_id?: string;
  order_date?: string;
  delivery_date?: string;
  reference?: string;
  notes?: string;
  internal_notes?: string;
  items: { description: string; quantity: number; unit_price: number; tax_rate?: number }[];
}

function mapOrder(r: Row): SalesOrder {
  return {
    id: String(r.id),
    orderNumber: String(r.order_number),
    customerId: r.customer_id != null ? String(r.customer_id) : null,
    customerName: r.customer_name ? String(r.customer_name) : '',
    orderDate: String(r.order_date),
    deliveryDate: r.delivery_date != null ? String(r.delivery_date) : null,
    reference: r.reference != null ? String(r.reference) : null,
    status: String(r.status),
    subtotal: Number(r.subtotal),
    taxAmount: Number(r.tax_amount),
    totalAmount: Number(r.total_amount),
    notes: r.notes != null ? String(r.notes) : null,
    internalNotes: r.internal_notes != null ? String(r.internal_notes) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapItem(r: Row): SalesOrderItem {
  return {
    id: String(r.id),
    salesOrderId: String(r.sales_order_id),
    lineNumber: Number(r.line_number),
    description: String(r.description),
    quantity: Number(r.quantity),
    unitPrice: Number(r.unit_price),
    taxRate: Number(r.tax_rate),
    lineTotal: Number(r.line_total),
  };
}

async function nextOrderNumber(companyId: string): Promise<string> {
  // Use company_document_numbers for sequential numbering
  const rows = (await sql`
    INSERT INTO company_document_numbers (company_id, document_type, prefix, next_number)
    VALUES (${companyId}::UUID, 'sales_order', 'SO-', 1)
    ON CONFLICT (company_id, document_type)
    DO UPDATE SET next_number = company_document_numbers.next_number + 1
    RETURNING next_number - 1 AS current_number, prefix
  `) as Row[];

  if (rows.length === 0) return 'SO-00001';
  const num = Number(rows[0]!.current_number);
  const prefix = String(rows[0]!.prefix || 'SO-');
  return `${prefix}${String(num).padStart(5, '0')}`;
}

function calcTotals(items: SalesOrderInput['items']) {
  let subtotal = 0;
  let taxAmount = 0;
  for (const item of items) {
    const lt = Math.round(item.quantity * item.unit_price * 100) / 100;
    const lineTax = Math.round(lt * ((item.tax_rate ?? 15) / 100) * 100) / 100;
    subtotal += lt;
    taxAmount += lineTax;
  }
  return {
    subtotal: Math.round(subtotal * 100) / 100,
    taxAmount: Math.round(taxAmount * 100) / 100,
    totalAmount: Math.round((subtotal + taxAmount) * 100) / 100,
  };
}

export async function getSalesOrders(companyId: string, filters?: SalesOrderFilters): Promise<{ orders: SalesOrder[]; total: number }> {
  const limit = filters?.limit || 100;
  const offset = filters?.offset || 0;
  let rows: Row[];
  let countRows: Row[];

  if (filters?.search && filters?.status) {
    const pattern = `%${filters.search}%`;
    rows = (await sql`
      SELECT so.*, c.name AS customer_name
      FROM customer_sales_orders so
      LEFT JOIN customers c ON c.id = so.customer_id
      WHERE so.company_id = ${companyId}::UUID
        AND so.status = ${filters.status}
        AND (so.order_number ILIKE ${pattern} OR c.name ILIKE ${pattern} OR so.reference ILIKE ${pattern})
      ORDER BY so.created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`
      SELECT COUNT(*) AS cnt
      FROM customer_sales_orders so
      LEFT JOIN customers c ON c.id = so.customer_id
      WHERE so.company_id = ${companyId}::UUID
        AND so.status = ${filters.status}
        AND (so.order_number ILIKE ${pattern} OR c.name ILIKE ${pattern} OR so.reference ILIKE ${pattern})
    `) as Row[];
  } else if (filters?.search) {
    const pattern = `%${filters.search}%`;
    rows = (await sql`
      SELECT so.*, c.name AS customer_name
      FROM customer_sales_orders so
      LEFT JOIN customers c ON c.id = so.customer_id
      WHERE so.company_id = ${companyId}::UUID
        AND (so.order_number ILIKE ${pattern} OR c.name ILIKE ${pattern} OR so.reference ILIKE ${pattern})
      ORDER BY so.created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`
      SELECT COUNT(*) AS cnt
      FROM customer_sales_orders so
      LEFT JOIN customers c ON c.id = so.customer_id
      WHERE so.company_id = ${companyId}::UUID
        AND (so.order_number ILIKE ${pattern} OR c.name ILIKE ${pattern} OR so.reference ILIKE ${pattern})
    `) as Row[];
  } else if (filters?.status) {
    rows = (await sql`
      SELECT so.*, c.name AS customer_name
      FROM customer_sales_orders so
      LEFT JOIN customers c ON c.id = so.customer_id
      WHERE so.company_id = ${companyId}::UUID AND so.status = ${filters.status}
      ORDER BY so.created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`
      SELECT COUNT(*) AS cnt FROM customer_sales_orders so
      WHERE so.company_id = ${companyId}::UUID AND so.status = ${filters.status}
    `) as Row[];
  } else {
    rows = (await sql`
      SELECT so.*, c.name AS customer_name
      FROM customer_sales_orders so
      LEFT JOIN customers c ON c.id = so.customer_id
      WHERE so.company_id = ${companyId}::UUID
      ORDER BY so.created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`
      SELECT COUNT(*) AS cnt FROM customer_sales_orders so
      WHERE so.company_id = ${companyId}::UUID
    `) as Row[];
  }

  return { orders: rows.map(mapOrder), total: Number(countRows[0]?.cnt || 0) };
}

export async function getSalesOrder(companyId: string, id: string): Promise<SalesOrder | null> {
  const rows = (await sql`
    SELECT so.*, c.name AS customer_name
    FROM customer_sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    WHERE so.id = ${id}::UUID AND so.company_id = ${companyId}::UUID
  `) as Row[];
  if (rows.length === 0) return null;
  const order = mapOrder(rows[0]!);
  const itemRows = (await sql`
    SELECT * FROM customer_sales_order_items
    WHERE sales_order_id = ${id}::UUID ORDER BY line_number
  `) as Row[];
  order.items = itemRows.map(mapItem);
  return order;
}

export async function createSalesOrder(companyId: string, input: SalesOrderInput, userId?: string): Promise<SalesOrder> {
  const orderNumber = await nextOrderNumber(companyId);
  const { subtotal, taxAmount, totalAmount } = calcTotals(input.items);
  const orderDate = input.order_date || new Date().toISOString().split('T')[0];

  const rows = (await sql`
    INSERT INTO customer_sales_orders (
      company_id, order_number, customer_id, order_date, delivery_date,
      reference, subtotal, tax_amount, total_amount, notes, internal_notes, created_by
    ) VALUES (
      ${companyId}::UUID, ${orderNumber}, ${input.customer_id || null},
      ${orderDate}, ${input.delivery_date || null}, ${input.reference || null},
      ${subtotal}, ${taxAmount}, ${totalAmount},
      ${input.notes || null}, ${input.internal_notes || null}, ${userId || null}
    ) RETURNING *
  `) as Row[];

  const order = mapOrder(rows[0]!);
  for (let i = 0; i < input.items.length; i++) {
    const item = input.items[i];
    if (!item) continue;
    const lineTotal = Math.round(item.quantity * item.unit_price * 100) / 100;
    await sql`
      INSERT INTO customer_sales_order_items (
        sales_order_id, line_number, description, quantity, unit_price, tax_rate, line_total
      ) VALUES (
        ${order.id}::UUID, ${i + 1}, ${item.description}, ${item.quantity},
        ${item.unit_price}, ${item.tax_rate ?? 15}, ${lineTotal}
      )
    `;
  }
  log.info('Sales order created', { orderNumber, totalAmount });
  return (await getSalesOrder(companyId, order.id))!;
}

export async function updateSalesOrder(companyId: string, id: string, input: SalesOrderInput): Promise<SalesOrder | null> {
  const existing = await getSalesOrder(companyId, id);
  if (!existing || existing.status !== 'draft') return null;
  const { subtotal, taxAmount, totalAmount } = calcTotals(input.items);

  await sql`
    UPDATE customer_sales_orders SET
      customer_id = ${input.customer_id || existing.customerId},
      order_date = ${input.order_date || existing.orderDate},
      delivery_date = ${input.delivery_date || null},
      reference = ${input.reference || null},
      subtotal = ${subtotal}, tax_amount = ${taxAmount}, total_amount = ${totalAmount},
      notes = ${input.notes || null}, internal_notes = ${input.internal_notes || null},
      updated_at = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND status = 'draft'
  `;

  await sql`DELETE FROM customer_sales_order_items WHERE sales_order_id = ${id}::UUID`;
  for (let i = 0; i < input.items.length; i++) {
    const item = input.items[i];
    if (!item) continue;
    const lineTotal = Math.round(item.quantity * item.unit_price * 100) / 100;
    await sql`
      INSERT INTO customer_sales_order_items (
        sales_order_id, line_number, description, quantity, unit_price, tax_rate, line_total
      ) VALUES (
        ${id}::UUID, ${i + 1}, ${item.description}, ${item.quantity},
        ${item.unit_price}, ${item.tax_rate ?? 15}, ${lineTotal}
      )
    `;
  }
  log.info('Sales order updated', { id });
  return getSalesOrder(companyId, id);
}

export async function deleteSalesOrder(companyId: string, id: string): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM customer_sales_orders
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND status = 'draft'
    RETURNING id
  `) as Row[];
  return rows.length > 0;
}

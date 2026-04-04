/**
 * Purchase Order DB Service
 * All SQL for supplier_purchase_orders and supplier_purchase_order_items.
 * Pure business logic (validation, calculations) stays in procurementService.ts.
 */

import sql from '@/lib/neon';

export interface PurchaseOrderItem {
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
}

export interface CreatePurchaseOrderInput {
  companyId: string;
  userId: string;
  supplier_id: string;
  order_date: string;
  delivery_date?: string | null;
  reference?: string | null;
  notes?: string | null;
  internal_notes?: string | null;
  items: PurchaseOrderItem[];
}

export interface UpdatePurchaseOrderInput {
  id: string;
  companyId: string;
  supplier_id?: string | null;
  order_date?: string | null;
  delivery_date?: string | null;
  reference?: string | null;
  notes?: string | null;
  internal_notes?: string | null;
  items?: PurchaseOrderItem[];
}

export interface ListPurchaseOrdersInput {
  companyId: string;
  status?: string | null;
  search?: string | null;
  limit?: number;
  offset?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function calcTotals(items: PurchaseOrderItem[]) {
  let subtotal = 0;
  let taxAmount = 0;
  for (const item of items) {
    const lineTotal = item.quantity * item.unit_price;
    const lineTax = lineTotal * (item.tax_rate / 100);
    subtotal += lineTotal;
    taxAmount += lineTax;
  }
  return {
    subtotal: Math.round(subtotal * 100) / 100,
    taxAmount: Math.round(taxAmount * 100) / 100,
    totalAmount: Math.round((subtotal + taxAmount) * 100) / 100,
  };
}

async function insertLineItems(purchaseOrderId: string, items: PurchaseOrderItem[]) {
  for (const item of items) {
    const lineTotal = item.quantity * item.unit_price;
    const lineTax = lineTotal * (item.tax_rate / 100);
    await sql`
      INSERT INTO supplier_purchase_order_items (
        purchase_order_id, description, quantity, unit_price, tax_rate,
        line_total, tax_amount
      ) VALUES (
        ${purchaseOrderId}::UUID,
        ${item.description},
        ${item.quantity},
        ${item.unit_price},
        ${item.tax_rate},
        ${Math.round(lineTotal * 100) / 100},
        ${Math.round(lineTax * 100) / 100}
      )
    `;
  }
}

async function fetchItems(purchaseOrderId: string) {
  return sql`
    SELECT * FROM supplier_purchase_order_items
    WHERE purchase_order_id = ${purchaseOrderId}::UUID
    ORDER BY created_at ASC
  `;
}

// ─── Order number ─────────────────────────────────────────────────────────────

export async function generateOrderNumber(companyId: string): Promise<string> {
  const rows = await sql`
    UPDATE company_document_numbers
    SET next_number = next_number + 1
    WHERE company_id = ${companyId}::UUID AND document_type = 'purchase_order'
    RETURNING prefix, next_number - 1 AS current_number, padding
  `;

  if (rows.length === 0) {
    await sql`
      INSERT INTO company_document_numbers (company_id, document_type, prefix, next_number, padding)
      VALUES (${companyId}::UUID, 'purchase_order', 'PO', 2, 7)
      ON CONFLICT (company_id, document_type) DO NOTHING
    `;
    return 'PO-0000001';
  }

  const row = rows[0]!;
  return `${row.prefix}-${String(row.current_number).padStart(row.padding, '0')}`;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function getPurchaseOrder(id: string, companyId: string) {
  const orders = await sql`
    SELECT po.*, s.name AS supplier_name
    FROM supplier_purchase_orders po
    LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.company_id = po.company_id
    WHERE po.id = ${id}::UUID AND po.company_id = ${companyId}::UUID
  `;
  if (orders.length === 0) return null;
  const items = await fetchItems(id);
  return { order: orders[0]!, items };
}

export async function listPurchaseOrders(input: ListPurchaseOrdersInput) {
  const { companyId, status, search, limit = 100, offset = 0 } = input;
  const take = Math.min(limit, 500);
  const statusFilter = status ?? null;
  const searchTerm = search ? `%${search}%` : null;

  const orders = await sql`
    SELECT po.*, s.name AS supplier_name
    FROM supplier_purchase_orders po
    LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.company_id = po.company_id
    WHERE po.company_id = ${companyId}::UUID
      AND (${statusFilter}::TEXT IS NULL OR po.status = ${statusFilter})
      AND (
        ${searchTerm}::TEXT IS NULL
        OR po.order_number ILIKE ${searchTerm}
        OR po.reference ILIKE ${searchTerm}
        OR s.name ILIKE ${searchTerm}
      )
    ORDER BY po.created_at DESC
    LIMIT ${take} OFFSET ${offset}
  `;

  const countResult = await sql`
    SELECT COUNT(*)::INT AS total
    FROM supplier_purchase_orders po
    LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.company_id = po.company_id
    WHERE po.company_id = ${companyId}::UUID
      AND (${statusFilter}::TEXT IS NULL OR po.status = ${statusFilter})
      AND (
        ${searchTerm}::TEXT IS NULL
        OR po.order_number ILIKE ${searchTerm}
        OR po.reference ILIKE ${searchTerm}
        OR s.name ILIKE ${searchTerm}
      )
  `;

  return { orders, total: countResult[0]?.total ?? 0 };
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export async function createPurchaseOrder(input: CreatePurchaseOrderInput) {
  const { companyId, userId, items } = input;
  const orderNumber = await generateOrderNumber(companyId);
  const { subtotal, taxAmount, totalAmount } = calcTotals(items);

  const created = await sql`
    INSERT INTO supplier_purchase_orders (
      company_id, supplier_id, order_number, order_date, delivery_date,
      reference, notes, internal_notes, status,
      subtotal, tax_amount, total_amount, created_by
    ) VALUES (
      ${companyId}::UUID,
      ${input.supplier_id}::UUID,
      ${orderNumber},
      ${input.order_date}::DATE,
      ${input.delivery_date ?? null}::DATE,
      ${input.reference ?? null},
      ${input.notes ?? null},
      ${input.internal_notes ?? null},
      'draft',
      ${subtotal},
      ${taxAmount},
      ${totalAmount},
      ${userId}::UUID
    )
    RETURNING *
  `;

  const order = created[0]!;
  await insertLineItems(order.id, items);
  const orderItems = await fetchItems(order.id);
  return { order, items: orderItems };
}

export async function updatePurchaseOrder(input: UpdatePurchaseOrderInput) {
  const { id, companyId, items } = input;

  const existing = await sql`
    SELECT id, status FROM supplier_purchase_orders
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `;

  if (existing.length === 0) return { error: 'not_found' as const };
  if (existing[0]!.status !== 'draft') return { error: 'not_draft' as const };

  let subtotal: number | null = null;
  let taxAmount: number | null = null;
  let totalAmount: number | null = null;

  if (items && items.length > 0) {
    const totals = calcTotals(items);
    subtotal = totals.subtotal;
    taxAmount = totals.taxAmount;
    totalAmount = totals.totalAmount;
  }

  const updated = await sql`
    UPDATE supplier_purchase_orders SET
      supplier_id    = COALESCE(${input.supplier_id ?? null}::UUID, supplier_id),
      order_date     = COALESCE(${input.order_date ?? null}::DATE, order_date),
      delivery_date  = COALESCE(${input.delivery_date ?? null}::DATE, delivery_date),
      reference      = COALESCE(${input.reference ?? null}, reference),
      notes          = COALESCE(${input.notes ?? null}, notes),
      internal_notes = COALESCE(${input.internal_notes ?? null}, internal_notes),
      subtotal       = COALESCE(${subtotal}, subtotal),
      tax_amount     = COALESCE(${taxAmount}, tax_amount),
      total_amount   = COALESCE(${totalAmount}, total_amount),
      updated_at     = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    RETURNING *
  `;

  if (items && items.length > 0) {
    await sql`DELETE FROM supplier_purchase_order_items WHERE purchase_order_id = ${id}::UUID`;
    await insertLineItems(id, items);
  }

  const orderItems = await fetchItems(id);
  return { order: updated[0]!, items: orderItems };
}

export async function deletePurchaseOrder(id: string, companyId: string) {
  const existing = await sql`
    SELECT id, status FROM supplier_purchase_orders
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `;

  if (existing.length === 0) return { error: 'not_found' as const };
  if (existing[0]!.status !== 'draft') return { error: 'not_draft' as const };

  await sql`DELETE FROM supplier_purchase_order_items WHERE purchase_order_id = ${id}::UUID`;
  await sql`DELETE FROM supplier_purchase_orders WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`;

  return { deleted: true };
}

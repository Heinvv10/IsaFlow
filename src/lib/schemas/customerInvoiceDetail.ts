/**
 * Zod schemas for the customer-invoice detail API
 * (pages/api/accounting/customer-invoices-detail.ts). Extracted from the route
 * to keep the handler under the 300-line cap.
 */
import { z } from 'zod';
import { UUID, ISODate } from '@/lib/schemas/common';
import { isDiscountPercent } from '@/modules/accounting/services/ar/invoiceLineAmount';

export const GetQuerySchema = z.object({ id: UUID });

export const PutItemSchema = z.object({
  description: z.string().min(1).max(500),
  // Within their columns (quantity numeric(10,2) and at least 0.01 once stored; unit_price numeric(15,2)), as create checks them.
  quantity: z.number().gte(0.005).lt(1e8),
  unitPrice: z.number().nonnegative().lt(1e13),
  taxRate: z.number().min(0).max(100).optional(),
  discount: z.number().refine(isDiscountPercent, 'discount must be from 0 to 100, to at most two decimal places').optional(),
  // Migration 874: the account the line credits and its job. Shape only —
  // ownership and the revenue-account rules are invoiceLineCodingGuard's.
  glAccountId: UUID.nullable().optional(),
  projectId: UUID.nullable().optional(),
  // CC1 / CC2 / BU (migration 870): left out keeps the value every stored line
  // shares; null clears it (gl/dimensions/dimensionKeepStored).
  cc1Id: UUID.nullable().optional(),
  cc2Id: UUID.nullable().optional(),
  buId: UUID.nullable().optional(),
});

export const PutBodySchema = z.object({
  id: UUID,
  notes: z.string().max(2000).optional(),
  internalNotes: z.string().max(2000).optional(),
  dueDate: ISODate.optional(),
  // Full draft-edit fields (all optional — partial PUT supported for back-compat).
  clientId: UUID.optional(),
  invoiceDate: ISODate.optional(),
  billingPeriodStart: ISODate.optional(),
  billingPeriodEnd: ISODate.optional(),
  taxRate: z.number().min(0).max(100).optional(),
  currencyCode: z.string().min(1).max(8).optional(),
  exchangeRate: z.number().positive().optional(),
  items: z.array(PutItemSchema).min(1).optional(),
  // The invoice's own project: display only (only line dimensions post). Absent keeps it, null clears it.
  projectId: UUID.nullable().optional(),
});

export const PostBodySchema = z.object({
  id: UUID,
  action: z.enum(['approve', 'send', 'cancel']),
});

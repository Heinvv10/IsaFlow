/**
 * Zod schemas for the customer-invoice detail API
 * (pages/api/accounting/customer-invoices-detail.ts). Extracted from the route
 * to keep the handler under the 300-line cap.
 */
import { z } from 'zod';
import { UUID, ISODate } from '@/lib/schemas/common';

export const GetQuerySchema = z.object({ id: UUID });

export const PutItemSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative(),
  taxRate: z.number().min(0).max(100).optional(),
  discount: z.number().min(0).max(100).optional(),
  // Migration 870: what the line credits and is tagged with. Shape only —
  // ownership and the revenue-account rules are invoiceLineCodingGuard's.
  glAccountId: UUID.nullable().optional(),
  projectId: UUID.nullable().optional(),
  costCenterId: UUID.nullable().optional(),
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

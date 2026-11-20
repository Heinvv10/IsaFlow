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
  // LEGACY, stored by no total: accepted only as its VAT type's rate on the invoice date (invoiceLineVatTypes), else 400.
  taxRate: z.number().min(0).max(100).optional(),
  // The line's VAT type (standard, zero_rated, exempt): its rate comes from the type and the date. Left out: the identical
  // stored line's type, else the default chain (customerInvoiceDraftVat). Never with the header taxRate.
  vatType: z.string().max(32).nullable().optional(),
  discount: z.number().refine(isDiscountPercent, 'discount must be from 0 to 100, to at most two decimal places').optional(),
  // Migration 874: the account the line credits and its job. Shape only —
  // ownership and the revenue-account rules are invoiceLineCodingGuard's.
  glAccountId: UUID.nullable().optional(),
  projectId: UUID.nullable().optional(),
  // Migration 1005: the catalogue item. A NEW item is checked and defaults the account; left out keeps the item of an identical
  // stored line; null clears it (items/itemEditLines).
  itemId: UUID.nullable().optional(),
  // CC1 / CC2 / BU (migration 870): left out keeps the value every stored line
  // shares; null clears it (gl/dimensions/dimensionKeepStored).
  cc1Id: UUID.nullable().optional(),
  cc2Id: UUID.nullable().optional(),
  buId: UUID.nullable().optional(),
  // The WIP time entry the line bills, re-sent as loaded: only one this invoice's lines already carry (customerInvoiceWipLinks).
  timeEntryId: UUID.nullable().optional(),
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
  // LEGACY header rate: the standard rate on the invoice date (every line standard) or 0 (zero_rated); never with a line vatType.
  taxRate: z.number().min(0).max(100).optional(),
  // How each unitPrice reads: inclusive = VAT-inclusive, stored as entered, the VAT backed out per line. Left out: as stored.
  amountsAre: z.enum(['exclusive', 'inclusive']).optional(),
  currencyCode: z.string().min(1).max(8).optional(),
  exchangeRate: z.number().positive().optional(),
  items: z.array(PutItemSchema).min(1).optional(),
  // The invoice's own project: display only (only line dimensions post). Absent keeps it, null clears it.
  projectId: UUID.nullable().optional(),
  // The draft digest the page edited from (its last read or save; the invoice row and its lines only): a moved
  // invoice refuses the PUT (409 STALE_VIEW). A customer or company record edited meanwhile does not.
  expectedDraftDigest: z.string().min(1).max(128).optional(),
  // Time entries whose lines the user removed (asked first): released. A linked line left unlinked unnamed is refused.
  releaseTimeEntryIds: z.array(UUID).max(500).optional(),
});

export const PostBodySchema = z.object({
  id: UUID,
  action: z.enum(['approve', 'send', 'cancel']),
  // approve only: what the approver was shown. Anything stored differently is refused (409 STALE_VIEW), so an invoice
  // is never approved at a total, in a currency or at a rate nobody saw. Optional for API clients with no screen.
  expectedTotal: z.number().finite().optional(),
  expectedCurrency: z.string().min(1).max(8).optional(),
  expectedExchangeRate: z.number().positive().finite().optional(),
  expectedContentDigest: z.string().min(1).max(128).optional(),
});

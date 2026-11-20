/**
 * The POST body of /api/accounting/bank-transactions-action: one schema per action (split out of the route for the 300-line cap).
 */
import { z } from 'zod';
import { UUID } from '@/lib/schemas/common';
import { AUTO_APPLY_MODES } from '@/modules/accounting/services/shared/autoAllocateStrategy';
import { ALLOCATION_VAT_CODES } from '@/modules/accounting/services/bank/bankVatCodes';

export const BankTxActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('match'), bankTransactionId: UUID, journalLineId: UUID, reconciliationId: UUID.optional() }),
  z.object({ action: z.literal('unmatch'), bankTransactionId: UUID, expectedStatus: z.literal('excluded').optional() }),
  z.object({ action: z.literal('exclude'), bankTransactionId: UUID, excludeReason: z.string().max(200).optional() }),
  z.object({ action: z.literal('auto_match'), bankAccountId: UUID, reconciliationId: UUID.optional() }),
  z.object({
    action: z.literal('allocate'),
    bankTransactionId: UUID,
    allocationType: z.enum(['account', 'supplier', 'customer', 'transfer']).optional(),
    contraAccountId: UUID.optional(),
    entityId: UUID.optional(),
    description: z.string().max(500).optional(),
    vatCode: z.string().max(20).optional(),
    cc1Id: UUID.optional(),
    cc2Id: UUID.optional(),
    buId: UUID.optional(),
    // What to do with a supplier/customer line that names no document.
    // 'fifo' (the default) settles that contact's oldest open documents.
    autoApply: z.enum(AUTO_APPLY_MODES).optional(),
  }),
  z.object({
    action: z.literal('split_allocate'),
    bankTransactionId: UUID,
    lines: z.array(z.object({
      // Positive rand-and-cents: the split posts each line in the bank line's own direction.
      contraAccountId: UUID.optional(), amount: z.number().positive().refine((n) => Number(n.toFixed(2)) === n, 'amount must be in whole cents'),
      description: z.string().max(500).optional(),
      // The line's VAT treatment, as the split modal sends it (VAT_OPTIONS). Missing from this schema from BL-33
      // (2026-04-15) until 2026-10-14: zod stripped it, and every screen split posted with no VAT leg.
      vatCode: z.enum(['none', 'standard', 'zero_rated', 'exempt']).optional(),
      // Per-line dimensions, stamped on that line's cost/revenue leg only (bankSplitDimensions.ts).
      cc1Id: UUID.optional(), cc2Id: UUID.optional(), buId: UUID.optional(),
      // A line that settles a supplier/customer instead of a GL account (bankSplitContacts.ts).
      contactType: z.enum(['supplier', 'customer']).optional(), contactId: UUID.optional(),
      autoApply: z.enum(AUTO_APPLY_MODES).optional(),
    }).superRefine((line, ctx) => {
      // Exactly one target, as the MCP tool requires: a line naming both would silently drop the account.
      const contact = line.contactType !== undefined || line.contactId !== undefined;
      if (contact && (line.contactType === undefined || line.contactId === undefined)) {
        ctx.addIssue({ code: 'custom', message: 'contactType and contactId go together' });
      } else if (contact === (line.contraAccountId !== undefined)) {
        ctx.addIssue({ code: 'custom', message: 'a split line names exactly one of contraAccountId or contactType + contactId' });
      } else if (!contact && line.autoApply !== undefined) {
        ctx.addIssue({ code: 'custom', message: 'autoApply applies only to a supplier/customer line' });
      } else if (contact && (line.cc1Id || line.cc2Id || line.buId)) {
        ctx.addIssue({ code: 'custom', message: 'a supplier/customer line carries no cc1/cc2/bu' });
      } else if (contact && line.vatCode !== undefined && line.vatCode !== 'none') {
        ctx.addIssue({ code: 'custom', message: 'a supplier/customer line carries no VAT (the bill or invoice already did)' });
      }
    })).min(1),
  }),
  z.object({ action: z.literal('delete'), bankTransactionId: UUID.optional(), bankTransactionIds: z.array(UUID).optional() }),
  z.object({ action: z.literal('bulk_accept'), bankTransactionIds: z.array(UUID).min(1) }),
  z.object({ action: z.literal('update_notes'), bankTransactionId: UUID, notes: z.string().max(1000).optional() }),
  z.object({
    action: z.literal('save_selection'),
    bankTransactionId: UUID,
    selectionType: z.string().max(50).optional(),
    selectionEntityId: UUID.optional(),
    // The four allocation codes only: this lands in suggested_vat_code, which the screen pre-fills and the gate posts.
    vatCode: z.enum(ALLOCATION_VAT_CODES).optional(),
  }),
  z.object({
    action: z.literal('save_dimensions'),
    bankTransactionId: UUID,
    cc1Id: UUID.nullish(), // null = "none": the grid sends it for each dimension a row lacks, and to clear one
    cc2Id: UUID.nullish(),
    buId: UUID.nullish(),
  }),
  z.object({ action: z.literal('reverse'), bankTransactionId: UUID, expectedJournalEntryId: UUID.optional() }),
]);

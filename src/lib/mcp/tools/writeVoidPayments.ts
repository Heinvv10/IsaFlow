/**
 * MCP write tools: void a receipt or a supplier payment.
 *
 * `reverse_bank_allocation` undoes cash addressed by BANK LINE. These two undo
 * cash addressed by the DOCUMENT — the receipt an agent has in front of it
 * after `apply_receipt_to_invoice`, which until now had no undo at all when it
 * settled no bank line. See `paymentVoidService.ts` for the three shapes a
 * payment can be in and why the bank-backed one delegates.
 *
 * Both are `requiresPost`: voiding a posted receipt writes a reversing journal,
 * which is the same authority `reverse_bank_allocation` asks for.
 */
import type { McpTool } from '../types';
import {
  isVoidRefusal,
  voidPaymentDocument,
  type PaymentKind,
} from '@/modules/accounting/services/core/paymentVoidService';
import { mcpPostingOpts } from '../mcpActor';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const REVERSAL_DATE_PROPERTY = {
  reversal_date: {
    type: 'string',
    format: 'date',
    description: "Date for the reversing journal. Defaults to the original entry's date when that period is open, today when it is closed.",
  },
} as const;

/** Both tools differ only in which subledger they address. */
function voidTool(
  name: string,
  kind: PaymentKind,
  idKey: string,
  description: string,
): McpTool {
  return {
    name,
    description,
    scope: 'write:invoices',
    write: true,
    requiresPost: true,
    inputSchema: {
      type: 'object',
      properties: {
        [idKey]: { type: 'string' },
        ...REVERSAL_DATE_PROPERTY,
        idempotency_key: { type: 'string' },
      },
      required: [idKey, 'idempotency_key'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const paymentId = strArg(args, idKey);
      if (!paymentId) return toolError(`${idKey} is required`);
      const bad = guardCastableArgs(args, { uuid: [idKey], date: ['reversal_date'] });
      if (bad) return bad;

      const reversalDate = strArg(args, 'reversal_date');

      // No catch. Every refusal below is answered from a READ, before the first
      // write; anything that throws after that must reach the registry's
      // savepoint rather than being flattened into a tool error, because a
      // refusal is audited with a NULL idempotency key and the agent's retry on
      // that key would void a second time.
      const result = await voidPaymentDocument(
        ctx.companyId,
        kind,
        paymentId,
        ctx.userId,
        {
          ...mcpPostingOpts(ctx, name),
          ...(reversalDate === undefined ? {} : { reversalDate }),
        },
      );

      if (isVoidRefusal(result)) {
        // NOT_FOUND covers a foreign id too: a distinct "belongs to another
        // company" reply is an existence oracle. The other two name the
        // document's own status, which the agent can already read.
        if (result.refusal === 'not_found') return toolError(NOT_FOUND);
        if (result.refusal === 'already_cancelled') {
          return toolError('This document is already cancelled.');
        }
        if (result.refusal === 'ambiguous_bank_lines') {
          return toolError(
            `This document's journal settles ${result.count} bank transactions, so voiding it `
            + 'would reverse the journal while leaving the others allocated against it. '
            + 'Reverse each bank line with reverse_bank_allocation instead.',
          );
        }
        return toolError(
          `Only a document whose cash has been applied can be voided (status: ${result.status}). `
          + 'An unapplied document has not moved any invoice balance — cancel it instead.',
        );
      }

      return ok({
        [idKey]: result.paymentId,
        payment_number: result.paymentNumber,
        voided: true,
        invoices_reopened: result.invoicesReopened,
        amount_unapplied: result.amountUnapplied,
        journal_entry_id: result.journalEntryId,
        bank_transaction_id: result.bankTransactionId,
      });
    },
  };
}

export const voidReceiptTool = voidTool(
  'void_receipt',
  'customer',
  'receipt_id',
  'Void a customer receipt (CP document): takes the cash back off every invoice it was applied to, '
  + 'reverses its journal, and cancels the document. If the receipt settled a bank line, that line returns to unallocated too. '
  + 'Use to correct a receipt captured in error — the original and its reversal both remain in the audit trail. '
  + 'Requires the write:post permission. Already-cancelled documents are refused.',
);

export const voidPaymentTool = voidTool(
  'void_payment',
  'supplier',
  'payment_id',
  'Void a supplier payment: takes the cash back off every bill it was applied to, '
  + 'reverses its journal, and cancels the document. If the payment settled a bank line, that line returns to unallocated too. '
  + 'Use to correct a payment captured in error — the original and its reversal both remain in the audit trail. '
  + 'Requires the write:post permission. Already-cancelled documents are refused.',
);

/**
 * MCP write tool: `apply_receipt_to_invoice`.
 *
 * The highest-value single endpoint in the assurance programme. Until it
 * existed, `amount_paid` was 0.00 on every customer invoice in the system,
 * R2.45m of received cash sat on the AR control account attached to no
 * document, and the aged debtors report was a list of everything ever invoiced
 * rather than of what is owed.
 *
 * TWO SOURCES, TWO LEDGER BEHAVIOURS. They are different operations wearing one
 * name because the agent's intent — "this cash settles these invoices" — is one
 * thing, and the reply always says which happened.
 *
 *   payment_id           An existing receipt whose journal has ALREADY posted.
 *                        NO journal is posted. Only the subledger moves.
 *   bank_transaction_id  An imported, unallocated bank line. ONE journal posts,
 *                        DR Bank / CR Accounts Receivable, for the full amount
 *                        of that line — then the subledger moves.
 *
 * Both go through the same guards and the same apply, so a receipt cannot be
 * applied one way in a dry run and another way live.
 */
import type { McpTool } from '../types';
import { MUTATION_ARG_SCHEMA, type DryRunEffect, type DryRunResult } from '@/lib/mcp/contracts';
import {
  type ReceiptApplicationLine,
} from '@/modules/accounting/services/ar/receiptApplicationService';
import {
  confirmReceiptMatch,
  validateBankReceiptApplication,
} from '@/modules/accounting/services/ar/receiptMatchConfirmService';
import { assertBankAllocationAuthority } from '@/modules/accounting/services/bank/bankAllocationService';
import { mcpPostingAgent } from '../postingAgent';
import { CASH_APPLICATION_INTENT_REQUIRED_TEXT, allocationsSchema, parseAllocations } from './cashApplicationArgs';
import { guardCastableArgs, ok, safeErrorText, strArg, toolError } from './toolHelpers';

const TOOL = 'apply_receipt_to_invoice';

export const applyReceiptToInvoiceTool: McpTool = {
  name: TOOL,
  description:
    'Apply a customer receipt to the invoices it settles: writes the allocation, raises each '
    + "invoice's amount_paid and moves it to partially_paid or paid. This is what makes "
    + 'aged_debtors show what is OWED rather than everything ever invoiced. '
    + 'Name the cash with EXACTLY ONE of payment_id or bank_transaction_id. '
    + 'payment_id — an existing receipt whose journal has already posted (find them with '
    + 'list_unapplied_receipts): NO journal is posted, only the subledger moves. '
    + 'bank_transaction_id — an imported, unallocated bank line (find them with '
    + 'list_bank_transactions, and get suggested invoices from suggest_receipt_matches): ONE '
    + 'journal posts, DR Bank / CR Accounts Receivable, for the FULL amount of that line. '
    + 'Every invoice must belong to the same customer as the receipt, and no amount may exceed '
    + "that invoice's outstanding balance. Applying less than the receipt is allowed and leaves a "
    + 'real unapplied remainder, which list_unapplied_receipts will keep reporting. '
    + 'Does NOT cover: supplier payments (apply_payment_to_supplier_invoice), settlement against '
    + 'a loan or intercompany account without cash (settle_by_contra), credit notes '
    + '(create_credit_note), or receipts that were posted straight to the control account by a '
    + 'journal with no customer payment record behind them — those are invisible to this tool. '
    + 'payment_id is REFUSED today, live and dry run alike: applying an existing payment needs a '
    + 'prepared cash application intent and independent approval this connector cannot prepare yet. '
    + 'Run with dry_run first: for bank_transaction_id it reports every balance that would move '
    + 'and writes nothing.',
  scope: 'write:invoices',
  write: true,
  // Both branches move a customer's outstanding balance, and one of them posts
  // a journal. The same grant that gates allocate_bank_transaction gates this.
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      payment_id: {
        type: 'string',
        description:
          'An existing customer receipt (customer_payments) whose journal has already posted. '
          + 'Mutually exclusive with bank_transaction_id.',
      },
      bank_transaction_id: {
        type: 'string',
        description:
          'An imported, unallocated bank line. Mutually exclusive with payment_id. Posting a '
          + 'journal for the full line is part of this call.',
      },
      allocations: allocationsSchema('invoice_id', 'customer invoice'),
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['allocations', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const paymentId = strArg(args, 'payment_id');
    const bankTxId = strArg(args, 'bank_transaction_id');
    if (!paymentId === !bankTxId) {
      return toolError(
        'Name the cash with exactly one of payment_id or bank_transaction_id. '
        + 'payment_id applies a receipt already in the ledger (no journal posts); '
        + 'bank_transaction_id allocates an imported bank line (one journal posts).',
      );
    }
    const bad = guardCastableArgs(args, { uuid: ['payment_id', 'bank_transaction_id'] });
    if (bad) return bad;

    const parsed = parseAllocations(args, 'invoice_id');
    if (!parsed.ok) return parsed.error;
    const { allocations } = parsed;
    const dryRun = args.dry_run === true;

    return bankTxId
      ? applyFromBankLine(ctx.companyId, ctx.userId, bankTxId, allocations, dryRun)
      // Refused up front, live and preview alike: applying an existing payment needs a
      // prepared, approved cash application intent this connector cannot prepare yet.
      : toolError(CASH_APPLICATION_INTENT_REQUIRED_TEXT);
  },
};

/**
 * An imported bank line. Every refusal is answered from READS by
 * `validateBankReceiptApplication` before `confirmReceiptMatch` posts anything;
 * after that call nothing is caught, because the savepoint unwinds on a throw
 * and not on a returned error.
 */
async function applyFromBankLine(
  companyId: string,
  userId: string,
  bankTxId: string,
  allocations: readonly { invoiceId: string; amount: number }[],
  dryRun: boolean,
) {
  // The allocation service's own authority, run on the preview too: a dry run
  // skips the write, never the guard.
  await assertBankAllocationAuthority(companyId, userId);
  let validation;
  try {
    validation = await validateBankReceiptApplication(companyId, bankTxId, allocations);
  } catch (err) {
    return toolError(safeErrorText(err, 'Could not allocate this bank transaction.'));
  }

  if (dryRun) {
    return dryRunResult({
      // The journal is described rather than built: its GL account ids come from
      // inside allocateTransaction, and naming accounts this call did not
      // resolve would be a guess presented as a preview. The AMOUNT and the
      // direction are the facts that matter and they are exact.
      journals: [{
        date: validation.transactionDate,
        description:
          `DR Bank / CR Accounts Receivable R${validation.receiptAmount.toFixed(2)} `
          + '(the full bank line — the system bank and receivable control accounts)',
        fiscalPeriodId: null,
        lines: [],
        totalDebit: validation.receiptAmount,
        totalCredit: validation.receiptAmount,
      }],
      effects: invoiceEffects(validation.lines),
    });
  }

  const result = await confirmReceiptMatch(companyId, {
    bankTxId,
    userId,
    allocations,
    postingAgent: mcpPostingAgent(TOOL),
  });
  return ok({
    source: 'bank_transaction',
    posted_journal_entry_id: result.journalEntryId,
    journal_posted: true,
    bank_transaction_id: result.bankTxId,
    payment_id: result.customerPaymentId,
    customer_id: result.customerId,
    receipt_amount: result.receiptAmount,
    applied_now: result.allocatedTotal,
    unapplied_remainder: result.unappliedRemainder,
    payment_status: result.paymentStatus,
    invoices: result.lines.map(lineReply),
  });
}

function invoiceEffects(lines: readonly ReceiptApplicationLine[]): DryRunEffect[] {
  return lines.map((l) => ({
    entityType: 'customer_invoice' as const,
    entityId: l.invoiceId,
    documentNumber: l.invoiceNumber,
    field: 'outstanding',
    before: l.outstandingBefore,
    after: l.outstandingAfter,
  }));
}

function lineReply(l: ReceiptApplicationLine) {
  return {
    invoice_id: l.invoiceId,
    invoice_number: l.invoiceNumber,
    amount_applied: l.amount,
    outstanding_before: l.outstandingBefore,
    outstanding_after: l.outstandingAfter,
    status_before: l.statusBefore,
    status_after: l.statusAfter,
  };
}

/**
 * `wroteNothing` is what keeps the idempotency key free. Without it the preview
 * is stored under the key and the real call that follows — same intent, same
 * key — is served the preview forever.
 */
function dryRunResult(parts: Pick<DryRunResult, 'journals' | 'effects'>) {
  const result: DryRunResult = {
    dryRun: true,
    journals: parts.journals,
    skipped: [],
    effects: parts.effects,
    journalsTotal: parts.journals.length,
    truncated: false,
  };
  return { ...ok(result), wroteNothing: true };
}


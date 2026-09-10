/**
 * MCP write tool: `apply_payment_to_supplier_invoice`.
 *
 * The AP mirror of `apply_receipt_to_invoice`. Until it existed, every supplier
 * invoice in the system read as wholly outstanding while the GL showed the cash
 * gone — AP overstated by R613,642 against a Sage book showing all seventeen
 * bills paid. The mechanism was `allocateTransaction(allocType='supplier')`,
 * which posts DR Accounts Payable / CR Bank and then sets a `payment_matched`
 * BOOLEAN, never moving `amount_paid` or `status`.
 *
 * TWO SOURCES, TWO LEDGER BEHAVIOURS, as on the AR side:
 *
 *   payment_id           An existing PROCESSED supplier payment. NO journal is
 *                        posted; only the subledger moves.
 *   bank_transaction_id  An imported, unallocated outgoing bank line. ONE
 *                        journal posts, DR Accounts Payable / CR Bank, for the
 *                        full amount of that line, and the supplier payment
 *                        document that the AP allocation path never created is
 *                        created alongside it.
 */
import type { McpTool } from '../types';
import { MUTATION_ARG_SCHEMA, type DryRunEffect, type DryRunResult } from '@/lib/mcp/contracts';
import {
  applySupplierPaymentPlan,
  planSupplierPaymentApplication,
  type SupplierApplicationLine,
} from '@/modules/accounting/services/ap/supplierPaymentApplicationService';
import {
  applyBankLineToSupplierInvoices,
  validateBankSupplierPayment,
} from '@/modules/accounting/services/ap/supplierBankPaymentService';
import { assertBankAllocationAuthority } from '@/modules/accounting/services/bank/bankAllocationService';
import { mcpPostingAgent } from '../postingAgent';
import { allocationsSchema, parseAllocations } from './cashApplicationArgs';
import { guardCastableArgs, ok, safeErrorText, strArg, toolError } from './toolHelpers';

const TOOL = 'apply_payment_to_supplier_invoice';

export const applyPaymentToSupplierInvoiceTool: McpTool = {
  name: TOOL,
  description:
    'Apply a supplier payment to the bills it settles: writes the allocation, raises each '
    + "invoice's amount_paid, moves it to partially_paid or paid, and sets payment_matched when "
    + 'it is fully settled. This is what makes aged_creditors show what is OWED rather than every '
    + 'bill ever received. '
    + 'Name the cash with EXACTLY ONE of payment_id or bank_transaction_id. '
    + 'payment_id — an existing supplier payment that has already been PROCESSED (its DR Accounts '
    + 'Payable / CR Bank journal has posted): NO journal is posted, only the subledger moves. A '
    + 'draft or merely approved payment is refused, because no cash has left the bank yet. '
    + 'bank_transaction_id — an imported, unallocated bank line for money OUT (find them with '
    + 'list_bank_transactions, and candidates with get_match_candidates): ONE journal posts for '
    + 'the FULL amount of that line, and the supplier payment document is created alongside it. '
    + 'Every bill must belong to the same supplier as the payment, and no amount may exceed that '
    + "bill's outstanding balance. Applying less than the payment is allowed and leaves a real "
    + 'unapplied remainder on it. '
    + 'Does NOT cover: customer receipts (apply_receipt_to_invoice), settlement against a loan or '
    + 'intercompany account without cash (settle_by_contra), or supplier credit notes '
    + '(create_credit_note). '
    + 'Run with dry_run first: it reports every balance that would move and writes nothing.',
  scope: 'write:invoices',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      payment_id: {
        type: 'string',
        description:
          'An existing PROCESSED supplier payment. Mutually exclusive with bank_transaction_id.',
      },
      bank_transaction_id: {
        type: 'string',
        description:
          'An imported, unallocated bank line for money OUT. Mutually exclusive with payment_id. '
          + 'Posting a journal for the full line is part of this call.',
      },
      allocations: allocationsSchema('invoice_id', 'supplier invoice'),
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
        + 'payment_id applies a payment already in the ledger (no journal posts); '
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
      : applyFromPayment(ctx.companyId, ctx.userId, paymentId!, allocations, dryRun);
  },
};

async function applyFromPayment(
  companyId: string,
  userId: string,
  paymentId: string,
  allocations: readonly { invoiceId: string; amount: number }[],
  dryRun: boolean,
) {
  let plan;
  try {
    plan = await planSupplierPaymentApplication(companyId, paymentId, allocations);
  } catch (err) {
    return toolError(safeErrorText(err, 'Could not apply this payment.'));
  }

  if (dryRun) {
    return dryRunResult({
      journals: [],
      effects: [
        ...billEffects(plan.lines),
        {
          entityType: 'supplier_invoice' as const,
          entityId: plan.paymentId,
          documentNumber: plan.paymentNumber,
          field: 'payment_unapplied_amount',
          before: plan.unappliedBefore,
          after: plan.unappliedAfter,
        },
      ],
    });
  }

  // Nothing below the plan is caught: a returned refusal after a write frees the
  // idempotency key for a retry that applies the payment twice.
  await applySupplierPaymentPlan(companyId, plan, userId);
  return ok({
    source: 'payment',
    posted_journal_entry_id: null,
    journal_posted: false,
    payment_id: plan.paymentId,
    payment_number: plan.paymentNumber,
    supplier_id: plan.supplierId,
    payment_amount: plan.paymentTotal,
    applied_now: round2(plan.allocatedAfter - plan.allocatedBefore),
    unapplied_remainder: plan.unappliedAfter,
    payment_status: plan.paymentStatusAfter,
    invoices: plan.lines.map(lineReply),
  });
}

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
    validation = await validateBankSupplierPayment(companyId, bankTxId, allocations);
  } catch (err) {
    return toolError(safeErrorText(err, 'Could not allocate this bank transaction.'));
  }

  if (dryRun) {
    return dryRunResult({
      // Described rather than built: the GL account ids are resolved inside
      // allocateTransaction, and naming accounts this call never resolved would
      // be a guess presented as a preview. The amount and direction are exact.
      journals: [{
        date: validation.transactionDate,
        description:
          `DR Accounts Payable / CR Bank R${validation.paymentAmount.toFixed(2)} `
          + '(the full bank line — the system payable and bank accounts)',
        fiscalPeriodId: null,
        lines: [],
        totalDebit: validation.paymentAmount,
        totalCredit: validation.paymentAmount,
      }],
      effects: billEffects(validation.lines),
    });
  }

  const result = await applyBankLineToSupplierInvoices(companyId, {
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
    payment_id: result.supplierPaymentId,
    payment_number: result.paymentNumber,
    supplier_id: result.supplierId,
    payment_amount: result.paymentAmount,
    applied_now: result.allocatedTotal,
    unapplied_remainder: result.unappliedRemainder,
    payment_status: result.paymentStatus,
    invoices: result.lines.map(lineReply),
  });
}

function billEffects(lines: readonly SupplierApplicationLine[]): DryRunEffect[] {
  return lines.map((l) => ({
    entityType: 'supplier_invoice' as const,
    entityId: l.invoiceId,
    documentNumber: l.invoiceNumber,
    field: 'outstanding',
    before: l.outstandingBefore,
    after: l.outstandingAfter,
  }));
}

function lineReply(l: SupplierApplicationLine) {
  return {
    invoice_id: l.invoiceId,
    invoice_number: l.invoiceNumber,
    amount_applied: l.amount,
    outstanding_before: l.outstandingBefore,
    outstanding_after: l.outstandingAfter,
    status_before: l.statusBefore,
    status_after: l.statusAfter,
    payment_matched: l.fullySettled,
  };
}

/** `wroteNothing` is what keeps the idempotency key free — see CONTRACTS §6. */
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

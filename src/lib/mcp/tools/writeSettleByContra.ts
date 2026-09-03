/**
 * MCP write tool: `settle_by_contra`.
 *
 * Clears a receivable or a payable against another GL account — a loan, an
 * intercompany or a director's account — without inventing a bank payment that
 * never happened. R371,470 of Brightsphere AP was settled this way in Sage and
 * could not be represented in IsaFlow at all: the only settlement the API
 * offered was a bank payment.
 *
 * It composes the existing payment services rather than adding a fifth way to
 * settle a document — see `core/contraSettlementService.ts` for why that works
 * and what had to be guarded. The new part is the guards and the label:
 * migration 540 adds `'contra'` to both `payment_method` checks, so a netting
 * entry is afterwards distinguishable from an EFT.
 */
import type { McpTool } from '../types';
import { MUTATION_ARG_SCHEMA, type DryRunResult } from '@/lib/mcp/contracts';
import {
  assertContraAccountUsable,
  loadContraDocument,
  type Subledger,
} from '@/modules/accounting/services/core/contraSettlementService';
import {
  createCustomerPayment,
  confirmCustomerPayment,
} from '@/modules/accounting/services/ar/customerPaymentService';
import {
  createSupplierPayment,
  approveSupplierPayment,
  processSupplierPayment,
} from '@/modules/accounting/services/ap/supplierPaymentService';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { fmtDate } from '@/lib/fmtDate';
import { mcpPostingAgent } from '../postingAgent';
import { guardCastableArgs, ok, safeErrorText, strArg, toolError } from './toolHelpers';

const TOOL = 'settle_by_contra';
const SUBLEDGERS: readonly Subledger[] = ['ar', 'ap'];

export const settleByContraTool: McpTool = {
  name: TOOL,
  description:
    'Settle a customer invoice or a supplier bill against another GL account — a loan, '
    + 'intercompany or director\'s account — WITHOUT any cash moving. Use it when the debt was '
    + 'netted off rather than paid, which is otherwise only representable as a bank payment that '
    + 'never happened. '
    + 'subledger "ar" posts DR <contra account> / CR Accounts Receivable and reduces that '
    + "invoice's outstanding balance. subledger \"ap\" posts DR Accounts Payable / CR <contra "
    + "account> and reduces that bill's. Either way a payment document is created with "
    + 'payment_method "contra", so the settlement is afterwards distinguishable from a real bank '
    + 'movement. '
    + 'THE CONTRA ACCOUNT MUST BE A BALANCE-SHEET ACCOUNT — a loan, an intercompany or a '
    + "director's account (type asset, liability or equity). Netting a debt against an EXPENSE or "
    + 'REVENUE account is a WRITE-OFF, not a contra, and is refused naming write_off '
    + '(POST /api/accounting/write-offs), which has its own treatment. The side is decided from '
    + "the account's type and subtype, never from its name or code. "
    + 'Also REFUSES a contra account that is a bank account (that is the phantom payment this '
    + "exists to avoid), the subledger's own control account (it nets to nothing and settles the "
    + 'document against itself), a parent header account (the balance sheet excludes headers, so '
    + 'the posting would be invisible), a deactivated one, or one whose account_type and '
    + 'account_subtype are not a valid pairing (it cannot be classified, and this will not guess '
    + '— fix it with update_gl_account). Also refuses an amount above the document\'s outstanding '
    + 'balance, and a cancelled or draft document. ' 
    + 'Partial settlement is allowed — the remainder stays outstanding. '
    + 'Does NOT cover: a real bank payment (apply_receipt_to_invoice / '
    + 'apply_payment_to_supplier_invoice), a credit note that reduces what is owed for a '
    + 'commercial reason (create_credit_note), or writing a debt off to bad debts, which is a '
    + 'policy decision rather than a settlement. '
    + 'Run with dry_run first: it reports the journal that would post and writes nothing.',
  scope: 'write:invoices',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      subledger: { type: 'string', enum: [...SUBLEDGERS], description: '"ar" for a customer invoice, "ap" for a supplier bill.' },
      document_id: { type: 'string', description: 'The customer invoice or supplier invoice UUID.' },
      contra_account_id: {
        type: 'string',
        description:
          'The BALANCE-SHEET account the debt is netted against (asset, liability or equity) — '
          + 'from list_gl_accounts. An expense or revenue account is refused: that is a write-off.',
      },
      amount: { type: 'number', exclusiveMinimum: 0, description: 'Amount settled, to the cent. Never more than the outstanding balance.' },
      reason: { type: 'string', description: 'Why this was netted rather than paid. Recorded on the payment document.' },
      settlement_date: { type: 'string', format: 'date', description: 'YYYY-MM-DD. Defaults to today. Must fall in an OPEN fiscal period.' },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['subledger', 'document_id', 'contra_account_id', 'amount', 'reason', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const subledger = strArg(args, 'subledger') as Subledger | undefined;
    if (!subledger || !SUBLEDGERS.includes(subledger)) {
      return toolError('subledger must be "ar" (customer invoice) or "ap" (supplier bill)');
    }
    const documentId = strArg(args, 'document_id');
    const contraAccountId = strArg(args, 'contra_account_id');
    const reason = strArg(args, 'reason');
    if (!documentId) return toolError('document_id is required');
    if (!contraAccountId) return toolError('contra_account_id is required');
    if (!reason) {
      return toolError(
        'reason is required — a contra settlement moves a debt without cash, and the record has '
        + 'to say why.',
      );
    }
    const bad = guardCastableArgs(args, {
      uuid: ['document_id', 'contra_account_id'],
      date: ['settlement_date'],
    });
    if (bad) return bad;

    const amount = Number(args.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return toolError('amount must be a positive number');
    }
    // Money is NUMERIC(15,2); a third decimal is rounded by Postgres and the
    // agent's arithmetic then silently disagrees with the ledger's.
    if (Math.round(amount * 100) !== amount * 100) {
      return toolError(`amount has more than two decimal places (${amount}) — amounts are stored to the cent.`);
    }
    const settlementDate = strArg(args, 'settlement_date') ?? fmtDate(new Date());

    // Every refusal is answered from READS, before the first write, so it can
    // be a toolError. Once createCustomerPayment / createSupplierPayment has
    // run, nothing below is caught: a returned refusal after a write frees the
    // idempotency key for a retry that settles the document twice.
    let contra;
    let document;
    let control;
    try {
      [contra, document, control] = await Promise.all([
        assertContraAccountUsable(ctx.companyId, subledger, contraAccountId),
        loadContraDocument(ctx.companyId, subledger, documentId, amount),
        getSystemAccount(subledger === 'ar' ? 'receivable' : 'payable', ctx.companyId),
      ]);
    } catch (err) {
      return toolError(safeErrorText(err, 'Could not settle this document by contra.'));
    }

    // DR contra / CR AR for a receivable; DR AP / CR contra for a payable.
    const debit = subledger === 'ar'
      ? { id: contra.accountId, code: contra.accountCode, name: contra.accountName }
      : { id: control.id, code: control.accountCode ?? '', name: control.accountName ?? '' };
    const credit = subledger === 'ar'
      ? { id: control.id, code: control.accountCode ?? '', name: control.accountName ?? '' }
      : { id: contra.accountId, code: contra.accountCode, name: contra.accountName };

    if (args.dry_run === true) {
      const result: DryRunResult = {
        dryRun: true,
        journals: [{
          date: settlementDate,
          description: `Contra settlement of ${document.documentNumber} — ${reason}`,
          fiscalPeriodId: null,
          lines: [
            { accountId: debit.id, accountCode: debit.code, accountName: debit.name, debit: amount, credit: 0 },
            { accountId: credit.id, accountCode: credit.code, accountName: credit.name, debit: 0, credit: amount },
          ],
          totalDebit: amount,
          totalCredit: amount,
        }],
        skipped: [],
        effects: [{
          entityType: subledger === 'ar' ? 'customer_invoice' : 'supplier_invoice',
          entityId: document.documentId,
          documentNumber: document.documentNumber,
          field: 'outstanding',
          before: document.outstanding,
          after: Math.round((document.outstanding - amount) * 100) / 100,
        }],
        journalsTotal: 1,
        truncated: false,
      };
      // wroteNothing keeps the idempotency key free — see CONTRACTS §6.
      return { ...ok(result), wroteNothing: true };
    }

    const postingAgent = mcpPostingAgent(TOOL);
    const description = `Contra settlement — ${reason}`;
    const settled = subledger === 'ar'
      ? await settleReceivable(ctx, {
        document, contraAccountId, amount, settlementDate, description, postingAgent,
      })
      : await settlePayable(ctx, {
        document, contraAccountId, amount, settlementDate, description, postingAgent,
      });

    return ok({
      subledger,
      document_id: document.documentId,
      document_number: document.documentNumber,
      settled_amount: amount,
      outstanding_before: document.outstanding,
      outstanding_after: Math.round((document.outstanding - amount) * 100) / 100,
      contra_account_id: contra.accountId,
      contra_account_code: contra.accountCode,
      contra_account_name: contra.accountName,
      journal: `DR ${debit.code} ${debit.name} / CR ${credit.code} ${credit.name}`,
      payment_id: settled.paymentId,
      payment_number: settled.paymentNumber,
      payment_method: 'contra',
      posted_journal_entry_id: settled.journalEntryId,
      reason,
    });
  },
};

interface SettleParams {
  document: Awaited<ReturnType<typeof loadContraDocument>>;
  contraAccountId: string;
  amount: number;
  settlementDate: string;
  description: string;
  postingAgent: string;
}

/**
 * DR contra / CR Accounts Receivable, via the same two service calls the UI
 * makes. `bankAccountId` is the contra account: `confirmCustomerPayment`
 * resolves its debit leg from that column with no subtype check, which is why
 * this composes rather than reimplements.
 */
async function settleReceivable(
  ctx: { companyId: string; userId: string },
  p: SettleParams,
) {
  const payment = await createCustomerPayment(ctx.companyId, {
    clientId: p.document.counterpartyId,
    paymentDate: p.settlementDate,
    totalAmount: p.amount,
    paymentMethod: 'contra',
    bankAccountId: p.contraAccountId,
    description: p.description,
    allocations: [{ invoiceId: p.document.documentId, amount: p.amount }],
  }, ctx.userId);

  const confirmed = await confirmCustomerPayment(ctx.companyId, payment.id, ctx.userId, {
    postingAgent: p.postingAgent,
  });
  return {
    paymentId: confirmed.id,
    paymentNumber: confirmed.paymentNumber,
    journalEntryId: confirmed.glJournalEntryId ?? null,
  };
}

/** DR Accounts Payable / CR contra, via createSupplierPayment → approve → process. */
async function settlePayable(
  ctx: { companyId: string; userId: string },
  p: SettleParams,
) {
  const payment = await createSupplierPayment(ctx.companyId, {
    supplierId: p.document.counterpartyId,
    paymentDate: p.settlementDate,
    totalAmount: p.amount,
    paymentMethod: 'contra',
    bankAccountId: p.contraAccountId,
    description: p.description,
    allocations: [{ invoiceId: p.document.documentId, amount: p.amount }],
  }, ctx.userId);

  await approveSupplierPayment(ctx.companyId, payment.id, ctx.userId);
  const processed = await processSupplierPayment(ctx.companyId, payment.id, ctx.userId, {
    postingAgent: p.postingAgent,
  });
  return {
    paymentId: processed.id,
    paymentNumber: processed.paymentNumber,
    journalEntryId: processed.glJournalEntryId ?? null,
  };
}

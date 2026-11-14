/**
 * MCP write tool: reallocate ONE reconciled bank line without reopening its reconciliation
 * (bank/bankReallocationService). The old allocation journal is reversed and a new one posted, both on the
 * original date; the line stays reconciled on the same reconciliation, its bank side unchanged.
 *
 * Arguments are parsed into the same `AllocationLine` allocate_bank_transaction uses, so the UUID casts, the
 * auto_apply gate, the "no dimensions on a payment" rule, tenant ownership, dimension resolution and the VAT guard
 * are the SAME functions (allocationLine.ts, allocationVatGuard.ts, dimensionArgs.ts) — no drifting copy.
 *
 * Every refusal after argument parsing is THROWN by the service (BankReallocationRefusal and the guards it shares
 * with allocate / reverse, all on REFUSAL_CODES): nothing here catches, so a refusal or a failure after the first
 * write reaches the registry's savepoint, which rolls it back and shows a coded refusal's own message. The dry run
 * runs the identical service call inside an always-rolled-back savepoint, so it meets every guard the live call
 * meets, and answers `wroteNothing` so the key stays free for the live call.
 */
import type { McpTool, McpToolResult } from '../types';
import { reallocateReconciledTransaction, type ReallocationResult } from '@/modules/accounting/services/bank/bankReallocationService';
import type { ReallocationTarget } from '@/modules/accounting/services/bank/bankReallocationGuards';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';
import { AUTO_APPLY_MODES } from '@/modules/accounting/services/shared/autoAllocateStrategy';
import { badUuidArg, checkLinesOwnership, parseAllocationLine, VAT_CODES, type AllocationLine } from './allocationLine';
import { resolveLineVatCode } from './allocationVatGuard';
import { attachLineDimensionIds, dimensionWarningsOrRefusal, DIMENSION_LINE_PROPERTIES } from './dimensionArgs';
import { mcpPostingOpts } from '../mcpActor';
import { ok, strArg, toolError } from './toolHelpers';

const NAME = 'reallocate_bank_transaction';
const TARGET_KEYS = ['gl_account_id', 'supplier_id', 'customer_id'] as const;
const TARGET_REFUSAL = 'target must name exactly one of gl_account_id, supplier_id or customer_id';

type Target = { line: AllocationLine; target: ReallocationTarget };

/** target + the allocation fields, as the AllocationLine allocate parses — or the refusal text. */
function parseTarget(args: Record<string, unknown>): Target | string {
  const t = args.target;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return `target is required: ${TARGET_REFUSAL}`;
  const obj = t as Record<string, unknown>;
  const named = TARGET_KEYS.filter((k) => obj[k] !== undefined);
  if (named.length !== 1 || Object.keys(obj).length !== 1) return TARGET_REFUSAL;
  const key = named[0]!;
  const badTarget = badUuidArg(obj, [key]);
  if (badTarget) return badTarget;
  if (typeof obj[key] !== 'string') return `invalid ${key}`;
  const id = (obj[key] as string).trim();
  if (args.vat_type !== undefined && !VAT_CODES.includes(args.vat_type as never)) {
    return `vat_type must be one of: ${VAT_CODES.join(', ')}`;
  }
  const line = parseAllocationLine({
    transaction_id: args.transaction_id,
    alloc_type: key === 'gl_account_id' ? 'account' : key === 'supplier_id' ? 'supplier' : 'customer',
    ...(key === 'gl_account_id' ? { contra_account_id: id } : { entity_id: id }),
    ...(args.vat_type === undefined ? {} : { vat_code: args.vat_type }),
    ...(args.auto_apply === undefined ? {} : { auto_apply: args.auto_apply }),
    ...(args.cc1 === undefined ? {} : { cc1: args.cc1 }),
    ...(args.cc2 === undefined ? {} : { cc2: args.cc2 }),
    ...(args.bu === undefined ? {} : { bu: args.bu }),
  });
  if (typeof line === 'string') return line;
  const target: ReallocationTarget = key === 'gl_account_id' ? { kind: 'account', glAccountId: id }
    : key === 'supplier_id' ? { kind: 'supplier', supplierId: id } : { kind: 'customer', customerId: id };
  return { line, target };
}

function answer(r: ReallocationResult, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    transaction_id: r.transactionId, reconciliation_id: r.reconciliationId, reconciliation_unchanged: true,
    original_journal_entry_id: r.originalJournalEntryId, reversal_journal_entry_id: r.reversalJournalEntryId,
    new_journal_entry_id: r.newJournalEntryId, entry_date: r.entryDate,
    bank_leg: { account_id: r.bankLeg.accountId, amount: r.bankLeg.amount, old_line_id: r.bankLeg.oldLineId,
      new_line_id: r.bankLeg.newLineId },
    unwound: { invoices_reopened: r.unwound.invoicesReopened, amount_unapplied: r.unwound.amountUnapplied,
      payments_cancelled: r.unwound.paymentsCancelled },
    new_document: { kind: r.newDocument.kind, payment_id: r.newDocument.paymentId },
    ...(r.application ? {
      auto_apply: r.application.autoApply,
      applications: r.application.applications.map((a) => ({ document_id: a.documentId, document_number: a.documentNumber, amount: a.amount })),
      on_account: r.application.onAccount,
    } : {}),
    ...(r.outcome === 'nothing_changed' ? { nothing_changed: true } : {}),
    ...extra,
  };
}

function wroteNothing(data: Record<string, unknown>): McpToolResult {
  const res = ok(data);
  res.wroteNothing = true;
  res.billable = false;
  return res;
}

export const reallocateBankTransactionTool: McpTool = {
  name: NAME,
  description:
    'Re-point a RECONCILED bank line (one in a COMPLETED bank reconciliation) to a different allocation target '
    + 'WITHOUT reopening the reconciliation: the old allocation journal is reversed and a new one posted, BOTH on the '
    + "ORIGINAL entry date, and the line stays reconciled on the same reconciliation with the same bank side and its "
    + 'reviewer kept — so the reconciliation and the bank balance as at every date are unchanged. '
    + 'target names exactly one of gl_account_id, supplier_id or customer_id. A supplier or customer target creates '
    + 'the payment / receipt / refund allocate_bank_transaction would (auto_apply "fifo", the default, settles the '
    + "contact's oldest open documents); the old one is cancelled and the bills/invoices it paid reopen. "
    + 'expected_journal_entry_id is the journal the line is reconciled to now (matchedJournalEntryId on a full '
    + 'list_bank_transactions row): a stale one is refused, naming the current one. REFUSED, nothing written: a line that is not reconciled (use '
    + 'reverse_bank_allocation then allocate_bank_transaction), one in an in-progress session or reconciled in the '
    + 'Sage import, a closed or locked fiscal period or a VAT-locked period on that date (the date is never moved), '
    + 'transfers, splits, payment batches, provisional lines, matched (not allocated) lines, journals with reversal '
    + 'history, an invoice target, a bank account as target, and a customer receipt whose on-account remainder a '
    + 'refund has already paid out (re-pointed to the SAME customer, judged on what the new receipt keeps after its '
    + 'auto_apply: refused only if a refund is left uncovered). The same target, VAT code and dimensions (and, for a contact, the same outcome '
    + 'of auto_apply) answers nothing_changed. On a gl_account_id target, omitting vat_type means NO VAT, as '
    + 'allocate_bank_transaction does — send vat_type to keep a VAT claim. A vat_type of standard on an account where '
    + 'no supply can arise is coerced as allocate does and reported in vat_coerced. dry_run is required: true runs the '
    + 'whole reallocation and rolls it back — every id it returns (journals, lines, payment) is rolled back and does '
    + 'not exist afterwards; false does it.',
  scope: 'write:bank-tx',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      transaction_id: { type: 'string', description: 'The reconciled bank transaction UUID.' },
      expected_journal_entry_id: { type: 'string', description: 'The journal the line is reconciled to now.' },
      target: {
        type: 'object',
        description: 'Exactly one of gl_account_id, supplier_id, customer_id.',
        properties: {
          gl_account_id: { type: 'string' }, supplier_id: { type: 'string' }, customer_id: { type: 'string' },
        },
        additionalProperties: false,
      },
      vat_type: { type: 'string', enum: [...VAT_CODES], description: 'For a gl_account_id target; a settlement carries none.' },
      ...DIMENSION_LINE_PROPERTIES,
      auto_apply: { type: 'string', enum: [...AUTO_APPLY_MODES], description: 'Supplier/customer targets: "fifo" (default) or "none".' },
      dry_run: { type: 'boolean', description: 'Required. true: run it and roll it back; false: reallocate.' },
      idempotency_key: { type: 'string' },
    },
    required: ['transaction_id', 'expected_journal_entry_id', 'target', 'dry_run', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    if (args.invoice_id !== undefined || args.bank_reference !== undefined) {
      return toolError('reallocate_bank_transaction takes transaction_id and a target account, supplier or customer; '
        + 'an invoice target is not supported (reallocate to the supplier or customer: auto_apply settles its oldest '
        + 'open documents).');
    }
    if (typeof args.transaction_id !== 'string' || !args.transaction_id.trim()) return toolError('transaction_id is required');
    const expected = strArg(args, 'expected_journal_entry_id');
    if (!expected) return toolError('expected_journal_entry_id is required: the journal the line is reconciled to now');
    const badId = badUuidArg(args, ['transaction_id', 'expected_journal_entry_id']);
    if (badId) return toolError(badId);
    const parsed = parseTarget(args);
    if (typeof parsed === 'string') return toolError(parsed);
    if (typeof args.dry_run !== 'boolean') {
      return toolError('dry_run is required: true runs the reallocation and rolls it back, false reallocates');
    }
    const { line, target } = parsed;
    const txId = (args.transaction_id as string).trim();

    const ownership = await checkLinesOwnership(ctx.companyId, [line]);
    if (ownership) return toolError(ownership);
    const dimRefusal = await attachLineDimensionIds(ctx.companyId, [line], () => 'reallocation');
    if (dimRefusal) return toolError(dimRefusal);
    const cos = target.kind === 'account'
      ? await dimensionWarningsOrRefusal(ctx.companyId,
        [{ glAccountId: target.glAccountId, cc2Id: line.dimIds?.cc2Id ?? null }], () => 'reallocation')
      : { warnings: [] };
    if (typeof cos === 'string') return toolError(cos);
    const { effectiveVatCode, vatCoerced } = await resolveLineVatCode(ctx.companyId, txId, line, NAME);

    const dryRun = args.dry_run === true;
    const run = () => reallocateReconciledTransaction(ctx.companyId, txId, ctx.userId, target, {
      ...mcpPostingOpts(ctx, NAME), expectedJournalEntryId: expected, autoApply: line.autoApply, dryRun,
      ...(effectiveVatCode === undefined ? {} : { vatType: effectiveVatCode }),
      ...(line.dimIds ? { dims: line.dimIds } : {}),
    });
    const extra = {
      ...(vatCoerced ? { vat_coerced: vatCoerced } : {}),
      ...(cos.warnings.length > 0 ? { dimension_warnings: cos.warnings } : {}),
    };
    // No try/catch from here: every throw must reach the registry's savepoint (see the header).
    if (dryRun) {
      let preview: ReallocationResult | null = null;
      await inRolledBackSavepoint('mcp_realloc_dry_run', async () => { preview = await run(); });
      if (preview === null) throw new Error('reallocate_bank_transaction dry run produced no result');
      return wroteNothing(answer(preview, { ...extra, dry_run: true }));
    }
    const result = await run();
    if (result.outcome === 'nothing_changed') return wroteNothing(answer(result, extra));
    return ok(answer(result, extra));
  },
};

/**
 * MCP read tool: `find_double_settlements` (step 6, 2026-11-13).
 *
 * Bills the AP subledger records as settled by more than it owes, or by two different kinds of settlement each
 * covering most of it — a contra AND a card line, a payment AND a credit note. The query, the settlement paths and
 * the classification rule are in `ap/doubleSettlementService.ts` and `ap/settlementKind.ts`.
 *
 * Offset-paged with `next_offset`, like list_supplier_payments; ordered on (invoice_date, id).
 */
import type { McpTool } from '../types';
import {
  MAX_SETTLEMENTS_PER_BILL,
  findDoubleSettlements,
  type DoubleSettledBill,
} from '@/modules/accounting/services/ap/doubleSettlementService';
import { clampLimit, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';
import { OFFSET_SCHEMA, nextOffsetFromTotal, parseOffset } from './pageArgs';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const findDoubleSettlementsTool: McpTool = {
  name: 'find_double_settlements',
  description:
    'Supplier bills settled more than once. Reports a bill when (a) its live settlements sum to more than its total '
    + '(over_settled); (b) its settlements cover the whole bill and, summed per kind, two kinds each cover at least '
    + 'half of it, one of them a contra or a card line (multiple_sources — the contra-plus-card-line pattern); or (c) '
    + 'its own amount_paid exceeds its total or its settlements by more than a cent (amount_paid_unexplained: paid by a '
    + 'bank match or an import that left no settlement row; cancelled bills excluded). '
    + 'A settlement is a processed/reconciled supplier payment allocated to the bill, or an approved supplier credit '
    + 'note applied to it. Each payment is classified: "contra" (payment_method contra, or its journal credits an '
    + 'account that is neither a bank/cash account nor one holding statement lines — a clearing or loan account), '
    + '"card_line" (it came from an imported statement line: a bank or paycard line is matched to its journal, or it '
    + 'settles a bank-first provisional), "unclassified" (it credits an account with no subtype and no statement lines), '
    + 'otherwise "payment"; credit notes are "credit_note". '
    + 'Per bill: bill_id, bill_number, supplier, total, amount_paid, settled_total, over_settled_by, reasons, and each '
    + 'settlement (kind, document id + number, date, amount, and — when the token also has read:reports — the account '
    + 'the payment credited). '
    + 'amount_paid is the bill\'s own column and can differ from settled_total where a bank match or an import set it '
    + 'without a settlement row. Filter by supplier_id and by the bill\'s invoice date (from / to). '
    + `Returns {bills, total, next_offset}: up to limit bills (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}); call again `
    + `with offset=next_offset until it is null. At most ${MAX_SETTLEMENTS_PER_BILL} settlements are listed per bill `
    + '(settlement_count is the full number). To undo a contra that double-settles a bill, see void_payment.',
  scope: 'read:invoices',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      supplier_id: { type: 'string', description: 'Supplier UUID (from list_suppliers)' },
      from: { type: 'string', format: 'date', description: 'Bills dated on or after, YYYY-MM-DD' },
      to: { type: 'string', format: 'date', description: 'Bills dated on or before, YYYY-MM-DD' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
      offset: OFFSET_SCHEMA,
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bad = guardCastableArgs(args, { uuid: ['supplier_id'], date: ['from', 'to'] });
    if (bad) return bad;
    const offset = parseOffset(args);
    if (typeof offset === 'string') return toolError(offset);
    const fromDate = strArg(args, 'from');
    const toDate = strArg(args, 'to');
    if (fromDate && toDate && fromDate > toDate) return toolError('from must not be after to');

    const result = await findDoubleSettlements(ctx.companyId, {
      supplierId: strArg(args, 'supplier_id') ?? null,
      fromDate: fromDate ?? null,
      toDate: toDate ?? null,
      limit: clampLimit(args, DEFAULT_LIMIT, MAX_LIMIT),
      offset,
    });
    // The chart's account names and codes are report data: only with read:reports (security review).
    const withAccounts = (ctx.scopes ?? []).includes('read:reports');
    return ok({
      bills: result.rows.map((b) => billReply(b, withAccounts)),
      total: result.total,
      next_offset: nextOffsetFromTotal(offset, result.rows.length, result.total),
    });
  },
};

function billReply(b: DoubleSettledBill, withAccounts: boolean) {
  return {
    bill_id: b.billId,
    bill_number: b.billNumber,
    invoice_date: b.invoiceDate,
    supplier_id: b.supplierId,
    supplier_name: b.supplierName,
    total: b.total,
    amount_paid: b.amountPaid,
    settled_total: b.settledTotal,
    over_settled_by: b.overSettledBy,
    reasons: b.reasons,
    settlement_count: b.settlementCount,
    settlements: b.settlements.map((s) => ({
      kind: s.kind,
      document_id: s.documentId,
      document_number: s.documentNumber,
      date: s.date,
      amount: s.amount,
      ...(withAccounts ? { account_id: s.accountId, account_code: s.accountCode, account_name: s.accountName } : {}),
      payment_method: s.paymentMethod,
    })),
  };
}

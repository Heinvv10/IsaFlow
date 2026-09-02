/**
 * MCP read tool: list_import_batches — the import audit trail. Answers "what
 * statements have landed, and can this batch still be undone?" before an
 * agent re-imports or calls undo_bank_import.
 */
import type { McpTool } from '../types';
import { listImportBatches } from '@/modules/accounting/services/bank/bankImportBatchQueryService';
import { clampLimit, guardCastableArgs, ok, strArg } from './toolHelpers';

export const listImportBatchesTool: McpTool = {
  name: 'list_import_batches',
  description:
    'Bank statement import batches for this company, newest first — one row per statement file that import_bank_statement (or the app) landed. ' +
    'Each row carries transaction_count (rows written at import time), transactions_remaining (rows still linked now — undo_bank_import removes unallocated ones) and transactions_allocated (remaining rows with a posted journal). ' +
    'A batch with transactions_allocated > 0 cannot be fully undone; reverse those allocations first. ' +
    'Filter by bank_account_id to see one account. Returns at most 100 rows (default 20); there is no cursor — narrow by account for a long history.',
  scope: 'read:bank-tx',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      bank_account_id: { type: 'string', description: 'gl_accounts.id of the bank account (optional).' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    // bank_account_id lands as $n::UUID.
    const bad = guardCastableArgs(args, { uuid: ['bank_account_id'] });
    if (bad) return bad;
    // Tenant from ctx ONLY; bank_account_id narrows a query already fenced to
    // the company, so a foreign id matches nothing and needs no ownership check.
    const batches = await listImportBatches(ctx.companyId, {
      bankAccountId: strArg(args, 'bank_account_id'),
      limit: clampLimit(args, 20, 100),
    });
    return ok({
      batches: batches.map((b) => ({
        id: b.id,
        bank_account_id: b.bankAccountId,
        statement_date: b.statementDate,
        bank_format: b.bankFormat,
        opening_balance: b.openingBalance,
        closing_balance: b.closingBalance,
        transaction_count: b.transactionCount,
        transactions_remaining: b.transactionsRemaining,
        transactions_allocated: b.transactionsAllocated,
        source_filename: b.sourceFilename,
        bulk_import_id: b.bulkImportId,
        created_at: b.createdAt,
      })),
      count: batches.length,
    });
  },
};

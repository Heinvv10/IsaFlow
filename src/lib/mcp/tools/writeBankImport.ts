/**
 * MCP write tools: import a bank statement / undo that import.
 *
 * These create bank transactions but POST NOTHING — the auto-post sweep is
 * suppressed in bankStatementImportService, so every agent-caused posting
 * still arrives through allocate_bank_transaction, which stamps mcp:* and is
 * reversible. That is why neither tool sets requiresPost.
 */
import type { McpTool } from '../types';
import {
  bankGlAccountBelongsToCompany,
  importStatementForAgent,
  undoImportBatch,
} from '@/modules/accounting/services/bank/bankStatementImportService';
import type { StatementFileType } from '@/modules/accounting/services/bank/bankStatementParseService';
import { StatementNotImportableError } from '@/modules/accounting/services/bank/bankStatementImportErrors';
import { checkRateLimit } from '@/lib/rateLimit';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

// inputSchema.enum is NOT enforced by the MCP transport — it is passed through
// to getManifest() only. This array is the actual runtime gate.
//
// 'pdf' is deliberately absent even though parseStatement supports it: base64
// inflates a scan well past the transport's body cap, and the agent produces
// OFX rather than scans. An unlisted value must be rejected, never coerced —
// parseStatement would otherwise fall through to its CSV branch and try to
// detect a bank format in an OFX document.
const FILE_TYPES = ['ofx', 'csv', 'qif', 'mt940'] as const;
type AgentFileType = (typeof FILE_TYPES)[number];

// A 1mb statement can insert thousands of rows. The transport's own limit
// (120 req/min per company) bounds request count but not write pressure;
// bank-transactions-bulk-commit caps its own commits at 60/hour for the same
// reason, so the agent path gets the same ceiling.
const IMPORT_MAX_PER_HOUR = 60;

// Undo can delete a batch as large as the import created, so it gets its own
// ceiling rather than relying on the transport's 120/min alone.
const UNDO_MAX_PER_HOUR = 60;

// Same runtime-gate reasoning as FILE_TYPES. 'unknown' is excluded: it is the
// parser's own "could not detect" sentinel, and passing it back in is treated
// as "no hint given" — accepting it as a caller value only invites confusion.
const BANK_FORMATS = [
  'fnb', 'standard_bank', 'nedbank', 'absa', 'capitec', 'ofx', 'qif', 'mt940',
] as const;
type AgentBankFormat = (typeof BANK_FORMATS)[number];

export const importBankStatementTool: McpTool = {
  name: 'import_bank_statement',
  description:
    'Import a bank statement (OFX, CSV, QIF or MT940) into a bank account. Transactions already present are skipped by a (date, amount, description) content hash, so re-sending the same statement is safe. Note the flip side: two genuinely separate transactions on the same day with the same amount and description hash alike, and the second will be skipped as a duplicate — reconcile the closing balance after importing rather than trusting the row count. Creates transactions only: it posts no journals and does not touch transactions it did not create. Allocate afterwards with allocate_bank_transaction. Use dry_run to see what would land before writing.',
  scope: 'write:bank-tx',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      bank_account_id: { type: 'string' },
      file_type: { type: 'string', enum: [...FILE_TYPES] },
      content: { type: 'string', description: 'Raw statement text.' },
      statement_date: { type: 'string', description: 'YYYY-MM-DD — the statement closing date.' },
      bank_format: {
        type: 'string',
        enum: [...BANK_FORMATS],
        description: 'Optional hint (e.g. "fnb", "absa") when CSV auto-detection fails.',
      },
      dry_run: {
        type: 'boolean',
        description: 'Parse and report new/duplicate counts without writing anything.',
      },
      idempotency_key: { type: 'string' },
    },
    required: ['bank_account_id', 'file_type', 'content', 'statement_date', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bankAccountId = strArg(args, 'bank_account_id');
    const content = strArg(args, 'content');
    const statementDate = strArg(args, 'statement_date');
    const rawFileType = args.file_type;

    if (!bankAccountId) return toolError('bank_account_id is required');
    if (typeof rawFileType !== 'string' || !FILE_TYPES.includes(rawFileType as AgentFileType)) {
      return toolError(`file_type must be one of: ${FILE_TYPES.join(', ')}`);
    }
    if (!content) return toolError('content is required');

    const rawBankFormat = strArg(args, 'bank_format');
    if (rawBankFormat !== undefined && !BANK_FORMATS.includes(rawBankFormat as AgentBankFormat)) {
      return toolError(`bank_format must be one of: ${BANK_FORMATS.join(', ')}`);
    }
    // bank_import_batches.statement_date is NOT NULL — without it the insert
    // fails inside the transaction after parsing has already been paid for.
    if (!statementDate) return toolError('statement_date is required (YYYY-MM-DD)');
    const badArg = guardCastableArgs(args, {
      uuid: ['bank_account_id'],
      date: ['statement_date'],
    });
    if (badArg) return badArg;

    // Ownership. Nothing downstream re-checks the tenant: importParsedTransactions
    // writes whatever bank_account_id it is handed, and migration 446 dropped the
    // FK on bank_import_batches, so a foreign id would land this company's
    // statement in another tenant's account. The error text is deliberately
    // identical to a genuine miss — a distinguishable reply would turn the tool
    // into an existence oracle for accounts the caller cannot read.
    if (!(await bankGlAccountBelongsToCompany(ctx.companyId, bankAccountId))) {
      return toolError(NOT_FOUND);
    }

    if (!(await checkRateLimit(`mcp-bank-import:${ctx.companyId}`, {
      max: IMPORT_MAX_PER_HOUR, windowSecs: 3600,
    }))) {
      return toolError('Import rate limit reached — try again later.');
    }

    try {
      const result = await importStatementForAgent({
        companyId: ctx.companyId,                                  // tenant from ctx ONLY
        bankAccountId,
        fileType: rawFileType as StatementFileType,
        content,
        statementDate,
        bankFormat: rawBankFormat as AgentBankFormat | undefined,  // validated above
        dryRun: args.dry_run === true,
        importedBy: 'mcp:import_bank_statement:v1',
        sourceFilename: 'mcp-import',
      });

      const envelope = ok({
        batch_id: result.batchId,
        dry_run: args.dry_run === true,
        imported: result.imported,
        duplicates: result.duplicates,
        date_range: result.dateRange,
        net_total: result.netTotal,
        parse_errors: result.parseErrors,
      });
      // Nothing was written — every row was already present. The description
      // tells the agent re-sending is safe, so it must also be free; charging
      // for a no-op would contradict the dry_run rule directly above it.
      if (result.batchId === null) envelope.billable = false;
      // A dry run wrote nothing, so it must not occupy the idempotency key —
      // the real import that follows would otherwise be served this preview.
      // Note this is NOT extended to the all-duplicates case above: that one
      // opened no batch but still ran the import path, and freeing its key
      // would let a retry race a concurrent import of the same statement.
      if (args.dry_run === true) envelope.wroteNothing = true;
      return envelope;
    } catch (err) {
      // Pre-write only. StatementNotImportableError is raised while parsing,
      // before importParsedTransactions writes anything, so it is safe to
      // report precisely.
      //
      // NOTE on what the rethrow does and does NOT buy here. Unlike
      // create_draft_invoice/quote below, the import itself is already atomic:
      // importParsedTransactions (bankImportService.ts) wraps the batch row and
      // every bank_transactions insert in withTransaction. So there is no
      // partial-import exposure to close.
      //
      // And the registry's savepoint could not close one anyway — withTransaction
      // takes a SEPARATE pooled connection with its own BEGIN/COMMIT, while the
      // savepoint acts on the ALS-bound request connection. Anything committed
      // there is beyond ROLLBACK TO SAVEPOINT. Do not add a write after this
      // call assuming the outer savepoint protects it; it does not.
      //
      // The rethrow is kept because a database failure should be recorded by the
      // registry as a failed call (status='error', debit refunded) rather than
      // dressed up as a tidy tool error.
      if (err instanceof StatementNotImportableError) return toolError(err.message);
      throw err;
    }
  },
};

export const undoBankImportTool: McpTool = {
  name: 'undo_bank_import',
  description:
    'Undo an import batch by deleting its transactions. Only transactions still in "imported" status are removed; anything further along is left untouched and reported in refused_by_status. Rows refused as "allocated" can be freed with reverse_bank_allocation; rows that are matched, reconciled or excluded need handling in the UI first.',
  scope: 'write:bank-tx',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      batch_id: { type: 'string' },
      idempotency_key: { type: 'string' },
    },
    required: ['batch_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const batchId = strArg(args, 'batch_id');
    if (!batchId) return toolError('batch_id is required');
    const bad = guardCastableArgs(args, { uuid: ['batch_id'] });
    if (bad) return bad;

    if (!(await checkRateLimit(`mcp-bank-undo:${ctx.companyId}`, {
      max: UNDO_MAX_PER_HOUR, windowSecs: 3600,
    }))) {
      return toolError('Undo rate limit reached — try again later.');
    }

    // No catch: undoImportBatch DELETEs transactions, so a failure partway
    // through has already removed rows. Returned as a tool error that write
    // survives (the registry's savepoint only rolls back on a throw) and, since
    // a refusal is audited with a NULL idempotency key, the retry deletes again
    // from a half-undone batch. The not-found case is a return value, not an
    // exception, so it stays a precise refusal.
    const result = await undoImportBatch(ctx.companyId, batchId);  // tenant from ctx ONLY
    if (result === null) return toolError(NOT_FOUND);
    return ok({
      batch_id: batchId,
      deleted: result.deleted,
      refused: result.refused,
      refused_by_status: result.refusedByStatus,
    });
  },
};

/**
 * PRD-060: FibreFlow Accounting Module — Phase 4
 * Bank Import Service — statement import and persistence
 */

import { transaction, sql, withTransaction } from '@/lib/neon';
import { log } from '@/lib/logger';
import { sweep } from './autoPostGateService';
import { detectBankFormat } from '../../utils/bankCsvParsers';
import { parseStatement, type StatementFileType } from './bankStatementParseService';
import type { BankFormat, BankCsvParseResult } from '../../types/bank.types';
import { autoLinkImportedBatchTransfers, relinkTransferCounterparts } from './bankTransferLinkService';

export interface BulkImportContext {
  bulkImportId: string;
  bulkSequence: number;
  sourceFilename: string;
  sourceFileSizeBytes: number;
}

export async function importBankStatement(
  companyId: string,
  csvContent: string,
  bankAccountId: string,
  _statementDate: string,
  bankFormat?: BankFormat
): Promise<{ batchId: string; transactionCount: number; errors: Array<{ row: number; error: string }> }> {
  try {
    // Through `parseStatement` rather than calling the parsers directly, so this
    // entry point inherits the same guard: a file that HAS rows and yielded no
    // transaction is refused instead of returning a clean `{transactionCount: 0}`,
    // which told a user who picked the wrong file type that the statement was in.
    // A genuinely empty period still returns 0 rows.
    const format = bankFormat && bankFormat !== 'unknown' ? bankFormat : detectBankFormat(csvContent);
    const fileType: StatementFileType =
      format === 'ofx' ? 'ofx' : format === 'qif' ? 'qif' : format === 'mt940' ? 'mt940' : 'csv';
    const parseResult = await parseStatement({ fileType, csvContent, bankFormat: format });

    if (parseResult.transactions.length === 0) {
      return { batchId: '', transactionCount: 0, errors: parseResult.errors };
    }

    const batchId = crypto.randomUUID();

    await transaction((txSql) =>
      parseResult.transactions.map(tx => txSql`
        INSERT INTO bank_transactions (
          company_id, bank_account_id, transaction_date, value_date, amount,
          description, reference, import_batch_id
        ) VALUES (
          ${companyId}::UUID, ${bankAccountId}::UUID, ${tx.transactionDate}, ${tx.valueDate || null},
          ${tx.amount}, ${tx.description}, ${tx.reference || null}, ${batchId}::UUID
        )
      `)
    );

    log.info('Imported bank statement', {
      batchId, format, count: parseResult.transactions.length,
    }, 'accounting');

    // Auto-provisional posting for outflows (best-effort — failures are swallowed)
    try {
      const outflowIds = (await sql`
        SELECT id FROM bank_transactions
        WHERE company_id = ${companyId}::UUID
          AND import_batch_id = ${batchId}::UUID
          AND amount < 0
          AND status = 'imported'
      `) as { id: string }[];
      if (outflowIds.length > 0) {
        const systemUser = '00000000-0000-0000-0000-000000000000';
        await sweep(companyId, outflowIds.map((r) => String(r.id)), 'import', systemUser);
      }
    } catch (provErr) {
      log.warn('auto-post sweep failed after import — non-fatal', { batchId, error: provErr }, 'accounting');
    }

    return {
      batchId,
      transactionCount: parseResult.transactions.length,
      errors: parseResult.errors,
    };
  } catch (err) {
    log.error('Failed to import bank statement', { error: err }, 'accounting');
    throw err;
  }
}

/**
 * Persist an already-parsed set of transactions (e.g. from a PDF import).
 *
 * Writes a `bank_import_batches` row + N `bank_transactions` rows in one
 * DB transaction. The batch row carries audit metadata (filename, format,
 * statement date, optional bulk-import grouping); the transaction rows
 * point back via `import_batch_id`.
 *
 * Optional `bulkContext` ties this batch into a bulk-import session so
 * the UI can later list/rollback all files imported together.
 */
export async function importParsedTransactions(
  companyId: string,
  parseResult: BankCsvParseResult,
  bankAccountId: string,
  statementDate: string,
  options: {
    sourceFilename?: string;
    importedBy?: string;
    bulkContext?: BulkImportContext;
    /**
     * Insert the batch and its rows, then stop — skip every post-insert side
     * effect below. Set by the agent import path, for two reasons:
     *
     * 1. sweep() attributes its postings to the system user, so an agent
     *    import would create journals that never appear in
     *    list_agent_postings and cannot be undone via the agent-activity
     *    surface. Agent postings arrive through allocate_bank_transaction.
     * 2. The two transfer auto-link passes are NOT batch-scoped — the second
     *    one matches on bank_account_id + status='imported' alone — so they
     *    flip PRE-EXISTING rows the import never created to 'allocated',
     *    stamping matched_journal_line_id from someone else's transfer
     *    journal. An agent later "freeing" such a row with
     *    reverse_bank_allocation would reverse a legitimate journal.
     *
     * The UI path leaves this unset and keeps all three behaviours.
     */
    skipPostImportEffects?: boolean;
  } = {},
): Promise<{ batchId: string; transactionCount: number; errors: Array<{ row: number; error: string }> }> {
  try {
    if (parseResult.transactions.length === 0) {
      return { batchId: '', transactionCount: 0, errors: parseResult.errors };
    }

    const batchId = crypto.randomUUID();
    const sourceFilename = options.bulkContext?.sourceFilename ?? options.sourceFilename ?? null;
    const sourceFileSizeBytes = options.bulkContext?.sourceFileSizeBytes ?? null;
    const bulkImportId = options.bulkContext?.bulkImportId ?? null;
    const bulkSequence = options.bulkContext?.bulkSequence ?? null;
    const importedBy = options.importedBy ?? null;
    const bankFormat = parseResult.bankFormat ?? null;

    await withTransaction(async (tx) => {
      await tx`
        INSERT INTO bank_import_batches (
          id, company_id, bank_account_id, statement_date, bank_format,
          transaction_count, source_filename, imported_by,
          bulk_import_id, bulk_sequence, source_file_size_bytes
        ) VALUES (
          ${batchId}::UUID, ${companyId}::UUID, ${bankAccountId}::UUID,
          ${statementDate}::DATE, ${bankFormat},
          ${parseResult.transactions.length}, ${sourceFilename}, ${importedBy},
          ${bulkImportId}, ${bulkSequence}, ${sourceFileSizeBytes}
        )
      `;
      for (const txRow of parseResult.transactions) {
        await tx`
          INSERT INTO bank_transactions (
            company_id, bank_account_id, transaction_date, value_date, amount,
            description, reference, import_batch_id
          ) VALUES (
            ${companyId}::UUID, ${bankAccountId}::UUID, ${txRow.transactionDate},
            ${txRow.valueDate || null}, ${txRow.amount}, ${txRow.description},
            ${txRow.reference || null}, ${batchId}::UUID
          )
        `;
      }
    });

    log.info('Imported parsed bank statement', {
      batchId,
      format: bankFormat,
      count: parseResult.transactions.length,
      statementDate,
      bulkImportId,
    }, 'accounting');

    // Everything below mutates rows or posts — see skipPostImportEffects.
    if (options.skipPostImportEffects) {
      return {
        batchId,
        transactionCount: parseResult.transactions.length,
        errors: parseResult.errors,
      };
    }

    // Auto-link newly imported transactions that are the opposite leg of an
    // existing transfer allocation on another bank account (same company).
    // The pass lives in bankTransferLinkService with the broader one below:
    // both must honour one-bank-line-per-GL-movement and both must run inside
    // a savepoint, and keeping two copies of that SQL here is what let this
    // one keep the defect the other had fixed.
    const batchLink = await autoLinkImportedBatchTransfers(companyId, batchId);

    // Broader re-link pass: catches account-type allocations to bank GL accounts
    // (e.g. user allocated the other leg as 'Account' rather than 'Transfer')
    const accountLink = await relinkTransferCounterparts(companyId, bankAccountId);

    // Both passes swallow their error to keep the import non-fatal. Reporting a
    // clean import when the transfer linking failed outright is what left the
    // failure visible only in a log line, so it joins the import's own errors.
    const linkErrors = batchLink.failed || accountLink.failed
      ? [{ row: 0, error: 'Transfer counterpart linking failed — transfers may still show as unallocated. Re-link from the bank transactions page.' }]
      : [];

    // Auto-provisional posting for outflows (best-effort)
    try {
      const outflowIds = (await sql`
        SELECT id FROM bank_transactions
        WHERE company_id = ${companyId}::UUID
          AND import_batch_id = ${batchId}::UUID
          AND amount < 0
          AND status = 'imported'
      `) as { id: string }[];
      if (outflowIds.length > 0) {
        const systemUser = '00000000-0000-0000-0000-000000000000';
        await sweep(companyId, outflowIds.map((r) => String(r.id)), 'import', systemUser);
      }
    } catch (provErr) {
      log.warn('auto-post sweep failed after parsed import — non-fatal', { batchId, error: provErr }, 'accounting');
    }

    return {
      batchId,
      transactionCount: parseResult.transactions.length,
      errors: [...parseResult.errors, ...linkErrors],
    };
  } catch (err) {
    log.error('Failed to import parsed bank transactions', { error: err }, 'accounting');
    throw err;
  }
}

/**
 * PRD-060: FibreFlow Accounting Module — Phase 4
 * Bank Import Service — statement import and persistence
 */

import { transaction, sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { autoProvisionalBatch } from '../capture/provisionalPostingService';
import {
  detectBankFormat,
  parseFNBStatement,
  parseStandardBankStatement,
  parseNedbankStatement,
  parseABSAStatement,
  parseCapitecStatement,
} from '../../utils/bankCsvParsers';
import { parseOfxStatement } from '../../utils/bankOfxParser';
import { parseQifStatement } from '../../utils/bankQifParser';
import type { BankFormat, BankCsvParseResult } from '../../types/bank.types';

export async function importBankStatement(
  companyId: string,
  csvContent: string,
  bankAccountId: string,
  statementDate: string,
  bankFormat?: BankFormat
): Promise<{ batchId: string; transactionCount: number; errors: Array<{ row: number; error: string }> }> {
  try {
    const format = bankFormat && bankFormat !== 'unknown' ? bankFormat : detectBankFormat(csvContent);
    let parseResult;

    switch (format) {
      case 'fnb':
        parseResult = parseFNBStatement(csvContent);
        break;
      case 'standard_bank':
        parseResult = parseStandardBankStatement(csvContent);
        break;
      case 'nedbank':
        parseResult = parseNedbankStatement(csvContent);
        break;
      case 'absa':
        parseResult = parseABSAStatement(csvContent);
        break;
      case 'capitec':
        parseResult = parseCapitecStatement(csvContent);
        break;
      case 'ofx':
        parseResult = parseOfxStatement(csvContent);
        break;
      case 'qif':
        parseResult = parseQifStatement(csvContent);
        break;
      default:
        throw new Error('Unable to detect bank format. Please specify the bank.');
    }

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
        await autoProvisionalBatch(companyId, outflowIds.map((r) => String(r.id)), systemUser);
      }
    } catch (provErr) {
      log.warn('autoProvisionalBatch failed after import — non-fatal', { batchId, error: provErr }, 'accounting');
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
 * Reuses the same INSERT logic as importBankStatement so behaviour is identical.
 */
export async function importParsedTransactions(
  companyId: string,
  parseResult: BankCsvParseResult,
  bankAccountId: string,
  statementDate: string,
): Promise<{ batchId: string; transactionCount: number; errors: Array<{ row: number; error: string }> }> {
  try {
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

    log.info('Imported parsed bank statement', {
      batchId,
      format: parseResult.bankFormat,
      count: parseResult.transactions.length,
      statementDate,
    }, 'accounting');

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
        await autoProvisionalBatch(companyId, outflowIds.map((r) => String(r.id)), systemUser);
      }
    } catch (provErr) {
      log.warn('autoProvisionalBatch failed after parsed import — non-fatal', { batchId, error: provErr }, 'accounting');
    }

    return {
      batchId,
      transactionCount: parseResult.transactions.length,
      errors: parseResult.errors,
    };
  } catch (err) {
    log.error('Failed to import parsed bank transactions', { error: err }, 'accounting');
    throw err;
  }
}

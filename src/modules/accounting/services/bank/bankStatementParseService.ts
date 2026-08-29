/**
 * Bank statement parse dispatcher — shared by the preview + commit endpoints.
 *
 * Takes the raw request body (PDF base64 or CSV/OFX/QIF text) and returns
 * a BankCsvParseResult by routing to the correct parser. No DB side
 * effects — callers do the persistence themselves.
 */

import { parseBankPdf } from '../../utils/bankPdfParser';
import {
  detectBankFormat,
  parseFNBStatement,
  parseStandardBankStatement,
  parseNedbankStatement,
  parseABSAStatement,
  parseCapitecStatement,
  parseGenericStatement,
} from '../../utils/bankCsvParsers';
import { parseOfxStatement } from '../../utils/bankOfxParser';
import { parseQifStatement } from '../../utils/bankQifParser';
import { parseMt940Statement } from '../../utils/bankMt940Parser';
import type { BankCsvParseResult, BankFormat } from '../../types/bank.types';
import { StatementNotImportableError } from './bankStatementImportErrors';

export type StatementFileType = 'pdf' | 'csv' | 'ofx' | 'qif' | 'mt940';

export interface ParseStatementArgs {
  fileType: StatementFileType;
  /** Required when fileType === 'pdf'. Optional `data:application/pdf;base64,` prefix is stripped. */
  pdfBase64?: string;
  /** Required for 'csv' | 'ofx' | 'qif' | 'mt940'. */
  csvContent?: string;
  /** Optional hint when auto-detect fails. */
  bankFormat?: BankFormat;
}

/**
 * Parse a bank statement from request body args.
 *
 * Throws on missing required fields and on unrecognisable bank formats.
 * The returned BankCsvParseResult contains parser-detected metadata like
 * accountNumber (PDFs only) which downstream code uses for auto-match.
 */
export async function parseStatement(args: ParseStatementArgs): Promise<BankCsvParseResult> {
  const { fileType, pdfBase64, csvContent, bankFormat } = args;

  if (fileType === 'pdf') {
    if (!pdfBase64) throw new Error('pdfBase64 is required for PDF imports');
    const base64Data = pdfBase64.includes(',') ? pdfBase64.split(',')[1]! : pdfBase64;
    const pdfBuffer = Buffer.from(base64Data, 'base64');
    return await parseBankPdf(pdfBuffer, bankFormat);
  }

  if (!csvContent) {
    throw new Error('csvContent is required for CSV / OFX / QIF / MT940 imports');
  }

  if (fileType === 'ofx') return parseOfxStatement(csvContent);
  if (fileType === 'qif') return parseQifStatement(csvContent);
  if (fileType === 'mt940') return parseMt940Statement(csvContent);

  // CSV path with bank-format dispatch.
  const format = bankFormat && bankFormat !== 'unknown' ? bankFormat : detectBankFormat(csvContent);
  switch (format) {
    case 'fnb':           return requireTransactions(parseFNBStatement(csvContent), format, csvContent);
    case 'standard_bank': return requireTransactions(parseStandardBankStatement(csvContent), format, csvContent);
    case 'nedbank':       return requireTransactions(parseNedbankStatement(csvContent), format, csvContent);
    case 'absa':          return requireTransactions(parseABSAStatement(csvContent), format, csvContent);
    case 'capitec':       return requireTransactions(parseCapitecStatement(csvContent), format, csvContent);
    case 'generic':       return requireTransactions(parseGenericStatement(csvContent), format, csvContent);
    default:
      throw new Error('Unable to detect bank format. Please specify the bank.');
  }
}

/**
 * A file with rows in it that yielded no transactions is a failed import, not
 * an empty one.
 *
 * Every CSV parser here returns `{transactions: [], errors: []}` rather than
 * throwing when the file's columns are not the ones it expects — correct for a
 * parser, wrong for an import: naming the wrong bank produced a clean
 * "imported 0 transactions", so a user who guessed wrong believed the statement
 * was in.
 *
 * A file with NO data rows is a different thing and still succeeds: a bank
 * really can export a period in which nothing happened, and refusing that would
 * trade one misleading success for a misleading failure. Only a file that HAS
 * rows and produced nothing from them is refused.
 *
 * Known edge: an export whose header sits below title lines and carries no data
 * rows is counted as having rows and is refused. The message says what to check,
 * and this direction is the safer one to be wrong in — a refusal is visible,
 * whereas the silent empty import it replaces was not.
 *
 * Raised as StatementNotImportableError, not a bare Error, because the MCP
 * import tool rethrows anything else (writeBankImport.ts) — which records the
 * call as a system failure and refunds the debit, when what actually happened is
 * an actionable problem with the file the agent sent.
 */
function requireTransactions(
  result: BankCsvParseResult,
  format: BankFormat,
  csv: string,
): BankCsvParseResult {
  if (result.transactions.length > 0) return result;
  if (!hasDataRows(csv)) return result;
  const detail = result.errors.length > 0
    ? ` Row errors: ${result.errors.slice(0, 3).map(e => `row ${e.row}: ${e.error}`).join('; ')}`
      + (result.errors.length > 3 ? ` (and ${result.errors.length - 3} more)` : '')
    : ` No row matched the columns a ${format} statement is expected to have.`
      + ' Check that the file is really from this bank, or re-export it.';
  throw new StatementNotImportableError(
    `Parsed no transactions from this statement.${detail}`,
  );
}

/**
 * Does the file carry anything below its header at all?
 *
 * One non-blank line is a header and nothing else — the empty-period export.
 * Counting lines rather than parsed rows is deliberate: the parsers cannot
 * answer this, because a parser that failed to map the header returns the same
 * empty result whether the file had two rows or two thousand.
 */
function hasDataRows(csv: string): boolean {
  return csv.split('\n').filter(l => l.trim() !== '').length > 1;
}

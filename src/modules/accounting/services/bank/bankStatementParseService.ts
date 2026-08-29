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
    case 'fnb':           return requireTransactions(parseFNBStatement(csvContent), format);
    case 'standard_bank': return requireTransactions(parseStandardBankStatement(csvContent), format);
    case 'nedbank':       return requireTransactions(parseNedbankStatement(csvContent), format);
    case 'absa':          return requireTransactions(parseABSAStatement(csvContent), format);
    case 'capitec':       return requireTransactions(parseCapitecStatement(csvContent), format);
    case 'generic':       return requireTransactions(parseGenericStatement(csvContent), format);
    default:
      throw new Error('Unable to detect bank format. Please specify the bank.');
  }
}

/**
 * A statement that yielded no transactions is a failed import, not an empty one.
 *
 * Every CSV parser here returns `{transactions: [], errors: []}` rather than
 * throwing when the file's columns are not the ones it expects — which is
 * correct for a parser and wrong for an import: naming the wrong bank produced
 * a clean "imported 0 transactions" instead of an error, so a user who guessed
 * wrong at the format believed the statement was in. The row errors are carried
 * into the message when there are any, because "no transactions" alone does not
 * say whether the layout was wrong or the rows were.
 */
function requireTransactions(result: BankCsvParseResult, format: BankFormat): BankCsvParseResult {
  if (result.transactions.length > 0) return result;
  const detail = result.errors.length > 0
    ? ` Row errors: ${result.errors.slice(0, 3).map(e => `row ${e.row}: ${e.error}`).join('; ')}`
      + (result.errors.length > 3 ? ` (and ${result.errors.length - 3} more)` : '')
    : ' No rows matched the expected columns — check that the file is really a'
      + ` ${format} statement.`;
  throw new Error(`Parsed no transactions from this statement.${detail}`);
}

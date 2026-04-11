/**
 * Bank statement parse dispatcher — shared by the preview + commit endpoints.
 *
 * Takes the raw request body (PDF base64 or CSV/OFX/QIF text) and returns
 * a BankCsvParseResult by routing to the correct parser. No DB side
 * effects — callers do the persistence themselves.
 */

import { parseBankPdf } from '../utils/bankPdfParser';
import {
  detectBankFormat,
  parseFNBStatement,
  parseStandardBankStatement,
  parseNedbankStatement,
  parseABSAStatement,
  parseCapitecStatement,
} from '../utils/bankCsvParsers';
import { parseOfxStatement } from '../utils/bankOfxParser';
import { parseQifStatement } from '../utils/bankQifParser';
import type { BankCsvParseResult, BankFormat } from '../types/bank.types';

export type StatementFileType = 'pdf' | 'csv' | 'ofx' | 'qif';

export interface ParseStatementArgs {
  fileType: StatementFileType;
  /** Required when fileType === 'pdf'. Optional `data:application/pdf;base64,` prefix is stripped. */
  pdfBase64?: string;
  /** Required for 'csv' | 'ofx' | 'qif'. */
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
    throw new Error('csvContent is required for CSV / OFX / QIF imports');
  }

  if (fileType === 'ofx') return parseOfxStatement(csvContent);
  if (fileType === 'qif') return parseQifStatement(csvContent);

  // CSV path with bank-format dispatch.
  const format = bankFormat && bankFormat !== 'unknown' ? bankFormat : detectBankFormat(csvContent);
  switch (format) {
    case 'fnb':           return parseFNBStatement(csvContent);
    case 'standard_bank': return parseStandardBankStatement(csvContent);
    case 'nedbank':       return parseNedbankStatement(csvContent);
    case 'absa':          return parseABSAStatement(csvContent);
    case 'capitec':       return parseCapitecStatement(csvContent);
    default:
      throw new Error('Unable to detect bank format. Please specify the bank.');
  }
}

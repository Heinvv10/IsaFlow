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

  // Through the same guard as the CSV arms below. All three of these parsers
  // return `{transactions: [], errors: []}` rather than throwing when the body
  // is not the shape they expect, so a user who picked the wrong file type got
  // the clean "imported 0 transactions" requireTransactions exists to stop.
  if (fileType === 'ofx') return requireTransactions(parseOfxStatement(csvContent), 'ofx', csvContent);
  if (fileType === 'qif') return requireTransactions(parseQifStatement(csvContent), 'qif', csvContent);
  if (fileType === 'mt940') return requireTransactions(parseMt940Statement(csvContent), 'mt940', csvContent);

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
 * Every parser here — CSV, OFX, QIF and MT940 alike — returns
 * `{transactions: [], errors: []}` rather than throwing when the file is not
 * the shape it expects — correct for a parser, wrong for an import: naming the
 * wrong bank, or picking the wrong file type, produced a clean
 * "imported 0 transactions", so a user who guessed wrong believed the statement
 * was in.
 *
 * A file with NO data rows is a different thing and still succeeds: a bank
 * really can export a period in which nothing happened, and refusing that would
 * trade one misleading success for a misleading failure. Only a file that HAS
 * rows and produced nothing from them is refused.
 *
 * `hasDataRows` alone answers that for CSV, where an empty period really is one
 * header line. OFX, QIF and MT940 all carry a multi-line envelope even with no
 * transaction in it, so the line count says "has rows" for every empty-period
 * export in those three formats — `isEmptyPeriodEnvelope` is what keeps the
 * guard one-sided for them.
 *
 * Known edge: a CSV whose header sits below title lines and carries no data
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
  if (isEmptyPeriodEnvelope(format, csv)) return result;
  const detail = result.errors.length > 0
    ? ` Row errors: ${result.errors.slice(0, 3).map(e => `row ${e.row}: ${e.error}`).join('; ')}`
      + (result.errors.length > 3 ? ` (and ${result.errors.length - 3} more)` : '')
    : ` Nothing in it was readable as a ${format} statement.`
      + ' Check that the file is really in that format and from this bank, or re-export it.';
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

/**
 * Did this file bring its format's own envelope but no transaction record?
 *
 * That is an empty period, not an unreadable file — the same case a one-line
 * CSV represents. Refusing it told the user to check that the file "is really
 * in that format", which is wrong advice for a file that plainly is.
 *
 * Only the envelope marker counts as proof of format. A body carrying neither
 * envelope nor record is still refused: that is the wrong-file-type case the
 * guard exists for.
 */
function isEmptyPeriodEnvelope(format: BankFormat, body: string): boolean {
  if (format === 'ofx') {
    return /<BANKTRANLIST\b/i.test(body) && !/<STMTTRN\b/i.test(body);
  }
  if (format === 'qif') {
    // A QIF with a type header and no `^` terminator has declared itself a QIF
    // and delivered no records; the parser reports exactly that.
    //
    // The `^` test alone is not enough: a file carrying real records whose
    // FINAL terminator is missing has no `^` either, and would import silently
    // as zero rows — the misleading success this guard exists to stop. `D`
    // (date) and `T` (amount) open every transaction record, so their absence
    // is what makes "no records" true rather than merely unterminated.
    return /^\s*!Type:/im.test(body) && !/\^/.test(body) && !/^[DT]/m.test(body);
  }
  if (format === 'mt940') {
    // :20: opens the statement, :61: is the statement line. An account with no
    // movement still gets :20:/:25:/:60F:/:62F:.
    return /^:20:/m.test(body) && !/^:61:/m.test(body);
  }
  return false;
}

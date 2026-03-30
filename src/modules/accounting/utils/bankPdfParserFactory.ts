/**
 * WS-8.2: Bank PDF Parser Factory
 *
 * Auto-detects the bank from extracted PDF text and routes to the
 * correct bank-specific parser. All parsers receive plain TEXT (not PDF
 * binary) — PDF extraction is done upstream by bankPdfParser.ts.
 *
 * Detection order matters: more specific strings are checked first to
 * avoid false positives (e.g. "Standard Bank" before generic "bank").
 */

import { log } from '@/lib/logger';
import type { BankCsvParseResult } from '../types/bank.types';
import { parseFnbStatement } from './bankPdfParserFnb';
import { parseStandardBankStatement } from './bankPdfParserStandardBank';
import { parseNedbankStatement } from './bankPdfParserNedbank';
import { parseCapitecStatement } from './bankPdfParserCapitec';

const COMPONENT = 'bank-pdf-factory';

// Re-export shared types for callers that only import from the factory
export type { BankCsvParseResult };

export type DetectedBank =
  | 'absa'
  | 'fnb'
  | 'standard_bank'
  | 'nedbank'
  | 'capitec'
  | 'unknown';

/**
 * Detect which South African bank issued the statement based on the first
 * 3 000 characters of extracted PDF text.
 *
 * The sample is lower-cased for case-insensitive matching. We check more
 * specific identifiers first so that subsidiary/partner bank names
 * (e.g. "Standard Bank" appearing in a Nedbank document) don't mis-detect.
 */
export function detectBank(text: string): DetectedBank {
  const sample = text.substring(0, 3000).toLowerCase();

  // Capitec — check before generic "bank" keywords
  if (sample.includes('capitec')) return 'capitec';

  // FNB — "first national bank" is highly specific; also match the brand abbreviation
  if (sample.includes('first national bank') || sample.includes(' fnb ') || sample.includes('\nfnb\n')) {
    return 'fnb';
  }

  // Standard Bank
  if (sample.includes('standard bank')) return 'standard_bank';

  // Nedbank (includes "nedbank" and the old "ned bank" spelling)
  if (sample.includes('nedbank') || sample.includes('ned bank')) return 'nedbank';

  // ABSA — also check legacy name "amalgamated banks of south africa"
  if (sample.includes('absa') || sample.includes('amalgamated banks')) return 'absa';

  return 'unknown';
}

/**
 * Parse a bank statement from extracted PDF text.
 *
 * This function:
 *   1. Auto-detects the issuing bank from the text content
 *   2. Delegates to the appropriate bank parser
 *   3. Returns a BankCsvParseResult with transactions and any row errors
 *
 * The ABSA parser lives in `bankPdfParser.ts` and is imported lazily here
 * to avoid circular dependencies — bankPdfParser calls this factory for
 * all non-ABSA banks, so we import ABSA inline.
 *
 * @param text         Plain text extracted from the PDF
 * @param bankHint     Optional override (skip auto-detection)
 */
export function parseBankStatementText(
  text: string,
  bankHint?: string,
): BankCsvParseResult {
  const detectedBank: DetectedBank =
    bankHint && bankHint !== 'unknown'
      ? (bankHint as DetectedBank)
      : detectBank(text);

  log.info('Bank PDF factory routing', { detectedBank, textLength: text.length }, COMPONENT);

  switch (detectedBank) {
    case 'fnb':
      return parseFnbStatement(text);

    case 'standard_bank':
      return parseStandardBankStatement(text);

    case 'nedbank':
      return parseNedbankStatement(text);

    case 'capitec':
      return parseCapitecStatement(text);

    case 'absa': {
      // Delegate to the existing ABSA parser in bankPdfParser.ts.
      // We import inline to avoid a circular dependency:
      //   bankPdfParser → parseBankStatementText → bankPdfParser
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { parseAbsaPdfText } = require('./bankPdfParser') as {
        parseAbsaPdfText: (text: string) => BankCsvParseResult;
      };
      return parseAbsaPdfText(text);
    }

    default:
      return {
        transactions: [],
        errors: [{ row: 0, error: 'Unable to detect bank from PDF content' }],
        bankFormat: 'unknown',
      };
  }
}

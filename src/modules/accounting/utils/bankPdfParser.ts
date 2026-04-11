/**
 * PRD-060: FibreFlow Accounting Module
 * Bank PDF Statement Parser
 *
 * Extracts transactions from bank PDF statements using pdf-parse.
 * Primary target: ABSA PDF statements.
 *
 * ABSA PDF transaction line format:
 *   15 Jan 2026  POS Purchase Woolworths  -1,234.56  45,678.90
 */

import { log } from '@/lib/logger';
import type { BankCsvParseResult, ParsedBankTransaction } from '../types/bank.types';
import { isVlmAvailable, extractBankStatementWithVlm } from '../services/vlmService';
import { extractAccountNumber } from './bankPdfParserUtils';

// pdf-parse v2 exposes a PDFParse class (not a default function).
// Type definitions for the class-based v2 API.
interface PdfParseV2Result {
  text: string;
  pages: unknown[];
  total: number;
}
interface PdfParseV2Instance {
  getText(): Promise<PdfParseV2Result>;
}
interface PdfParseV2Ctor {
  new (options: { data: Buffer }): PdfParseV2Instance;
}
interface PdfParseV2Module {
  PDFParse: PdfParseV2Ctor;
}

// Month name lookup for ABSA PDF date parsing ("15 Jan 2026")
const MONTH_MAP: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Parse a currency string that may contain commas, spaces, and a leading minus.
 * Examples: "-1,234.56", "45 678.90", "1234.56"
 */
function parsePdfAmount(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, '').replace(/,/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Parse ABSA-style date string "15 Jan 2026" → "2026-01-15".
 */
function parseAbsaDate(day: string, mon: string, year: string): string | null {
  const monthNum = MONTH_MAP[mon.toLowerCase()];
  if (!monthNum) return null;
  const d = parseInt(day, 10);
  const y = parseInt(year, 10);
  if (isNaN(d) || isNaN(y) || d < 1 || d > 31 || y < 2000 || y > 2099) return null;
  return `${y}-${monthNum}-${String(d).padStart(2, '0')}`;
}

/**
 * Parse ABSA PDF transaction lines from extracted text.
 *
 * ABSA PDF lines follow this pattern:
 *   <day> <Mon> <year>  <description text>  <signed-amount>  <balance>
 *
 * The regex captures:
 *   - date: "15 Jan 2026"
 *   - description: arbitrary text (greedy, trimmed)
 *   - amount: "-1,234.56" or "1,234.56"
 *   - balance (optional): second numeric at end of line
 */
/**
 * Public entry point for the factory to call ABSA parsing without
 * going through the full PDF extraction pipeline.
 * Exposed as a named export so bankPdfParserFactory.ts can import it.
 */
export function parseAbsaPdfText(text: string): BankCsvParseResult {
  return parseAbsaTextLines(text);
}

function parseAbsaTextLines(text: string): BankCsvParseResult {
  const result: BankCsvParseResult = {
    transactions: [],
    errors: [],
    bankFormat: 'absa',
  };

  // Extract account number so the import API can verify the statement
  // belongs to the bank account the user selected.
  const accountNumber = extractAccountNumber(text) ?? undefined;
  if (accountNumber) result.accountNumber = accountNumber;

  // Match lines that start with a date pattern: "15 Jan 2026"
  // Then description, then one or two signed/unsigned numeric amounts
  const linePattern =
    /^(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+(.+?)\s+([-]?\d[\d,\s]*\.\d{2})\s+([-]?\d[\d,\s]*\.\d{2})?$/im;

  const lines = text.split('\n');
  let lineNum = 0;

  for (const rawLine of lines) {
    lineNum++;
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(linePattern);
    if (!match) continue;

    const [, day, mon, year, desc, amountRaw, balanceRaw] = match;

    const transactionDate = parseAbsaDate(day!, mon!, year!);
    if (!transactionDate) {
      result.errors.push({ row: lineNum, error: `Invalid date: ${day} ${mon} ${year}` });
      continue;
    }

    const amount = parsePdfAmount(amountRaw!);
    if (amount === null) {
      result.errors.push({ row: lineNum, error: `Invalid amount: ${amountRaw}` });
      continue;
    }

    const tx: ParsedBankTransaction = {
      transactionDate,
      amount,
      description: desc!.trim(),
      balance: balanceRaw ? parsePdfAmount(balanceRaw) ?? undefined : undefined,
    };

    result.transactions.push(tx);
  }

  return result;
}

/**
 * Detect the bank from raw PDF text content.
 *
 * Uses a score-based scan with highly bank-specific marker phrases
 * (product names, legal footers, unique addresses) so we don't
 * false-positive on transaction descriptions. A cross-bank transfer
 * like "Absa Bank Shasti Van Vuuren" must NOT turn a Standard Bank
 * statement into an ABSA statement.
 *
 * Each bank has a set of weighted markers; we scan the entire text,
 * sum the hits per bank, and return the highest-scoring one. Ties and
 * zero-scores fall back to 'unknown'.
 */
function detectPdfBankFormat(text: string): string {
  // PDFs often emit multi-whitespace between every visual word
  // ("Private \tBag \tX18"), so we collapse all runs of whitespace to
  // single spaces before matching against the markers below.
  const lower = text.toLowerCase().replace(/\s+/g, ' ');

  // Priority: brand markers first (unique), then product/legal markers.
  // Scoring keeps the old "only look at the first chunk" logic honest —
  // transaction rows CAN mention other banks' names in counterparty
  // descriptions, so we give the first 2000 chars double weight.
  const headerRegion = lower.substring(0, 2000);

  // Each marker: [needle, weight in headerRegion, weight in whole doc]
  // Picking markers that only appear in LEGAL/HEADER text, not in
  // descriptions. "absa bank limited" is a legal entity name found in
  // the footer of ABSA statements; "absa bank" alone appears in
  // transfer descriptions across every bank, so we avoid that one.
  type Marker = readonly [needle: string, headerW: number, fullW: number];

  const markers: Record<string, Marker[]> = {
    absa: [
      ['absa bank limited', 5, 2],
      ['amalgamated banks of south africa', 5, 2],
      ['reg no 1986/004794', 5, 0],       // ABSA Bank Limited reg number
    ],
    standard_bank: [
      ['the standard bank of south africa', 5, 2],
      ['standard bank of south africa limited', 5, 2],
      ['classic business acc', 4, 1],     // SBSA product name
      ['private bag x18, johannesburg', 4, 1],  // SBSA HQ address
      ['sb reg no', 3, 0],
      ['standard bank', 2, 0],            // weaker — appears in sbsa headers but also in some descriptions
    ],
    fnb: [
      ['first national bank', 5, 2],
      ['firstrand bank limited', 5, 2],
      ['fnb online banking', 4, 1],
      ['fnb.co.za', 3, 0],
    ],
    nedbank: [
      ['nedbank limited', 5, 2],
      ['nedbank group limited', 5, 2],
      ['nedbank.co.za', 3, 0],
      ['reg no 1951/000009', 5, 0],
    ],
    capitec: [
      ['capitec bank limited', 5, 2],
      ['capitec bank', 3, 1],
      ['capitecbank.co.za', 3, 0],
    ],
  };

  const scores: Record<string, number> = {
    absa: 0, standard_bank: 0, fnb: 0, nedbank: 0, capitec: 0,
  };

  for (const [bank, bankMarkers] of Object.entries(markers)) {
    for (const [needle, headerW, fullW] of bankMarkers) {
      if (headerRegion.includes(needle)) scores[bank]! += headerW;
      else if (lower.includes(needle)) scores[bank]! += fullW;
    }
  }

  // Find the top scorer. Require at least 1 point — zero means nothing matched.
  let best: string = 'unknown';
  let bestScore = 0;
  for (const [bank, score] of Object.entries(scores)) {
    if (score > bestScore) {
      best = bank;
      bestScore = score;
    }
  }

  return best;
}

/**
 * Parse a bank statement PDF and extract transactions.
 *
 * Accepts a Buffer of PDF bytes. Uses pdf-parse to extract text, then
 * applies bank-specific regex patterns to identify transaction lines.
 *
 * @param pdfBuffer - Raw PDF file bytes
 * @param bankFormat - Optional hint for which bank format to use
 * @returns Parsed transactions and any row-level errors
 */
export async function parseBankPdf(
  pdfBuffer: Buffer,
  bankFormat?: string,
): Promise<BankCsvParseResult> {
  let PDFParse: PdfParseV2Ctor;

  try {
    // pdf-parse v2 exposes a PDFParse class via CommonJS.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('pdf-parse') as PdfParseV2Module;
    PDFParse = mod.PDFParse;
    if (typeof PDFParse !== 'function') {
      throw new Error('pdf-parse did not export PDFParse class');
    }
  } catch (err) {
    log.error('pdf-parse module not available', {
      error: err instanceof Error ? err.message : String(err),
    }, 'accounting-pdf');
    return {
      transactions: [],
      errors: [{ row: 0, error: 'PDF parsing library not available. Please upload a CSV file instead.' }],
      bankFormat: bankFormat || 'unknown',
    };
  }

  let parsed: PdfParseV2Result;
  try {
    const parser = new PDFParse({ data: pdfBuffer });
    parsed = await parser.getText();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to read PDF';
    log.error('Failed to parse PDF buffer', { error: err }, 'accounting-pdf');
    return {
      transactions: [],
      errors: [{ row: 0, error: `PDF read error: ${message}` }],
      bankFormat: bankFormat || 'unknown',
    };
  }

  const text = parsed.text;
  if (!text || text.trim().length === 0) {
    return {
      transactions: [],
      errors: [{ row: 0, error: 'No text content found in PDF. The file may be image-based (scanned). Please use a CSV export instead.' }],
      bankFormat: bankFormat || 'unknown',
    };
  }

  const detectedFormat = bankFormat && bankFormat !== 'unknown'
    ? bankFormat
    : detectPdfBankFormat(text);

  log.info('Parsing bank PDF', {
    pages: parsed.total,
    textLength: text.length,
    format: detectedFormat,
  }, 'accounting-pdf');

  // Route to the appropriate parser based on detected format.
  // ABSA is handled directly; all other SA banks go through the factory.
  if (detectedFormat === 'absa') {
    return parseAbsaTextLines(text);
  }

  if (['fnb', 'standard_bank', 'nedbank', 'capitec'].includes(detectedFormat)) {
    const { parseBankStatementText } = await import('./bankPdfParserFactory');
    const factoryResult = parseBankStatementText(text, detectedFormat);
    if (factoryResult.transactions.length > 0) {
      return factoryResult;
    }
    // Factory found no transactions — fall through to ABSA pattern & VLM
    log.warn('Factory parser returned no transactions, trying fallbacks', {
      format: detectedFormat,
    }, 'accounting-pdf');
  }

  // Fallback: attempt generic ABSA-style date-amount pattern for unknown formats
  const fallback = parseAbsaTextLines(text);
  if (fallback.transactions.length > 0) {
    log.info('PDF parsed using ABSA fallback pattern', {
      count: fallback.transactions.length,
    }, 'accounting-pdf');
    return { ...fallback, bankFormat: detectedFormat };
  }

  // VLM fallback: use AI vision to extract from any bank format
  if (isVlmAvailable()) {
    try {
      log.info('Attempting VLM bank statement extraction', { format: detectedFormat }, 'accounting-pdf');
      const vlmResult = await extractBankStatementWithVlm(
        pdfBuffer.toString('base64'),
        'application/pdf',
        text,
      );

      if (vlmResult && vlmResult.transactions.length > 0) {
        log.info('VLM bank statement extraction successful', {
          bankName: vlmResult.bankName,
          count: vlmResult.transactions.length,
        }, 'accounting-pdf');

        return {
          transactions: vlmResult.transactions.map(t => ({
            transactionDate: t.date || '',
            amount: t.amount,
            description: t.description,
            balance: t.balance ?? undefined,
            reference: t.reference ?? undefined,
          })),
          errors: [],
          bankFormat: vlmResult.bankName?.toLowerCase() || detectedFormat,
          accountNumber: vlmResult.accountNumber
            ? vlmResult.accountNumber.replace(/[\s-]/g, '')
            : undefined,
        };
      }
    } catch (err) {
      log.warn('VLM bank statement extraction failed', {
        error: err instanceof Error ? err.message : String(err),
      }, 'accounting-pdf');
    }
  }

  return {
    transactions: [],
    errors: [{
      row: 0,
      error: `Could not parse transactions from ${detectedFormat === 'unknown' ? 'unknown bank' : detectedFormat} PDF. ` +
        'Please download the statement as a CSV and import that instead.',
    }],
    bankFormat: detectedFormat,
  };
}

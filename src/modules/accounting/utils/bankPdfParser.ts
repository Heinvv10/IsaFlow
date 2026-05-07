/**
 * PRD-060: FibreFlow Accounting Module
 * Bank PDF Statement Parser — main router/factory
 *
 * Detects bank from PDF text content and delegates to the appropriate
 * bank-specific parser. ABSA is handled directly; other banks go via
 * bankPdfParserFactory.ts; unknown formats fall back to VLM.
 */

import { log } from '@/lib/logger';
import type { BankCsvParseResult } from '../types/bank.types';
import { isVlmAvailable, extractBankStatementWithVlm } from '../services/bank/vlmService';
import { parseAbsaPdfText } from './bankPdfParserAbsa';

export { parseAbsaPdfText };

// pdf-parse v2 exposes a PDFParse class (not a default function).
interface PdfParseV2Result { text: string; pages: unknown[]; total: number; }
interface PdfParseV2Instance { getText(): Promise<PdfParseV2Result>; }
interface PdfParseV2Ctor { new (options: { data: Buffer }): PdfParseV2Instance; }
interface PdfParseV2Module { PDFParse: PdfParseV2Ctor; }

/**
 * Detect the bank from raw PDF text content using score-based marker matching.
 * Returns 'unknown' when no bank scores at least 1 point.
 */
function detectPdfBankFormat(text: string): string {
  // Collapse whitespace so multi-space PDF tokens match cleanly
  const lower = text.toLowerCase().replace(/\s+/g, ' ');
  const headerRegion = lower.substring(0, 2000);

  type Marker = readonly [needle: string, headerW: number, fullW: number];

  const markers: Record<string, Marker[]> = {
    absa: [
      ['absa bank limited', 5, 3],
      ['ncrcp7', 10, 10],
      ['ncrcp 7', 10, 10],
      ['amalgamated banks of south africa', 5, 3],
      ['reg no 1986/004794/06', 10, 10],
    ],
    standard_bank: [
      ['the standard bank of south africa limited', 10, 10],
      ['ncrcp15', 10, 10],
      ['reg no 1962/000738/06', 10, 10],
      ['stanbic', 3, 1],
    ],
    fnb: [
      ['firstrand bank limited', 10, 10],
      ['ncrcp20', 10, 10],
      ['first national bank', 4, 2],
      ['reg no 1929/001225/06', 10, 10],
      ['fnb online banking', 4, 1],
    ],
    nedbank: [
      ['nedbank limited', 10, 5],
      ['ncrcp16', 10, 10],
      ['reg no 1951/000009/06', 10, 10],
    ],
    capitec: [
      ['capitec bank limited', 10, 5],
      ['ncrcp13', 10, 10],
      ['reg no 1980/003695/06', 10, 10],
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

  let best = 'unknown';
  let bestScore = 0;
  for (const [bank, score] of Object.entries(scores)) {
    if (score > bestScore) { best = bank; bestScore = score; }
  }

  return best;
}

/**
 * Parse a bank statement PDF and extract transactions.
 *
 * @param pdfBuffer - Raw PDF file bytes
 * @param bankFormat - Optional hint for which bank format to use
 */
export async function parseBankPdf(
  pdfBuffer: Buffer,
  bankFormat?: string,
): Promise<BankCsvParseResult> {
  let PDFParse: PdfParseV2Ctor;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
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

  // Route to ABSA parser (handles Investment, DD/MM/YYYY, and text-date variants)
  if (detectedFormat === 'absa') {
    return parseAbsaPdfText(text);
  }

  // Other SA banks: delegate to factory
  if (['fnb', 'standard_bank', 'nedbank', 'capitec'].includes(detectedFormat)) {
    const { parseBankStatementText } = await import('./bankPdfParserFactory');
    const factoryResult = parseBankStatementText(text, detectedFormat);
    if (factoryResult.transactions.length > 0) return factoryResult;
    // Provisional / empty-period statement — parsed OK but no transactions
    if (factoryResult.errors.some(e => e.error === '__empty_period__')) {
      return {
        transactions: [],
        errors: [{ row: 0, error: 'This statement has no transactions for the period (provisional or zero-activity statement). Nothing to import.' }],
        bankFormat: detectedFormat,
        accountNumber: factoryResult.accountNumber,
      };
    }
    log.warn('Factory parser returned no transactions, trying fallbacks', {
      format: detectedFormat,
    }, 'accounting-pdf');
  }

  // Fallback: ABSA-style date-amount pattern for unknown formats
  const fallback = parseAbsaPdfText(text);
  if (fallback.transactions.length > 0) {
    log.info('PDF parsed using ABSA fallback pattern', {
      count: fallback.transactions.length,
    }, 'accounting-pdf');
    return { ...fallback, bankFormat: detectedFormat };
  }

  // VLM fallback: AI vision extraction
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

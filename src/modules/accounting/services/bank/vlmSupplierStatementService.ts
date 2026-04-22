/**
 * VLM Supplier Statement Service — supplier statement extraction via vLLM
 *
 * Extracts line items and metadata from South African supplier statement PDFs.
 * SA convention: opening balance at top, lines are invoices/credit notes/payments,
 * running balance column on the right.
 */

import { log } from '@/lib/logger';
import {
  getVlmConfig,
  callVlmChat,
  cleanVlmJson,
  buildImageContent,
  asString,
  asNumber,
  asDateString,
} from './vlmCore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SupplierStatementLine {
  date?: string;          // ISO YYYY-MM-DD; opening balance rows may have no date
  reference?: string;     // invoice number, receipt number, credit note number, etc.
  description?: string;
  debit?: number;         // amount the supplier billed us (money we owe)
  credit?: number;        // payments we made against this supplier
  runningBalance?: number;
}

export interface SupplierStatementExtraction {
  supplierName?: string;
  statementDate?: string;   // ISO
  periodStart?: string;     // ISO
  periodEnd?: string;       // ISO
  openingBalance?: number;
  closingBalance?: number;
  lines: SupplierStatementLine[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Extraction prompt
// ---------------------------------------------------------------------------

const SUPPLIER_STATEMENT_PROMPT = `You are an expert at reading South African supplier/creditor statements.
A supplier statement lists all invoices, credit notes and payments on a debtor account for a period.
Common SA layouts: opening balance row at top, then one row per invoice/credit note/payment, running balance column on the right.

Extract ALL line items and header metadata from this supplier statement.

Return ONLY valid JSON (no markdown, no explanation) matching this schema exactly:

{
  "supplierName": string | null,
  "statementDate": "YYYY-MM-DD" | null,
  "periodStart": "YYYY-MM-DD" | null,
  "periodEnd": "YYYY-MM-DD" | null,
  "openingBalance": number | null,
  "closingBalance": number | null,
  "lines": [
    {
      "date": "YYYY-MM-DD" | null,
      "reference": string | null,
      "description": string | null,
      "debit": number | null,
      "credit": number | null,
      "runningBalance": number | null
    }
  ],
  "warnings": []
}

Rules:
- "debit" = amount the supplier billed us (invoice, debit note) — positive number
- "credit" = payment or credit note we applied — positive number
- Do NOT negate debits or credits; both are positive magnitudes in their column
- Parse dates carefully — SA format is typically DD/MM/YYYY or DD Mon YYYY or YYYY/MM/DD
- Include every single line row — do not skip or summarise
- Opening balance row: set reference="OPENING BALANCE", date=null if not shown
- If a field is genuinely absent, use null — do NOT hallucinate values
- If the document is unclear or not a supplier statement, return empty lines array and add a warning
- The "warnings" array should note any ambiguities (e.g. currency mismatches, partial pages)`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract supplier statement lines + metadata using VLM.
 * Returns a safe default (empty lines) if VLM is not configured or extraction fails.
 */
export async function extractSupplierStatementWithVlm(
  base64: string,
  mimeType: string,
  rawText?: string,
): Promise<SupplierStatementExtraction> {
  const empty: SupplierStatementExtraction = {
    lines: [],
    warnings: ['VLM not configured — no extraction performed'],
  };

  const config = getVlmConfig();
  if (!config) return empty;

  let textPrompt = 'Extract all line items and metadata from this supplier statement.';
  if (rawText && rawText.trim().length > 0) {
    textPrompt += `\n\nPDF text layer (may assist with handwriting or low-res scans):\n\n${rawText.substring(0, 6000)}`;
  }

  log.info('Calling vLLM for supplier statement extraction', { model: config.model }, 'vlm-supplier-stmt');

  const userContent = buildImageContent(base64, mimeType, textPrompt);
  const content = await callVlmChat(config, SUPPLIER_STATEMENT_PROMPT, userContent, 8192);
  if (!content) {
    return { lines: [], warnings: ['VLM returned no content'] };
  }

  return parseSupplierStatementResponse(content);
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseSupplierStatementResponse(content: string): SupplierStatementExtraction {
  const jsonStr = cleanVlmJson(content);

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    const lines: SupplierStatementLine[] = [];
    if (Array.isArray(parsed.lines)) {
      for (const l of parsed.lines) {
        if (!l || typeof l !== 'object') continue;
        const row = l as Record<string, unknown>;
        lines.push({
          date: asDateString(row.date) ?? undefined,
          reference: asString(row.reference) ?? undefined,
          description: asString(row.description) ?? undefined,
          debit: asNumber(row.debit) ?? undefined,
          credit: asNumber(row.credit) ?? undefined,
          runningBalance: asNumber(row.runningBalance) ?? asNumber(row.running_balance) ?? undefined,
        });
      }
    }

    const warnings: string[] = [];
    if (Array.isArray(parsed.warnings)) {
      for (const w of parsed.warnings) {
        const ws = asString(w);
        if (ws) warnings.push(ws);
      }
    }
    if (lines.length === 0) {
      warnings.push('No lines extracted from supplier statement');
    }

    const result: SupplierStatementExtraction = {
      supplierName: asString(parsed.supplierName) ?? asString(parsed.supplier_name) ?? undefined,
      statementDate: asDateString(parsed.statementDate) ?? asDateString(parsed.statement_date) ?? undefined,
      periodStart: asDateString(parsed.periodStart) ?? asDateString(parsed.period_start) ?? undefined,
      periodEnd: asDateString(parsed.periodEnd) ?? asDateString(parsed.period_end) ?? undefined,
      openingBalance: asNumber(parsed.openingBalance) ?? asNumber(parsed.opening_balance) ?? undefined,
      closingBalance: asNumber(parsed.closingBalance) ?? asNumber(parsed.closing_balance) ?? undefined,
      lines,
      warnings,
    };

    log.info('Supplier statement extraction successful', {
      supplierName: result.supplierName,
      lineCount: lines.length,
      warnings: warnings.length,
    }, 'vlm-supplier-stmt');

    return result;
  } catch (err) {
    log.error('Failed to parse supplier statement VLM response', {
      error: err instanceof Error ? err.message : String(err),
    }, 'vlm-supplier-stmt');
    return { lines: [], warnings: ['Failed to parse VLM JSON response'] };
  }
}

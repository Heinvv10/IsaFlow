/**
 * VLM Bank Service — bank statement extraction via vLLM
 *
 * Extracts transaction lists and metadata from South African bank statement images,
 * and from one page of a PDF at a time (readBankStatementPage; vlmStatementPages).
 * The raw PDF is never sent: vLLM rejects it.
 */

import { log } from '@/lib/logger';
import type {
  ExtractedBankStatement,
  ExtractedBankTransaction,
} from '@/modules/accounting/types/documentCapture.types';
import {
  getVlmConfig,
  callVlmChat,
  cleanVlmJson,
  buildImageContent,
  asString,
  asNumber,
  asDateString,
} from './vlmCore';
import { statementPageContent, type PageRequest } from './vlmStatementPages';

// ---------------------------------------------------------------------------
// Extraction prompt
// ---------------------------------------------------------------------------

const BANK_STATEMENT_PROMPT = `You are an expert at reading South African bank statements.
Extract ALL transactions and metadata from this bank statement image.
Common SA banks: ABSA, FNB, Standard Bank, Nedbank, Capitec, Investec, African Bank, TymeBank.

Return ONLY valid JSON (no markdown, no explanation) matching this schema:

{
  "bankName": string | null,
  "accountNumber": string | null,
  "statementPeriod": { "from": "YYYY-MM-DD" | null, "to": "YYYY-MM-DD" | null } | null,
  "openingBalance": number | null,
  "closingBalance": number | null,
  "transactions": [
    {
      "date": "YYYY-MM-DD" | null,
      "description": string,
      "amount": number,
      "balance": number | null,
      "reference": string | null,
      "transactionType": string | null
    }
  ]
}

Rules:
- Debit (money out) amounts should be NEGATIVE, credit (money in) should be POSITIVE
- Include every single transaction row — do not skip or summarise
- Parse dates carefully — SA format is typically DD/MM/YYYY or DD Mon YYYY
- If a transaction spans multiple description lines, concatenate them`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Rules for one page of a multi-page statement. */
const PAGE_RULES = 'Do not emit "balance brought forward" or "balance carried forward" rows as transactions. '
  + 'Give the account number, period and opening/closing balance only if they are printed on this page, otherwise null.';

/**
 * Extract bank statement transactions from ONE IMAGE using VLM. A PDF is read
 * page by page instead (readBankStatementPage): vLLM rejects a raw PDF.
 */
export async function extractBankStatementWithVlm(
  base64: string,
  mimeType: string,
  rawText?: string,
): Promise<ExtractedBankStatement | null> {
  if (mimeType === 'application/pdf') {
    log.error('Refused to send a raw PDF to vLLM — read it page by page', undefined, 'vlm-bank');
    return null;
  }
  const config = getVlmConfig();
  if (!config) return null;

  let textPrompt = 'Extract all transactions from this bank statement.';
  if (rawText && rawText.trim().length > 0) {
    textPrompt += `\n\nPDF text layer:\n\n${rawText.substring(0, 6000)}`;
  }

  log.info('Calling vLLM for bank statement extraction', { model: config.model }, 'vlm-bank');

  const userContent = buildImageContent(base64, mimeType, textPrompt);
  const content = await callVlmChat(config, BANK_STATEMENT_PROMPT, userContent, 8192);
  if (!content) return null;

  return parseBankStatementResponse(content, true);
}

/** One page of a statement PDF; null when the model gave no usable answer for it. */
export async function readBankStatementPage(req: PageRequest): Promise<ExtractedBankStatement | null> {
  const config = getVlmConfig();
  if (!config) return null;

  log.info('Calling vLLM for a bank statement page', { model: config.model, page: req.page, total: req.total }, 'vlm-bank');

  const content = await callVlmChat(config, BANK_STATEMENT_PROMPT, statementPageContent(req, PAGE_RULES), 8192);
  if (!content) return null;

  return parseBankStatementResponse(content, false);
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/** `warnEmpty`: a lone image with no rows says so; a page with none is just an empty page. */
function parseBankStatementResponse(content: string, warnEmpty: boolean): ExtractedBankStatement | null {
  const jsonStr = cleanVlmJson(content);

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    const transactions: ExtractedBankTransaction[] = [];
    if (Array.isArray(parsed.transactions)) {
      for (const t of parsed.transactions) {
        if (!t || typeof t !== 'object') continue;
        const tx = t as Record<string, unknown>;
        transactions.push({
          date: asDateString(tx.date),
          description: asString(tx.description) || 'Unknown',
          amount: asNumber(tx.amount) ?? 0,
          balance: asNumber(tx.balance),
          reference: asString(tx.reference),
          transactionType: asString(tx.transactionType) ?? asString(tx.transaction_type),
        });
      }
    }

    const period = parsed.statementPeriod as Record<string, unknown> | null;

    const result: ExtractedBankStatement = {
      bankName: asString(parsed.bankName) ?? asString(parsed.bank_name),
      accountNumber: asString(parsed.accountNumber) ?? asString(parsed.account_number),
      statementPeriod: period
        ? { from: asDateString(period.from), to: asDateString(period.to) }
        : null,
      openingBalance: asNumber(parsed.openingBalance) ?? asNumber(parsed.opening_balance),
      closingBalance: asNumber(parsed.closingBalance) ?? asNumber(parsed.closing_balance),
      transactions,
      confidence: transactions.length > 0 ? 0.85 : 0.1,
      warnings: [],
    };

    if (warnEmpty && transactions.length === 0) {
      result.warnings.push('No transactions extracted from bank statement');
    }

    log.info('Bank statement extraction successful', {
      bankName: result.bankName,
      transactionCount: transactions.length,
    }, 'vlm-bank');

    return result;
  } catch (err) {
    log.error('Failed to parse bank statement VLM response', {
      error: err instanceof Error ? err.message : String(err),
    }, 'vlm-bank');
    return null;
  }
}

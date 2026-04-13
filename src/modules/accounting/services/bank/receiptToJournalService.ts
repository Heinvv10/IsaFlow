/**
 * Receipt-to-Journal Service
 * Converts receipt/expense photo extractions into GL journal entries.
 * Pure business logic — no database dependencies.
 */

import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReceiptAccountMapping {
  id: string;
  code: string;
  name: string;
}

export interface ReceiptAutoPostConfig {
  maxAmount: number;
  minConfidence: number;
}

export interface JournalLine {
  accountId: string;
  debit: number;
  credit: number;
  description: string;
}

export interface JournalEntryInput {
  entryDate: string;
  description: string;
  source: string;
  lines: JournalLine[];
}

export interface AccountSuggestion {
  id: string;
  code: string;
  name: string;
}

export interface ReceiptValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

type ReceiptType = 'fuel' | 'meals' | 'travel' | 'office_supplies' | 'general';

// ---------------------------------------------------------------------------
// Merchant → GL Account mapping (SA merchants)
// ---------------------------------------------------------------------------

const MERCHANT_PATTERNS: Array<{ pattern: RegExp; accountCode: string; type: ReceiptType }> = [
  // Fuel
  { pattern: /engen|shell|caltex|sasol|bp |total |fuel|petrol|diesel/i, accountCode: '5400', type: 'fuel' },
  // Meals & entertainment
  { pattern: /spur|nandos|steers|mcdonald|kfc|wimpy|ocean basket|mugg.*bean|uber\s*eat|mr\s*d|restaurant|cafe|coffee/i, accountCode: '5600', type: 'meals' },
  // Travel
  { pattern: /uber(?!\s*eat)|bolt|taxify|airport|flight|hotel|lodge|airbnb|protea\s*hotel/i, accountCode: '5600', type: 'travel' },
  // Office supplies
  { pattern: /office\s*national|pen\s*and\s*paper|waltons|takealot|incredible|stationery/i, accountCode: '5100', type: 'office_supplies' },
  // Telecoms → admin
  { pattern: /mtn|vodacom|telkom|cell\s*c|rain|afrihost/i, accountCode: '5600', type: 'general' },
  // Groceries / consumables
  { pattern: /woolworths|checkers|pick\s*n\s*pay|shoprite|spar|makro|game/i, accountCode: '5100', type: 'general' },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function validateReceiptExtraction(extracted: ExtractedDocument): ReceiptValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (extracted.totalAmount === null || extracted.totalAmount === undefined) {
    errors.push('totalAmount is required');
  }
  if (!extracted.date) {
    errors.push('date is required');
  } else {
    const d = new Date(extracted.date);
    if (d > new Date()) errors.push('Receipt date is in the future');
  }
  if (extracted.vatAmount === null || extracted.vatAmount === undefined) {
    warnings.push('VAT amount not extracted — will be calculated from total');
  }
  if (!extracted.vendorName) {
    warnings.push('Merchant name not extracted');
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function mapMerchantToExpenseAccount(
  merchantName: string,
  accounts: ReceiptAccountMapping[],
): AccountSuggestion | null {
  const name = merchantName.toLowerCase();

  for (const mapping of MERCHANT_PATTERNS) {
    if (mapping.pattern.test(name)) {
      const account = accounts.find(a => a.code === mapping.accountCode);
      if (account) return { id: account.id, code: account.code, name: account.name };
    }
  }

  return null;
}

export function buildExpenseJournalFromReceipt(
  extracted: ExtractedDocument,
  accountIds: { expenseAccountId: string; vatInputAccountId: string; bankAccountId: string },
): JournalEntryInput {
  const total = extracted.totalAmount ?? 0;
  const vatRate = extracted.vatRate ?? 15;

  let vatAmount: number;
  let subtotal: number;

  if (extracted.vatAmount !== null && extracted.vatAmount !== undefined && extracted.subtotal !== null && extracted.subtotal !== undefined) {
    vatAmount = extracted.vatAmount;
    subtotal = extracted.subtotal;
  } else {
    // Calculate VAT-inclusive → exclusive
    subtotal = Math.round((total / (1 + vatRate / 100)) * 100) / 100;
    vatAmount = Math.round((total - subtotal) * 100) / 100;
  }

  const merchantDesc = extracted.vendorName || 'Unknown merchant';

  return {
    entryDate: extracted.date || new Date().toISOString().split('T')[0]!,
    description: `Receipt: ${merchantDesc}${extracted.referenceNumber ? ` (${extracted.referenceNumber})` : ''}`,
    source: 'auto_invoice',
    lines: [
      { accountId: accountIds.expenseAccountId, debit: subtotal, credit: 0, description: merchantDesc },
      { accountId: accountIds.vatInputAccountId, debit: vatAmount, credit: 0, description: 'VAT Input' },
      { accountId: accountIds.bankAccountId, debit: 0, credit: total, description: `Payment: ${merchantDesc}` },
    ],
  };
}

export function shouldAutoPostReceipt(
  totalAmount: number,
  confidence: number,
  config: ReceiptAutoPostConfig,
): boolean {
  return totalAmount < config.maxAmount && confidence >= config.minConfidence;
}

export function parseReceiptType(extracted: ExtractedDocument): ReceiptType {
  if (!extracted.vendorName) return 'general';
  const name = extracted.vendorName.toLowerCase();

  for (const mapping of MERCHANT_PATTERNS) {
    if (mapping.pattern.test(name)) return mapping.type;
  }

  return 'general';
}

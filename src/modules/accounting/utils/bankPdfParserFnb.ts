/**
 * WS-8.2: FNB Bank PDF Statement Parser
 *
 * FNB statement format characteristics:
 *   - Account number appears after "Account Number" or "Acc No"
 *   - Transaction table has headers: Date | Description | Amount | Balance
 *   - Date formats: DD/MM/YYYY or DD MMM YYYY or DD-MMM-YYYY
 *   - Negative amounts for debits, positive for credits
 *   - Multi-line descriptions (continuation lines have no leading date)
 *   - Statement period visible as "Statement Period: DD/MM/YYYY to DD/MM/YYYY"
 */

import { log } from '@/lib/logger';
import type { BankCsvParseResult } from '../types/bank.types';
import { parseDate, parseAmount, cleanDescription, extractAccountNumber } from './bankPdfParserUtils';

const COMPONENT = 'bank-pdf-fnb';

/**
 * Regex to detect the start of a transaction line.
 * FNB uses DD/MM/YYYY, DD-MMM-YYYY, or DD MMM YYYY at the start of the line.
 */
const TX_DATE_PATTERN =
  /^(\d{1,2}[/-]\d{1,2}[/-]\d{4}|\d{1,2}\s+[A-Za-z]{3}\s+\d{4}|\d{1,2}[/-][A-Za-z]{3}[/-]\d{4})/;

/**
 * Regex to match a signed/unsigned amount with optional thousand separators.
 */
const AMOUNT_PATTERN = /[-]?\d{1,3}(?:[, ]\d{3})*(?:\.\d{2})/g;

export function parseFnbStatement(text: string): BankCsvParseResult {
  const result: BankCsvParseResult = {
    transactions: [],
    errors: [],
    bankFormat: 'fnb',
  };

  const accountNumber = extractAccountNumber(text) ?? undefined;
  const lines = text.split('\n');

  // Locate the header row — FNB has "Date" near "Description" near "Amount"
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = (lines[i] ?? '').toLowerCase();
    if (l.includes('date') && l.includes('description') && l.includes('amount')) {
      headerIndex = i;
      break;
    }
  }

  // If no explicit header found, start from line 0 and let the date regex guard entries
  const startIndex = headerIndex >= 0 ? headerIndex + 1 : 0;

  let pendingTx: {
    date: string;
    descParts: string[];
    amountRaw: string;
    balanceRaw: string | null;
    lineNum: number;
  } | null = null;

  const flushPending = () => {
    if (!pendingTx) return;
    const tx = pendingTx;
    try {
      const amount = parseAmount(tx.amountRaw);
      if (amount === null) {
        result.errors.push({ row: tx.lineNum, error: `Invalid amount: ${tx.amountRaw}` });
        pendingTx = null;
        return;
      }
      const balance = tx.balanceRaw ? parseAmount(tx.balanceRaw) : null;
      result.transactions.push({
        transactionDate: tx.date,
        description: cleanDescription(tx.descParts.join(' ')),
        amount,
        balance: balance ?? undefined,
        reference: undefined,
      });
    } catch (err) {
      result.errors.push({
        row: tx.lineNum,
        error: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    pendingTx = null;
  };

  for (let i = startIndex; i < lines.length; i++) {
    const rawLine = lines[i] ?? '';
    const line = rawLine.trim();
    if (!line) continue;

    // Skip obvious header/footer lines
    if (/^(date|description|amount|balance|statement|page|total|opening|closing)/i.test(line)) {
      flushPending();
      continue;
    }

    const dateMatch = line.match(TX_DATE_PATTERN);

    if (dateMatch) {
      // New transaction starts — flush any previous pending
      flushPending();

      const rawDate = dateMatch[1]!;
      // Normalize DD-MMM-YYYY (e.g. 15-Jan-2026) to "15 Jan 2026" for parseDate
      const normalizedDate = rawDate.replace(/[/-]([A-Za-z]{3})[/-]/, ' $1 ');
      const parsedDate = parseDate(normalizedDate) ?? parseDate(rawDate);

      if (!parsedDate) {
        result.errors.push({ row: i + 1, error: `Could not parse date: ${rawDate}` });
        continue;
      }

      // Everything after the date on this line
      const rest = line.substring(dateMatch[0]!.length).trim();

      // Extract all numeric amounts from the rest of the line
      const amounts = [...rest.matchAll(AMOUNT_PATTERN)].map(m => m[0]);
      const amountRaw = amounts.at(-2) ?? amounts.at(-1) ?? '';
      const balanceRaw = amounts.length >= 2 ? (amounts.at(-1) ?? null) : null;

      // Description is everything before the first amount
      const firstAmountIndex = amountRaw ? rest.lastIndexOf(amountRaw) : rest.length;
      const descRaw = rest.substring(0, firstAmountIndex).trim();

      if (!amountRaw) {
        // Amount might be on the next line — collect desc now, wait
        pendingTx = {
          date: parsedDate,
          descParts: [descRaw],
          amountRaw: '',
          balanceRaw: null,
          lineNum: i + 1,
        };
        continue;
      }

      pendingTx = {
        date: parsedDate,
        descParts: [descRaw],
        amountRaw,
        balanceRaw,
        lineNum: i + 1,
      };
      flushPending();
    } else if (pendingTx) {
      // Continuation line — either more description or the amount we were missing
      const amounts = [...line.matchAll(AMOUNT_PATTERN)].map(m => m[0]);
      if (pendingTx.amountRaw === '' && amounts.length > 0) {
        pendingTx.amountRaw = amounts.at(-2) ?? amounts.at(-1) ?? '';
        pendingTx.balanceRaw = amounts.length >= 2 ? (amounts.at(-1) ?? null) : null;
        const firstAmountIndex = line.lastIndexOf(pendingTx.amountRaw);
        const descPart = line.substring(0, firstAmountIndex).trim();
        if (descPart) pendingTx.descParts.push(descPart);
        flushPending();
      } else {
        // Pure description continuation
        pendingTx.descParts.push(line);
      }
    }
  }

  flushPending();

  log.info('FNB PDF parse complete', {
    transactions: result.transactions.length,
    errors: result.errors.length,
    accountNumber,
  }, COMPONENT);

  return result;
}

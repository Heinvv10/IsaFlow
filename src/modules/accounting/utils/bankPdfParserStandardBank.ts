/**
 * WS-8.2: Standard Bank PDF Statement Parser
 *
 * Standard Bank statement format characteristics:
 *   - Column headers: TRANSACTION DATE | DESCRIPTION | AMOUNT | BALANCE
 *     or:            Date             | Description | Debit  | Credit | Balance
 *   - Date formats: YYYY/MM/DD or DD MMM YYYY
 *   - Debit amounts shown with "-" prefix OR in a separate Debit column
 *   - Credit amounts positive (separate Credit column or signed Amount column)
 *   - Account number after "Account Number" or similar label
 */

import { log } from '@/lib/logger';
import type { BankCsvParseResult } from '../types/bank.types';
import { parseDate, parseAmount, cleanDescription, extractAccountNumber } from './bankPdfParserUtils';

const COMPONENT = 'bank-pdf-stdbank';

/** Matches YYYY/MM/DD or YYYY-MM-DD at line start */
const ISO_DATE_AT_START = /^(\d{4}[/-]\d{1,2}[/-]\d{1,2})/;
/** Matches DD MMM YYYY at line start */
const WORD_DATE_AT_START = /^(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/;

const AMOUNT_PATTERN = /[-]?\d{1,3}(?:[, ]\d{3})*(?:\.\d{2})/g;

/** Detect if headers indicate separate debit/credit columns */
function hasDebitCreditColumns(headerLine: string): boolean {
  const l = headerLine.toLowerCase();
  return l.includes('debit') && l.includes('credit');
}

export function parseStandardBankStatement(text: string): BankCsvParseResult {
  const result: BankCsvParseResult = {
    transactions: [],
    errors: [],
    bankFormat: 'standard_bank',
  };

  const accountNumber = extractAccountNumber(text) ?? undefined;
  const lines = text.split('\n');

  // Find header row
  let headerIndex = -1;
  let separateDebitCredit = false;
  for (let i = 0; i < lines.length; i++) {
    const l = (lines[i] ?? '').toLowerCase();
    if (l.includes('date') && (l.includes('amount') || (l.includes('debit') && l.includes('credit')))) {
      headerIndex = i;
      separateDebitCredit = hasDebitCreditColumns(lines[i] ?? '');
      break;
    }
  }

  const startIndex = headerIndex >= 0 ? headerIndex + 1 : 0;

  type PendingTx = {
    date: string;
    descParts: string[];
    debitRaw: string;
    creditRaw: string;
    balanceRaw: string | null;
    lineNum: number;
  };

  let pending: PendingTx | null = null;

  const flushPending = () => {
    if (!pending) return;
    const tx = pending;
    try {
      let amount: number | null = null;
      if (separateDebitCredit) {
        const debit = tx.debitRaw ? parseAmount(tx.debitRaw) : null;
        const credit = tx.creditRaw ? parseAmount(tx.creditRaw) : null;
        if (debit !== null) amount = -Math.abs(debit);
        else if (credit !== null) amount = Math.abs(credit);
      } else {
        // Single signed amount column
        amount = parseAmount(tx.debitRaw);
      }

      if (amount === null) {
        result.errors.push({ row: tx.lineNum, error: `No valid amount found` });
        pending = null;
        return;
      }
      const balance = tx.balanceRaw ? parseAmount(tx.balanceRaw) : null;
      result.transactions.push({
        transactionDate: tx.date,
        description: cleanDescription(tx.descParts.join(' ')),
        amount,
        balance: balance ?? undefined,
      });
    } catch (err) {
      result.errors.push({
        row: tx.lineNum,
        error: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    pending = null;
  };

  for (let i = startIndex; i < lines.length; i++) {
    const rawLine = lines[i] ?? '';
    const line = rawLine.trim();
    if (!line) continue;

    // Skip header/footer noise
    if (/^(date|description|amount|balance|debit|credit|transaction|statement|page|total|opening|closing)/i.test(line)) {
      flushPending();
      continue;
    }

    const isoMatch = line.match(ISO_DATE_AT_START);
    const wordMatch = !isoMatch ? line.match(WORD_DATE_AT_START) : null;
    const dateMatch = isoMatch ?? wordMatch;

    if (dateMatch) {
      flushPending();

      const rawDate = dateMatch[1]!;
      const parsedDate = parseDate(rawDate);
      if (!parsedDate) {
        result.errors.push({ row: i + 1, error: `Could not parse date: ${rawDate}` });
        continue;
      }

      const rest = line.substring(dateMatch[0]!.length).trim();
      const amounts = [...rest.matchAll(AMOUNT_PATTERN)].map(m => m[0]);

      if (separateDebitCredit && amounts.length >= 2) {
        // Assume last two amounts are debit/credit (or credit/balance)
        // Balance is the very last amount when 3 are present
        const balanceRaw = amounts.length >= 3 ? (amounts.at(-1) ?? null) : null;
        const debitRaw = amounts[0] ?? '';
        const creditRaw = amounts[1] ?? '';
        const firstAmtIdx = rest.indexOf(debitRaw);
        const descRaw = rest.substring(0, firstAmtIdx).trim();
        pending = {
          date: parsedDate,
          descParts: [descRaw],
          debitRaw,
          creditRaw,
          balanceRaw,
          lineNum: i + 1,
        };
        flushPending();
      } else if (amounts.length >= 1) {
        const amountRaw = amounts.at(-2) ?? amounts.at(-1) ?? '';
        const balanceRaw = amounts.length >= 2 ? (amounts.at(-1) ?? null) : null;
        const firstAmtIdx = amountRaw ? rest.lastIndexOf(amountRaw) : rest.length;
        const descRaw = rest.substring(0, firstAmtIdx).trim();
        pending = {
          date: parsedDate,
          descParts: [descRaw],
          debitRaw: amountRaw,
          creditRaw: '',
          balanceRaw,
          lineNum: i + 1,
        };
        flushPending();
      } else {
        // Amount on subsequent line
        pending = {
          date: parsedDate,
          descParts: [rest],
          debitRaw: '',
          creditRaw: '',
          balanceRaw: null,
          lineNum: i + 1,
        };
      }
    } else if (pending) {
      const amounts = [...line.matchAll(AMOUNT_PATTERN)].map(m => m[0]);
      if (pending.debitRaw === '' && amounts.length > 0) {
        pending.debitRaw = amounts.at(-2) ?? amounts.at(-1) ?? '';
        pending.balanceRaw = amounts.length >= 2 ? (amounts.at(-1) ?? null) : null;
        const firstAmtIdx = line.lastIndexOf(pending.debitRaw);
        const descPart = line.substring(0, firstAmtIdx).trim();
        if (descPart) pending.descParts.push(descPart);
        flushPending();
      } else {
        pending.descParts.push(line);
      }
    }
  }

  flushPending();

  log.info('Standard Bank PDF parse complete', {
    transactions: result.transactions.length,
    errors: result.errors.length,
    accountNumber,
  }, COMPONENT);

  return result;
}

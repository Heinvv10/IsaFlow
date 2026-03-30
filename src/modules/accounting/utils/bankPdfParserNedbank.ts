/**
 * WS-8.2: Nedbank PDF Statement Parser
 *
 * Nedbank statement format characteristics:
 *   - Column headers: Date | Transaction | Amount | Balance
 *   - Date format: DD Mon YYYY  (e.g. "15 Jan 2026" or "15 January 2026")
 *   - Amounts shown with "Dr" suffix for debits, "Cr" suffix for credits
 *   - Some formats omit Dr/Cr and use signed amounts instead
 *   - Account number follows "Account Number" or "Acc No" label
 *   - Multi-line transaction descriptions are common
 */

import { log } from '@/lib/logger';
import type { BankCsvParseResult } from '../types/bank.types';
import { parseDate, parseAmount, cleanDescription, extractAccountNumber } from './bankPdfParserUtils';

const COMPONENT = 'bank-pdf-nedbank';

/**
 * Nedbank dates: "15 Jan 2026" or "15 January 2026" at line start.
 */
const DATE_AT_START = /^(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/;

/**
 * Amount with optional Dr/Cr suffix (and optional thousand separators).
 * Also handles plain signed amounts.
 */
const AMOUNT_WITH_SUFFIX = /([-]?\d{1,3}(?:[, ]\d{3})*(?:\.\d{2}))\s*(Dr|CR|Cr|dr)?/gi;
const PLAIN_AMOUNT = /[-]?\d{1,3}(?:[, ]\d{3})*(?:\.\d{2})/g;

/** Extract the last one or two amounts from a string, respecting Dr/Cr suffixes. */
function extractAmounts(s: string): Array<{ raw: string; suffix: string }> {
  const results: Array<{ raw: string; suffix: string }> = [];
  const re = /([-]?\d{1,3}(?:[, ]\d{3})*(?:\.\d{2}))\s*(Dr|CR|Cr|dr)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    results.push({ raw: m[1]!, suffix: (m[2] ?? '').toLowerCase() });
  }
  return results;
}

/** Apply Dr/Cr suffix to sign a parsed amount. */
function applyDrCr(amount: number, suffix: string): number {
  if (suffix === 'dr') return -Math.abs(amount);
  if (suffix === 'cr') return Math.abs(amount);
  return amount; // already signed if no suffix
}

export function parseNedbankStatement(text: string): BankCsvParseResult {
  const result: BankCsvParseResult = {
    transactions: [],
    errors: [],
    bankFormat: 'nedbank',
  };

  const accountNumber = extractAccountNumber(text) ?? undefined;
  const lines = text.split('\n');

  // Find header row
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = (lines[i] ?? '').toLowerCase();
    if (l.includes('date') && l.includes('transaction') && l.includes('amount')) {
      headerIndex = i;
      break;
    }
    // Alternative: "date" + "balance" is enough
    if (l.includes('date') && l.includes('balance') && l.includes('amount')) {
      headerIndex = i;
      break;
    }
  }

  const startIndex = headerIndex >= 0 ? headerIndex + 1 : 0;

  type PendingTx = {
    date: string;
    descParts: string[];
    amountRaw: string;
    amountSuffix: string;
    balanceRaw: string | null;
    balanceSuffix: string;
    lineNum: number;
  };

  let pending: PendingTx | null = null;

  const flushPending = () => {
    if (!pending) return;
    const tx = pending;
    try {
      if (!tx.amountRaw) {
        result.errors.push({ row: tx.lineNum, error: 'No amount found for transaction' });
        pending = null;
        return;
      }
      const rawAmount = parseAmount(tx.amountRaw);
      if (rawAmount === null) {
        result.errors.push({ row: tx.lineNum, error: `Invalid amount: ${tx.amountRaw}` });
        pending = null;
        return;
      }
      const amount = applyDrCr(rawAmount, tx.amountSuffix);
      const rawBalance = tx.balanceRaw ? parseAmount(tx.balanceRaw) : null;
      const balance = rawBalance !== null ? applyDrCr(rawBalance, tx.balanceSuffix) : null;

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

    // Skip header/footer lines
    if (/^(date|transaction|amount|balance|statement|page|total|opening|closing|brought forward)/i.test(line)) {
      flushPending();
      continue;
    }

    const dateMatch = line.match(DATE_AT_START);

    if (dateMatch) {
      flushPending();

      const rawDate = dateMatch[1]!;
      const parsedDate = parseDate(rawDate);
      if (!parsedDate) {
        result.errors.push({ row: i + 1, error: `Could not parse date: ${rawDate}` });
        continue;
      }

      const rest = line.substring(dateMatch[0]!.length).trim();
      const amounts = extractAmounts(rest);

      if (amounts.length === 0) {
        // Amount on subsequent lines
        pending = {
          date: parsedDate,
          descParts: [rest],
          amountRaw: '',
          amountSuffix: '',
          balanceRaw: null,
          balanceSuffix: '',
          lineNum: i + 1,
        };
        continue;
      }

      // Last amount is balance, second-to-last is transaction amount
      const amtEntry = amounts.length >= 2 ? amounts[amounts.length - 2]! : amounts[0]!;
      const balEntry = amounts.length >= 2 ? amounts[amounts.length - 1]! : null;

      // Find description: everything before the first amount
      const firstAmtPos = rest.search(PLAIN_AMOUNT);
      const descRaw = firstAmtPos > 0 ? rest.substring(0, firstAmtPos).trim() : '';

      pending = {
        date: parsedDate,
        descParts: [descRaw],
        amountRaw: amtEntry.raw,
        amountSuffix: amtEntry.suffix,
        balanceRaw: balEntry?.raw ?? null,
        balanceSuffix: balEntry?.suffix ?? '',
        lineNum: i + 1,
      };
      flushPending();
    } else if (pending) {
      const amounts = extractAmounts(line);
      if (pending.amountRaw === '' && amounts.length > 0) {
        const amtEntry = amounts.length >= 2 ? amounts[amounts.length - 2]! : amounts[0]!;
        const balEntry = amounts.length >= 2 ? amounts[amounts.length - 1]! : null;
        const firstAmtPos = line.search(PLAIN_AMOUNT);
        const descPart = firstAmtPos > 0 ? line.substring(0, firstAmtPos).trim() : '';
        if (descPart) pending.descParts.push(descPart);
        pending.amountRaw = amtEntry.raw;
        pending.amountSuffix = amtEntry.suffix;
        pending.balanceRaw = balEntry?.raw ?? null;
        pending.balanceSuffix = balEntry?.suffix ?? '';
        flushPending();
      } else {
        pending.descParts.push(line);
      }
    }
  }

  flushPending();

  log.info('Nedbank PDF parse complete', {
    transactions: result.transactions.length,
    errors: result.errors.length,
    accountNumber,
  }, COMPONENT);

  return result;
}

/**
 * WS-8.2: Capitec Bank PDF Statement Parser
 *
 * Capitec statement format characteristics:
 *   - Simpler layout than traditional banks
 *   - Column headers: Date | Description | Money In | Money Out | Balance
 *     (or: Date | Details | Deposit | Withdrawal | Balance)
 *   - Date format: DD/MM/YYYY
 *   - Separate columns for money in (credits) and money out (debits)
 *   - No Dr/Cr suffixes — sign is determined by which column the amount falls in
 *   - Account number after "Account Number" or "Acc No"
 */

import { log } from '@/lib/logger';
import type { BankCsvParseResult } from '../types/bank.types';
import { parseDate, parseAmount, cleanDescription, extractAccountNumber } from './bankPdfParserUtils';

const COMPONENT = 'bank-pdf-capitec';

/** Capitec uses DD/MM/YYYY exclusively */
const DATE_AT_START = /^(\d{2}\/\d{2}\/\d{4})/;

const AMOUNT_PATTERN = /\d{1,3}(?:[, ]\d{3})*(?:\.\d{2})/g;

/**
 * Detect column positions from a header line.
 * Returns rough character offsets for each column to disambiguate
 * "Money In" vs "Money Out" when amounts appear on the same line.
 */
function detectColumnOffsets(headerLine: string): {
  moneyIn: number;
  moneyOut: number;
  balance: number;
} {
  const lower = headerLine.toLowerCase();
  // Various Capitec header label alternatives
  const inLabels = ['money in', 'deposit', 'credit', 'in'];
  const outLabels = ['money out', 'withdrawal', 'debit', 'out'];
  const balLabels = ['balance', 'bal'];

  const findOffset = (labels: string[]): number => {
    for (const label of labels) {
      const idx = lower.indexOf(label);
      if (idx !== -1) return idx;
    }
    return -1;
  };

  return {
    moneyIn: findOffset(inLabels),
    moneyOut: findOffset(outLabels),
    balance: findOffset(balLabels),
  };
}

/**
 * Given column offsets and a content line, determine whether each numeric
 * amount belongs to the "in", "out", or "balance" column.
 */
function classifyAmounts(
  line: string,
  offsets: { moneyIn: number; moneyOut: number; balance: number },
): { inAmt: string | null; outAmt: string | null; balAmt: string | null } {
  const amounts: Array<{ raw: string; pos: number }> = [];
  const re = /\d{1,3}(?:[, ]\d{3})*(?:\.\d{2})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    amounts.push({ raw: m[0], pos: m.index });
  }

  if (amounts.length === 0) {
    return { inAmt: null, outAmt: null, balAmt: null };
  }

  // If we have column offsets, assign by proximity
  if (offsets.moneyIn > 0 && offsets.moneyOut > 0) {
    let inAmt: string | null = null;
    let outAmt: string | null = null;
    let balAmt: string | null = null;

    for (const amt of amounts) {
      const distIn = Math.abs(amt.pos - offsets.moneyIn);
      const distOut = Math.abs(amt.pos - offsets.moneyOut);
      const distBal = offsets.balance > 0 ? Math.abs(amt.pos - offsets.balance) : Infinity;
      const closest = Math.min(distIn, distOut, distBal);
      if (closest === distBal && offsets.balance > 0) {
        balAmt = amt.raw;
      } else if (closest === distIn) {
        inAmt = amt.raw;
      } else {
        outAmt = amt.raw;
      }
    }
    return { inAmt, outAmt, balAmt };
  }

  // Fallback: assume order is [in/out, balance] or [out, balance] based on count
  if (amounts.length >= 3) {
    return {
      inAmt: amounts[0]!.raw,
      outAmt: amounts[1]!.raw,
      balAmt: amounts[2]!.raw,
    };
  }
  if (amounts.length === 2) {
    // Could be [credit, balance] or [debit, balance] — we can't tell without column positions
    // Return as "out" (debit) with balance; caller can flip if needed
    return { inAmt: null, outAmt: amounts[0]!.raw, balAmt: amounts[1]!.raw };
  }
  return { inAmt: null, outAmt: amounts[0]!.raw, balAmt: null };
}

export function parseCapitecStatement(text: string): BankCsvParseResult {
  const result: BankCsvParseResult = {
    transactions: [],
    errors: [],
    bankFormat: 'capitec',
  };

  const accountNumber = extractAccountNumber(text) ?? undefined;
  const lines = text.split('\n');

  // Find header row and extract column offsets
  let headerIndex = -1;
  let colOffsets = { moneyIn: -1, moneyOut: -1, balance: -1 };

  for (let i = 0; i < lines.length; i++) {
    const l = (lines[i] ?? '').toLowerCase();
    if (
      l.includes('date') &&
      (l.includes('money') || l.includes('deposit') || l.includes('withdrawal') || l.includes('debit')) &&
      (l.includes('balance') || l.includes('amount'))
    ) {
      headerIndex = i;
      colOffsets = detectColumnOffsets(lines[i] ?? '');
      break;
    }
  }

  const startIndex = headerIndex >= 0 ? headerIndex + 1 : 0;

  for (let i = startIndex; i < lines.length; i++) {
    const rawLine = lines[i] ?? '';
    const line = rawLine.trim();
    if (!line) continue;

    // Skip header/footer noise
    if (/^(date|description|details|balance|money|deposit|withdrawal|statement|page|total|opening|closing)/i.test(line)) {
      continue;
    }

    const dateMatch = line.match(DATE_AT_START);
    if (!dateMatch) continue;

    try {
      const rawDate = dateMatch[1]!;
      const parsedDate = parseDate(rawDate);
      if (!parsedDate) {
        result.errors.push({ row: i + 1, error: `Could not parse date: ${rawDate}` });
        continue;
      }

      const rest = line.substring(dateMatch[0]!.length).trim();

      // Extract description — everything before the first numeric amount
      const firstAmtPos = rest.search(AMOUNT_PATTERN);
      const descRaw = firstAmtPos > 0 ? rest.substring(0, firstAmtPos).trim() : '';

      // Classify amounts into in/out/balance columns
      // Use the original `rawLine` for position-based classification
      const { inAmt, outAmt, balAmt } = classifyAmounts(rawLine, colOffsets);

      let amount: number | null = null;
      if (inAmt && outAmt) {
        // Both columns have values? Unusual — take the non-zero one
        const inVal = parseAmount(inAmt);
        const outVal = parseAmount(outAmt);
        if (inVal && inVal !== 0) amount = Math.abs(inVal);
        else if (outVal && outVal !== 0) amount = -Math.abs(outVal);
      } else if (inAmt) {
        const v = parseAmount(inAmt);
        if (v !== null) amount = Math.abs(v);
      } else if (outAmt) {
        const v = parseAmount(outAmt);
        if (v !== null) amount = -Math.abs(v);
      }

      if (amount === null) {
        result.errors.push({ row: i + 1, error: `No valid amount on line: ${line}` });
        continue;
      }

      const balance = balAmt ? (parseAmount(balAmt) ?? undefined) : undefined;

      result.transactions.push({
        transactionDate: parsedDate,
        description: cleanDescription(descRaw || rest),
        amount,
        balance,
      });
    } catch (err) {
      result.errors.push({
        row: i + 1,
        error: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  log.info('Capitec PDF parse complete', {
    transactions: result.transactions.length,
    errors: result.errors.length,
    accountNumber,
  }, COMPONENT);

  return result;
}

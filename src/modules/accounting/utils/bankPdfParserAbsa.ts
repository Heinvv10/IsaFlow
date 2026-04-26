/**
 * Bank PDF Parser — ABSA-specific parsing logic
 * Extracted from bankPdfParser.ts for file-size compliance.
 */

import { log } from '@/lib/logger';
import type { BankCsvParseResult } from '../types/bank.types';
import { extractAccountNumber } from './bankPdfParserUtils';

// Month name lookup for ABSA PDF date parsing ("15 Jan 2026")
const MONTH_MAP: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Parse a currency string that may contain commas, spaces, and a leading minus.
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
 * Parse ABSA statements that use DD/MM/YYYY date format and tab/space
 * separated columns (Classic Business Account PDFs).
 */
export function parseAbsaSlashDateLines(text: string): BankCsvParseResult {
  const result: BankCsvParseResult = { transactions: [], errors: [], bankFormat: 'absa' };

  const accountNumber = extractAccountNumber(text) ?? undefined;
  if (accountNumber) result.accountNumber = accountNumber;

  const lines = text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

  const datePat = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(.+)$/;
  const twoNumTail =
    /^(.*?)\s+(\d{1,3}(?:[\s,]\d{3})*\.\d{2})\s+(\d{1,3}(?:[\s,]\d{3})*\.\d{2})\s*$/;
  const oneNumTail = /^(.*?)\s+(\d{1,3}(?:[\s,]\d{3})*\.\d{2})\s*$/;
  const cleanNum = (s: string) => parseFloat(s.replace(/[\s,]/g, ''));

  let prevBalance: number | null = null;
  let lineNum = 0;

  const ignoreContinuation = (line: string): boolean => {
    if (!line) return true;
    if (/^\(Effective\s/i.test(line)) return true;
    if (/^(Balance Brought Forward|Sundry (Credits|Debits)|Charges|Total (Debits|Credits))/i.test(line)) return true;
    if (/^Page\s+\d+/i.test(line)) return true;
    if (/^(Classic Business Acc|Cheque account statement|Statement Number)/i.test(line)) return true;
    if (/^BRIGHTSPHERE|BLITZ|VELOCITY/i.test(line)) return true;
    if (/^(Return address|Reg No|Absa Bank Limited)/i.test(line)) return true;
    if (/^\d{4,}$/.test(line)) return true;
    return false;
  };

  const BOUNDARY_MARKERS = [
    /-{2,}\s*\d+\s+of\s+\d+\s*-{2,}/i,
    /Page\s+\d+\s+of\s+\d+/i,
    /Tax Invoice/i,
    /Your transactions/i,
    /Cheque Account Number/i,
    /Date\s+Transaction\s+Description/i,
    /Authorised Financial Services Provider/i,
    /Registration Number\s+\d{4}/i,
    /^CSP\d+|BFIBRE\s+\d+/i,
    /YOUR PRICING PLAN/i,
    /CREDIT INTEREST RATE/i,
    /PRICING PLAN/i,
    /CHARGE LEGEND/i,
    /VAT REGISTRATION/i,
    /NCRCP\d/i,
    /^\d{2}-\d{4}-\d{4}\b/,
    /SERVICE FEE:/i,
    /MNTHLY ACCT FEE/i,
    /Sms Notifications?/i,
    /^CHARGES\s/i,
  ] as const;

  const isPageBoundary = (line: string): boolean =>
    BOUNDARY_MARKERS.some(re => re.test(line));

  const MAX_CONT_LINES = 2;
  let stitchIdx: number | null = null;
  let stitchCount = 0;

  const appendContinuation = (line: string): void => {
    if (stitchIdx === null) return;
    if (isPageBoundary(line)) { stitchIdx = null; return; }
    if (ignoreContinuation(line)) return;
    if (stitchCount >= MAX_CONT_LINES) return;
    const last = result.transactions[stitchIdx];
    if (!last) return;
    if (last.description.toLowerCase().includes(line.toLowerCase())) return;
    last.description = `${last.description} — ${line}`;
    stitchCount++;
  };

  for (const line of lines) {
    lineNum++;
    const m = line.match(datePat);
    if (!m) { appendContinuation(line); continue; }

    const [, dd, mm, yyyy, rest] = m;
    const d = parseInt(dd!, 10), mo = parseInt(mm!, 10), y = parseInt(yyyy!, 10);
    if (d < 1 || d > 31 || mo < 1 || mo > 12 || y < 2000 || y > 2099) {
      appendContinuation(line); continue;
    }
    const transactionDate = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

    const m2 = rest!.match(twoNumTail);
    if (!m2) {
      const m1 = rest!.match(oneNumTail);
      if (m1 && /bal|brought|forward/i.test(m1[1]!)) prevBalance = cleanNum(m1[2]!);
      continue;
    }

    const rawDesc = m2[1]!.trim();
    const amountAbs = cleanNum(m2[2]!);
    const balance = cleanNum(m2[3]!);
    if (isNaN(amountAbs) || isNaN(balance)) {
      result.errors.push({ row: lineNum, error: `Invalid numeric in: ${line}` });
      continue;
    }

    let signedAmount = amountAbs;
    if (prevBalance !== null) signedAmount = Math.round((balance - prevBalance) * 100) / 100;

    const description = rawDesc
      .replace(/\s+Settlement\s+\d[\d\s,]*\.\d{2}\s+[TA]$/i, '')
      .replace(/\s+Settlement$/i, '')
      .trim();

    result.transactions.push({ transactionDate, amount: signedAmount, description, balance });
    stitchIdx = result.transactions.length - 1;
    stitchCount = 0;
    prevBalance = balance;
  }

  return result;
}

/**
 * Parse ABSA statements that use "15 Jan 2026" style dates.
 */
export function parseAbsaTextLines(text: string): BankCsvParseResult {
  const result: BankCsvParseResult = { transactions: [], errors: [], bankFormat: 'absa' };

  const accountNumber = extractAccountNumber(text) ?? undefined;
  if (accountNumber) result.accountNumber = accountNumber;

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

    result.transactions.push({
      transactionDate,
      amount,
      description: desc!.trim(),
      balance: balanceRaw ? parsePdfAmount(balanceRaw) ?? undefined : undefined,
    });
  }

  return result;
}

/**
 * Parse ABSA Investment Account statements.
 *
 * Format differences from cheque statements:
 *  - Dates: "20 Mar 2026" (same month-name style)
 *  - Amounts: SA locale — comma decimal, space thousands ("4 500 000,00")
 *  - Debits:  trailing minus suffix ("350 000,00-"), not a leading sign
 *  - Descriptions: two lines — type on the transaction line, reference on the
 *    next line ("Absa Bank Vf To Inv")
 */
export function parseAbsaInvestmentLines(text: string): BankCsvParseResult {
  const result: BankCsvParseResult = { transactions: [], errors: [], bankFormat: 'absa' };

  const accountNumber = extractAccountNumber(text) ?? undefined;
  if (accountNumber) result.accountNumber = accountNumber;

  const lines = text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

  // SA amount: 1-3 digits, optional space-separated groups of 3, comma decimal, optional trailing minus
  const saAmtPat = /(\d{1,3}(?:\s\d{3})*,\d{2}-?)/g;

  const parseSAAmount = (raw: string): number => {
    const isNeg = raw.endsWith('-');
    const n = parseFloat(raw.replace(/-$/, '').replace(/\s/g, '').replace(',', '.'));
    return isNeg ? -n : n;
  };

  const datePat = /^(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+(.+)$/i;
  const skipPat = /balance\s+brought\s+forward|total\s+(credits|debits)|balance\s+on\s+\d/i;

  let prevBalance: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const dm = line.match(datePat);
    if (!dm) continue;

    const [, day, mon, year, rest] = dm;
    const transactionDate = parseAbsaDate(day!, mon!, year!);
    if (!transactionDate) continue;
    if (skipPat.test(rest!)) {
      // Capture closing balance for sign inference
      const amts = [...rest!.matchAll(saAmtPat)];
      if (amts.length) prevBalance = parseSAAmount(amts[amts.length - 1]![1]!);
      continue;
    }

    const amts = [...rest!.matchAll(saAmtPat)];
    if (amts.length < 2) continue;

    const txMatch = amts[amts.length - 2]!;
    const balMatch = amts[amts.length - 1]!;
    const balance = parseSAAmount(balMatch[1]!);
    const rawTx = txMatch[1]!;

    // Sign: trailing minus = debit; otherwise derive from balance delta
    let amount: number;
    if (rawTx.endsWith('-')) {
      amount = parseSAAmount(rawTx);
    } else if (prevBalance !== null) {
      amount = Math.round((balance - prevBalance) * 100) / 100;
    } else {
      amount = parseSAAmount(rawTx);
    }

    const descEnd = txMatch.index!;
    const description = rest!.substring(0, descEnd).trim();

    // Grab continuation line (reference such as "Absa Bank Vf To Inv")
    let fullDesc = description;
    if (i + 1 < lines.length) {
      const next = lines[i + 1]!;
      if (!next.match(datePat)) {
        fullDesc = description ? `${description} — ${next}` : next;
        i++;
      }
    }

    result.transactions.push({ transactionDate, amount, description: fullDesc, balance });
    prevBalance = balance;
  }

  return result;
}

/**
 * Public entry point: detect format and delegate.
 * Investment Account uses SA locale amounts — try it when the header says so.
 */
export function parseAbsaPdfText(text: string): BankCsvParseResult {
  log.info('Parsing ABSA PDF text', { textLength: text.length }, 'accounting-pdf');

  if (/investment\s+account/i.test(text)) {
    const invResult = parseAbsaInvestmentLines(text);
    if (invResult.transactions.length > 0) return invResult;
  }

  const slashResult = parseAbsaSlashDateLines(text);
  if (slashResult.transactions.length > 0) return slashResult;
  return parseAbsaTextLines(text);
}

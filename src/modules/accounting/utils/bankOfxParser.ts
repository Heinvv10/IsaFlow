/**
 * PRD-060: FibreFlow Accounting Module
 * OFX Bank Statement Parser
 *
 * Parses Open Financial Exchange (OFX) files — an XML-like format
 * used by South African and international banks for statement exports.
 *
 * Supports both SGML-style OFX (1.x) and XML OFX (2.x).
 * Uses regex parsing only — no external dependencies required.
 */

import { log } from '@/lib/logger';
import type { ParsedBankTransaction, BankCsvParseResult } from '../types/bank.types';

// ── Tag extraction helpers ────────────────────────────────────────────────────

/**
 * Extract the text value of a single OFX tag from a block of content.
 * Handles both self-closing and paired tags.
 *
 * @example
 * extractTag('<TRNAMT>-500.00</TRNAMT>', 'TRNAMT') === '-500.00'
 * extractTag('<DTPOSTED>20260115\n<TRNAMT>', 'DTPOSTED') === '20260115'
 */
function extractTag(content: string, tag: string): string | null {
  // Try paired tag first: <TAG>value</TAG>
  const pairedRe = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i');
  const pairedMatch = pairedRe.exec(content);
  if (pairedMatch) return pairedMatch[1]!.trim();

  // SGML OFX 1.x: <TAG>value\n<NEXTTAG> — value ends at newline or next tag
  const sgmlRe = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i');
  const sgmlMatch = sgmlRe.exec(content);
  if (sgmlMatch) return sgmlMatch[1]!.trim();

  return null;
}

/**
 * Extract all blocks between <TAG> ... </TAG> pairs.
 * Also handles SGML OFX where blocks end at </TAG> or the next sibling open tag.
 */
function extractBlocks(content: string, tag: string): string[] {
  const blocks: string[] = [];

  // XML-style paired tags
  const pairedRe = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = pairedRe.exec(content)) !== null) {
    blocks.push(match[1]!);
  }

  if (blocks.length > 0) return blocks;

  // SGML 1.x — no closing tags; split on <STMTTRN> and take until next sibling
  const sgmlRe = new RegExp(`<${tag}>([\\s\\S]*?)(?=<${tag}>|<\\/(?:BANKTRANLIST|STMTRS|OFX)>|$)`, 'gi');
  while ((match = sgmlRe.exec(content)) !== null) {
    if (match[1]!.trim()) blocks.push(match[1]!);
  }

  return blocks;
}

// ── Date Conversion ───────────────────────────────────────────────────────────

/**
 * Convert OFX date string to YYYY-MM-DD.
 * OFX dates: YYYYMMDD, YYYYMMDDHHMMSS, or YYYYMMDDHHMMSS.XXX[TZ]
 */
function parseOfxDate(dateStr: string): string | null {
  if (!dateStr) return null;
  const cleaned = dateStr.trim().replace(/\[.*\]/, ''); // strip timezone bracket
  // Take first 8 chars: YYYYMMDD
  const ymd = cleaned.slice(0, 8);
  if (ymd.length !== 8) return null;

  const year = ymd.slice(0, 4);
  const month = ymd.slice(4, 6);
  const day = ymd.slice(6, 8);

  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  const d = parseInt(day, 10);

  if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;

  return `${year}-${month}-${day}`;
}

// ── Main Parser ───────────────────────────────────────────────────────────────

/**
 * Parse an OFX bank statement file into a list of transactions.
 *
 * @param content - Raw OFX file content as string
 * @returns BankCsvParseResult with parsed transactions and any per-row errors
 */
export function parseOfxStatement(content: string): BankCsvParseResult {
  const result: BankCsvParseResult = {
    transactions: [],
    errors: [],
    bankFormat: 'ofx',
  };

  if (!content || content.trim() === '') {
    result.errors.push({ row: 0, error: 'Empty OFX content' });
    return result;
  }

  // Extract closing balance if present
  let closingBalance: number | undefined;
  const balAmtRaw = extractTag(content, 'BALAMT');
  if (balAmtRaw !== null) {
    const parsed = parseFloat(balAmtRaw);
    if (!isNaN(parsed)) closingBalance = parsed;
  }

  // Extract transaction blocks
  const txBlocks = extractBlocks(content, 'STMTTRN');

  if (txBlocks.length === 0) {
    result.errors.push({ row: 0, error: 'No STMTTRN transaction blocks found in OFX content' });
    return result;
  }

  txBlocks.forEach((block, idx) => {
    const rowNum = idx + 1;

    // Date
    const dateRaw = extractTag(block, 'DTPOSTED');
    if (!dateRaw) {
      result.errors.push({ row: rowNum, error: 'Missing DTPOSTED date tag' });
      return;
    }
    const transactionDate = parseOfxDate(dateRaw);
    if (!transactionDate) {
      result.errors.push({ row: rowNum, error: `Invalid DTPOSTED date: ${dateRaw}` });
      return;
    }

    // Amount
    const amtRaw = extractTag(block, 'TRNAMT');
    if (!amtRaw) {
      result.errors.push({ row: rowNum, error: 'Missing TRNAMT amount tag' });
      return;
    }
    const amount = parseFloat(amtRaw.replace(/,/g, ''));
    if (isNaN(amount)) {
      result.errors.push({ row: rowNum, error: `Invalid TRNAMT amount: ${amtRaw}` });
      return;
    }

    // Description — prefer MEMO, fall back to NAME
    const memo = extractTag(block, 'MEMO');
    const name = extractTag(block, 'NAME');
    const description = (memo || name || '').trim();
    if (!description) {
      result.errors.push({ row: rowNum, error: 'Missing MEMO/NAME description' });
      return;
    }

    // Reference (FITID = bank-assigned transaction ID)
    const fitid = extractTag(block, 'FITID');
    const checkNum = extractTag(block, 'CHECKNUM');

    const tx: ParsedBankTransaction = {
      transactionDate,
      amount,
      description,
      reference: checkNum ?? undefined,
      balance: closingBalance,
    };

    // Store bank's transaction ID in bankReference via reference if no checkNum
    if (!checkNum && fitid) {
      tx.reference = fitid;
    }

    result.transactions.push(tx);
  });

  log.info('Parsed OFX statement', {
    transactionCount: result.transactions.length,
    errorCount: result.errors.length,
    closingBalance,
  }, 'accounting');

  return result;
}

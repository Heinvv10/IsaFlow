/**
 * MT940 Bank Statement Parser
 *
 * Parses SWIFT MT940 "Customer Statement Message" files — the format exported
 * by South African business/corporate online banking (Standard Bank BusinessOnline,
 * FNB Online Banking Enterprise, Nedbank business). Common file extensions: .sta,
 * .mt940, .940. Output conforms to BankCsvParseResult, identical to the OFX/CSV/QIF
 * parsers, so it drops straight into bankStatementParseService's dispatch.
 *
 * Regex parsing only — no external dependencies.
 *
 * Relevant tags:
 *   :25:  Account identification           → accountNumber
 *   :61:  Statement line (one per txn)      → date + signed amount + reference
 *   :86:  Information to account owner      → free-text description (may continue
 *                                              over multiple lines)
 * Opening/closing balances (:60F:/:62F:) are not per-line, so we do not synthesise
 * a running balance — `balance` is left undefined (faithful to the source).
 */

import { log } from '@/lib/logger';
import type { ParsedBankTransaction, BankCsvParseResult } from '../types/bank.types';

// ── Tag grouping ──────────────────────────────────────────────────────────────

interface Mt940Tag {
  tag: string;       // e.g. '25', '61', '86'
  value: string[];   // first-line content + continuation lines
}

const TAG_RE = /^:(\d{2}[A-Z]?):(.*)$/;

/**
 * Split raw MT940 text into ordered (tag, value-lines) groups. A line that opens
 * a new `:NN:` tag starts a group; subsequent lines without a tag prefix are
 * continuation of the current tag's value (e.g. multi-line :86: descriptions).
 */
function groupTags(content: string): Mt940Tag[] {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const tags: Mt940Tag[] = [];
  let current: Mt940Tag | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (line === '' || line === '-') continue; // blank / end-of-block marker
    const m = TAG_RE.exec(line);
    if (m) {
      if (current) tags.push(current);
      current = { tag: m[1]!.replace(/[A-Z]$/, ''), value: [m[2]!] };
    } else if (current) {
      current.value.push(line);
    }
    // A continuation line before any tag is preamble noise — ignore.
  }
  if (current) tags.push(current);
  return tags;
}

// ── Field parsing ─────────────────────────────────────────────────────────────

/** Normalise a :25: account identification to a bare account number. */
function parseAccountNumber(value: string): string | undefined {
  const tail = value.includes('/') ? value.slice(value.lastIndexOf('/') + 1) : value;
  const cleaned = tail.replace(/[\s-]/g, '').trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/** YYMMDD → YYYY-MM-DD (pivot: 00–69 → 2000s, 70–99 → 1900s). Null if invalid. */
function parseYYMMDD(s: string): string | null {
  if (!/^\d{6}$/.test(s)) return null;
  const yy = Number(s.slice(0, 2));
  const mm = Number(s.slice(2, 4));
  const dd = Number(s.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const year = yy <= 69 ? 2000 + yy : 1900 + yy;
  return `${year}-${s.slice(2, 4)}-${s.slice(4, 6)}`;
}

/**
 * MT940 amounts use a comma decimal separator and no thousands grouping,
 * e.g. `1500,50` → 1500.5. The debit/credit mark carries the sign.
 */
function parseAmount(raw: string, mark: string): number | null {
  const n = Number(raw.replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  // C = credit (+), D = debit (−), RC = reversal of credit (net −),
  // RD = reversal of debit (net +).
  const negative = mark === 'D' || mark === 'RC';
  return negative ? -Math.abs(n) : Math.abs(n);
}

// :61: value date(6) [entry date(4)] mark fundsCode? amount typeCode? refs
// The transaction-type code is `1!a3!c` (one letter + 3 chars); the spec
// restricts the letter to N/F/S but some banks emit other letters, so accept
// any. It is mandatory, so consuming 4 chars after the amount is always right.
const LINE_RE = /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?([0-9,]+)(?:[A-Z][A-Z0-9]{3})?(.*)$/;

interface Mt940Line {
  transactionDate: string;
  amount: number;
  reference?: string;
}

/** Parse a single :61: statement line. Returns null on a malformed line. */
function parseStatementLine(value: string): Mt940Line | null {
  const m = LINE_RE.exec(value.trim());
  if (!m) return null;
  const transactionDate = parseYYMMDD(m[1]!);
  if (!transactionDate) return null;
  const amount = parseAmount(m[5]!, m[3]!);
  if (amount === null) return null;
  // Refs: customer reference, optionally `//` bank reference.
  const refPart = (m[6] ?? '').trim();
  const [ownerRef, bankRef] = refPart.split('//');
  const reference = (ownerRef && ownerRef.trim()) || (bankRef && bankRef.trim()) || undefined;
  return { transactionDate, amount, reference };
}

/** Collapse a multi-line :86: into a single description, stripping SWIFT subfield markers. */
function cleanDescription(lines: string[]): string {
  return lines
    .join(' ')
    .replace(/\?\d{2}/g, ' ') // structured subfield markers (?20, ?00, …) → space
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Public entrypoint ─────────────────────────────────────────────────────────

export function parseMt940Statement(content: string): BankCsvParseResult {
  const result: BankCsvParseResult = { transactions: [], errors: [], bankFormat: 'mt940' };
  const tags = groupTags(content);

  let pendingLine: Mt940Line | null = null;
  let lineCounter = 0;

  const flush = (description: string) => {
    if (!pendingLine) return;
    const tx: ParsedBankTransaction = {
      transactionDate: pendingLine.transactionDate,
      amount: pendingLine.amount,
      description: description || pendingLine.reference || 'MT940 transaction',
    };
    if (pendingLine.reference) tx.reference = pendingLine.reference;
    result.transactions.push(tx);
    pendingLine = null;
  };

  for (const { tag, value } of tags) {
    if (tag === '25' && !result.accountNumber) {
      result.accountNumber = parseAccountNumber(value.join(''));
    } else if (tag === '61') {
      // A new statement line: emit any prior line that had no :86: description.
      flush('');
      lineCounter += 1;
      pendingLine = parseStatementLine(value[0] ?? '');
      if (!pendingLine) {
        result.errors.push({ row: lineCounter, error: `Malformed :61: line: ${(value[0] ?? '').slice(0, 60)}` });
      }
    } else if (tag === '86') {
      flush(cleanDescription(value));
    }
  }
  flush(''); // trailing :61: with no :86:

  log.info('Parsed MT940 statement', {
    transactionCount: result.transactions.length,
    errorCount: result.errors.length,
    accountNumber: result.accountNumber,
  }, 'accounting');

  return result;
}

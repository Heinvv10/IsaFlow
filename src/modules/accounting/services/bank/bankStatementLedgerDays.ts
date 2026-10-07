/**
 * The import step's half of the ledger-date window for statement lines (sec-numrace S5). parseStatement checks every
 * canonical YYYY-MM-DD a parser emits; any other date it kept (a timestamp, say: '0001-06-01T00:00:00') is read here
 * by Postgres (gl/journalDateGuard.ledgerDaysOf). A day outside 1900-01-01..2199-12-31 becomes a row error and the
 * rest imports; the day Postgres reads is what is stored; a date it cannot read is left to fail at its INSERT, as
 * before the window.
 */
import type { BankCsvParseResult } from '../../types/bank.types';
import { journalDayWindowError } from '../../utils/journalDateWindow';
import { ledgerDaysOf } from '../gl/journalDateGuard';

export async function withLedgerDays(result: BankCsvParseResult): Promise<BankCsvParseResult> {
  const days = await ledgerDaysOf(result.transactions.map((t) => String(t.transactionDate)));
  const transactions: BankCsvParseResult['transactions'] = [];
  const errors = [...result.errors];
  for (const t of result.transactions) {
    const day = days.get(String(t.transactionDate)) ?? null;
    const outside = day === null ? null : journalDayWindowError(day);
    if (outside) {
      errors.push({ row: 0, error: `${outside} (${String(t.description ?? '').slice(0, 60)})` });
      continue;
    }
    transactions.push(day === null ? t : { ...t, transactionDate: day });
  }
  return { ...result, transactions, errors };
}

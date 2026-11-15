/**
 * Is a journal line THIS statement line's bank movement? The one rule every writer that binds
 * `bank_transactions.matched_journal_line_id` to an EXISTING journal line applies (audit row 4).
 *
 * A statement line is one movement on one bank account: money in debits that account's GL, money out credits it, for
 * the amount on the statement. So the line it is matched to must be
 *   - on the statement line's own GL bank account (`bank_transactions.bank_account_id` is a `gl_accounts` id),
 *   - in its direction and for its exact amount — together: `debit - credit = amount`, to the cent,
 *   - on a POSTED journal (a draft has moved no money).
 * Same company is the caller's lookup (every read is company-scoped; another company's line is "not found").
 *
 * Without it a R500 payment could be matched to a R500.01 line, to the other bank's leg of a transfer, to the expense
 * leg of a journal, to a deposit, or to a draft — and the statement line read as reconciled against money its bank
 * account never moved.
 *
 * Two forms of the same predicate, kept side by side so they cannot drift apart unseen:
 *   - `matchTargetMisfit` — the hand match (`matchTransaction`, so the `journal_line` / `bank_transfer` confirm arms,
 *     the `match` action and auto-match), on the bank row it has locked and the line it has read;
 *   - `lineFitsBankLineFragment` — the set-based transfer link writers (`bankTransferLinkService`,
 *     `applyTransferLinks`, `autoLinkCounterpartyTransfer`), which bind lines in SQL.
 * Both compare NUMERIC(15,2) columns: the SQL form compares them exactly, the TS form in integer cents.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { formatCents } from '@/lib/money/formatMoney';
import { toCents } from '../ap/billAllocatable';
import { BankMatchTargetError } from './bankTxStatusErrors';

const rand = (cents: number): string => formatCents(Math.abs(cents));
const way = (cents: number): string => (cents > 0 ? 'money in' : cents < 0 ? 'money out' : 'no movement');

/**
 * The refusal for a journal line that is not this statement line's bank movement, or null when it is.
 *
 * @param bank The LOCKED bank row (`lockBankTransactionForUpdate`'s `SELECT *`): `bank_account_id`, `amount`.
 * @param line The journal line read company-scoped: `gl_account_id`, `debit`, `credit`, and its journal's status as
 *   `journal_status`.
 */
export function matchTargetMisfit(bank: DbRow, line: DbRow, journalLineId: string): BankMatchTargetError | null {
  if (String(line.gl_account_id) !== String(bank.bank_account_id)) {
    return new BankMatchTargetError('LINE_WRONG_ACCOUNT', `Journal line ${journalLineId} is not on this statement `
      + 'line\'s bank account. A match must be the bank account\'s own leg of the journal.');
  }
  const lineNet = toCents(Number(line.debit ?? 0)) - toCents(Number(line.credit ?? 0));
  const bankNet = toCents(Number(bank.amount));
  if (Math.sign(lineNet) !== Math.sign(bankNet)) {
    return new BankMatchTargetError('LINE_WRONG_DIRECTION', `Journal line ${journalLineId} is ${way(lineNet)} on the `
      + `bank account but this statement line is ${way(bankNet)}: a match must go the same direction.`);
  }
  if (lineNet !== bankNet) {
    return new BankMatchTargetError('LINE_WRONG_AMOUNT', `Journal line ${journalLineId} is ${rand(lineNet)} but this `
      + `statement line is ${rand(bankNet)}. A match must be for the exact amount — split the line or correct the journal.`);
  }
  if (String(line.journal_status) !== 'posted') {
    return new BankMatchTargetError('LINE_NOT_POSTED', `Journal line ${journalLineId} belongs to a journal that is not `
      + 'posted. Post the journal first.');
  }
  return null;
}

/** The column references the fragment may correlate on. A closed set: no caller can splice a value in. */
type FitLineAlias = 'jl' | 'jt' | 'l';
type FitBankAlias = 'n' | 'bt' | 'bt_new';

/**
 * TRUE when journal line `line` is bank line `bank`'s own movement: its account, and `debit - credit = amount`
 * exactly (direction and amount at once). The caller scopes both rows to the company and checks the journal posted
 * (each writer already joins `gl_journal_entries` with `status = 'posted'`). One `sql.unsafe`, interpolation only.
 */
export function lineFitsBankLineFragment(line: FitLineAlias, bank: FitBankAlias) {
  return sql.unsafe(
    `(${line}.gl_account_id = ${bank}.bank_account_id AND (${line}.debit - ${line}.credit) = ${bank}.amount)`);
}

/**
 * Master plan U: the reads and small seeds the Undo integration suites share, over the L1 FIFO fixture.
 */
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { inTx, seedBankTx, type Fixture } from './l1FifoFixture';

export async function contraCount(fx: Fixture, journalEntryId: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::INT AS n FROM gl_journal_entries
    WHERE company_id = ${fx.companyId}::UUID AND reversal_of_id = ${journalEntryId}::UUID`) as { n: number }[];
  return rows[0]!.n;
}

export async function lineState(fx: Fixture, txId: string): Promise<{ status: string; matched: string | null }> {
  const rows = (await sql`
    SELECT status, matched_journal_line_id::TEXT AS matched FROM bank_transactions
    WHERE id = ${txId}::UUID AND company_id = ${fx.companyId}::UUID`) as { status: string; matched: string | null }[];
  return rows[0]!;
}

export async function expenseAccount(fx: Fixture): Promise<string> {
  const found = (await sql`
    SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_code = ${'U-EXP'}`) as { id: string }[];
  if (found[0]) return found[0].id;
  return ((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance)
    VALUES (${fx.companyId}::UUID, ${'U-EXP'}, ${'Undo expense'}, 'expense', 'debit') RETURNING id`) as { id: string }[])[0]!.id;
}

/** The journal's line on `glAccountId`. */
export async function journalLineOn(fx: Fixture, journalEntryId: string, glAccountId: string): Promise<string> {
  const rows = (await sql`
    SELECT id FROM gl_journal_lines
    WHERE journal_entry_id = ${journalEntryId}::UUID AND company_id = ${fx.companyId}::UUID
      AND gl_account_id = ${glAccountId}::UUID`) as { id: string }[];
  return rows[0]!.id;
}

/** A posted journal line no bank line claims: the contra of an allocation on a line of its own. */
export async function unclaimedLine(fx: Fixture): Promise<string> {
  const contra = await expenseAccount(fx);
  const tx = await seedBankTx(fx, { date: '2026-03-06', amount: -10, description: 'SOURCE LINE' });
  const { journalEntryId } = await inTx(fx, () => allocateTransaction(fx.companyId, tx, contra, fx.userId));
  return journalLineOn(fx, journalEntryId, contra);
}

/** A second bank GL account: what a transfer's other leg sits on. */
export async function secondBank(fx: Fixture): Promise<string> {
  return ((await sql`
    INSERT INTO gl_accounts
      (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
    VALUES (${fx.companyId}::UUID, ${`B2-${randomUUID().slice(0, 8)}`}, ${'Second bank'}, 'asset', 'bank', 'debit', true)
    RETURNING id`) as { id: string }[])[0]!.id;
}

/** A statement line on `bankAccountId`, which seedBankTx's fixture bank is not. */
export async function seedLineOn(
  fx: Fixture, bankAccountId: string, args: { date: string; amount: number; description: string },
): Promise<string> {
  const rows = (await sql`
    INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
    VALUES (${fx.companyId}::UUID, ${bankAccountId}::UUID, ${args.date}::DATE, ${args.amount}, ${args.description}, 'imported')
    RETURNING id`) as { id: string }[];
  return rows[0]!.id;
}

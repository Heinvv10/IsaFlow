/**
 * A bank line coded to an ACCOUNT whose contra is itself a bank account is a TRANSFER (WP2 row 5, Hein's decision).
 *
 * Coded as an account it posted DR/CR between the two banks through the account arm: no duplicate guard, no pair lock
 * and no leg pairing, so the other bank's line — allocated the same way, or its own transfer — posted the movement a
 * second time. Routed through the transfer arm it gets all three. A contra that IS the line's own bank account posts a
 * journal that moves nothing (DR bank / CR the same bank): refused, before any write.
 *
 * Where each path lands: `allocateTransaction` reroutes (the screen, the MCP allocate and bulk tools, the confidence
 * gate all reach it); the rule sweep reroutes through `allocateTransaction` too (bankRuleTransferLine); the gate's
 * import branch (provisional posting) refuses, because a provisional journal is not a transfer.
 */
import { sql } from '@/lib/neon';
import { isBankSubtype } from '../gl/accountSubtypes';
import { BankAllocationRefusal } from './bankAllocationRefusal';
import type { AllocationType } from './bankAllocationTypes';

export const OWN_BANK_CONTRA_MESSAGE = 'The contra account is this line\'s own bank account: the journal would move '
  + 'nothing. Choose the other bank account (a transfer) or the account the money went to.';

/**
 * A sweep row refused as "already allocated" because an earlier row's transfer auto-linked it as the other leg: the
 * skip names that transfer ("paired with transfer JE-…"). Null for any other refusal. One read, after the row's
 * savepoint rolled back.
 */
export async function pairedTransferSkip(companyId: string, bankTxId: string, err: unknown): Promise<string | null> {
  if (!(err instanceof BankAllocationRefusal) || !/^Transaction already allocated/.test(err.message)) return null;
  const [row] = (await sql`
    SELECT je.entry_number FROM bank_transactions bt
    JOIN gl_journal_entries je ON je.id = bt.transfer_journal_entry_id AND je.company_id = bt.company_id
    WHERE bt.id = ${bankTxId}::UUID AND bt.company_id = ${companyId}::UUID AND bt.status = 'allocated'
  `) as Array<{ entry_number: string }>;
  return row ? `paired with transfer ${row.entry_number}` : null;
}

/** Is `accountId` a bank-subtype account of this company? */
export async function isBankContra(companyId: string, accountId: string | null | undefined): Promise<boolean> {
  if (!accountId) return false;
  const [row] = (await sql`
    SELECT account_subtype FROM gl_accounts WHERE id = ${accountId}::UUID AND company_id = ${companyId}::UUID
  `) as Array<{ account_subtype: string | null }>;
  return Boolean(row) && isBankSubtype(row!.account_subtype);
}

/**
 * The arms that post the bank's other leg to `contraAccountId`: the account arm, and a supplier/customer call naming
 * no contact, which falls through to it (bankAllocationArms) — no caller sends that shape today, but it must not post
 * bank-to-bank past the transfer arm either.
 */
export function postsToContraAccount(allocType: AllocationType, entityId: string | null | undefined): boolean {
  return allocType === 'account' || ((allocType === 'supplier' || allocType === 'customer') && !entityId);
}

/** The line's own bank as the contra of an arm posting to it: a `BankAllocationRefusal` (400). The transfer arm refuses its own twin. */
export function refuseOwnBankContra(
  allocType: AllocationType, entityId: string | null | undefined, contraAccountId: string | null, bankAccountId: string,
): void {
  if (postsToContraAccount(allocType, entityId) && contraAccountId
    && contraAccountId.toLowerCase() === bankAccountId.toLowerCase()) {
    throw new BankAllocationRefusal(OWN_BANK_CONTRA_MESSAGE);
  }
}

/**
 * WP2 row 5 round 2 (lead's ruling): a SPLIT part or a reconciliation ADJUSTMENT onto a bank account posts bank-to-bank
 * with none of the transfer arm's guards (duplicate, pair lock, leg pairing) — refused, before any write, from the
 * subtype the caller already read. Null for any other account.
 */
export function bankContraRefusal(rawSubtype: unknown, how: 'split line' | 'adjustment'): BankAllocationRefusal | null {
  if (!isBankSubtype(typeof rawSubtype === 'string' ? rawSubtype : null)) return null;
  return new BankAllocationRefusal(how === 'split line'
    ? 'A split line posts to a bank account: a transfer can\'t be split; allocate it as a transfer.'
    : 'A bank reconciliation adjustment can\'t post to a bank account: that is a transfer — allocate the statement '
      + 'line as a transfer instead.');
}

/** An account allocation whose contra row (the plan's read, `account_subtype`) is a bank account: post a transfer. */
export function isBankContraPlan(allocType: AllocationType, contraRows: ReadonlyArray<{ account_subtype?: unknown }>): boolean {
  const subtype = contraRows[0]?.account_subtype;
  return allocType === 'account' && isBankSubtype(subtype == null ? null : String(subtype));
}

/** The bank-subtype accounts among `accountIds` (one read), lower-cased. */
export async function bankAccountsAmong(companyId: string, accountIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(accountIds.filter(Boolean).map((a) => a.toLowerCase()))];
  if (ids.length === 0) return new Set();
  const rows = (await sql`
    SELECT id::TEXT AS id, account_subtype FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[])
  `) as Array<{ id: string; account_subtype: string | null }>;
  return new Set(rows.filter((r) => isBankSubtype(r.account_subtype)).map((r) => r.id.toLowerCase()));
}

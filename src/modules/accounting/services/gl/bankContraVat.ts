/**
 * A rule whose contra account IS a bank account moves money between the
 * company's own accounts. No supply arises, so no VAT may be claimed on it.
 *
 * WHY A RULE CAN EXPRESS THIS AT ALL. `allocateTransaction` has a dedicated
 * `transfer` alloc type, but `bank_categorisation_rules` has no column for one:
 * a transfer rule stores the counterparty bank in `gl_account_id` and sets
 * neither `supplier_id` nor `client_id`, so `bankRulesMatchingService` derives
 * `allocType: 'account'` for it — the one arm that still splits 15% exclusive.
 * The rules screen now refuses to CREATE such a rule with a VAT code, but rows
 * saved before that keep sweeping, and the non-supply guard cannot catch them:
 * it classifies on account NAME, and "FNB Cheque Account" reads like any other.
 *
 * Judged on `account_subtype`, which is the same fact the transfer arm of
 * `allocateTransaction` already requires of a counterparty ("Transfer
 * counterparty must be a bank account"). Reported as a NON-SUPPLY rather than
 * as a new outcome, because that is exactly what it is — the sweep's
 * `autoPostNonSupply` counter and the MCP `no_supply` reason both stay honest.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { isBankSubtype } from './accountSubtypes';

/**
 * Batched lookup: one query for a whole rule sweep, mirroring
 * `fetchAccountNames` and `fetchVatDenialFlags`. Absent from the map means the
 * account was not asked about, never "not a bank" — callers that batch must
 * pass every id they will judge.
 */
export async function fetchBankContraFlags(
  companyId: string,
  glAccountIds: string[],
): Promise<Map<string, boolean>> {
  const ids = [...new Set(glAccountIds.filter(Boolean))];
  if (ids.length === 0) return new Map();

  const rows = (await sql`
    SELECT id, account_subtype
    FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[])
  `) as DbRow[];

  return new Map(rows.map((r) => [
    String(r.id), isBankSubtype(r.account_subtype == null ? null : String(r.account_subtype)),
  ]));
}

/**
 * Single-account form, for a caller that has an id and no pre-resolved flag.
 * Its own SELECT for the same reason `resolveNonSupplyForAccount` has one.
 */
export async function resolveBankContraForAccount(
  companyId: string,
  glAccountId: string | null | undefined,
): Promise<boolean> {
  if (!glAccountId) return false;
  const rows = (await sql`
    SELECT account_subtype FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND id = ${glAccountId}::UUID
    LIMIT 1
  `) as DbRow[];
  return rows.length > 0
    && isBankSubtype(rows[0]!.account_subtype == null ? null : String(rows[0]!.account_subtype));
}

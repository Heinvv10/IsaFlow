/**
 * Input-tax denial on entertainment accounts — VAT Act s17(2)(a).
 *
 * SARS denies input tax on entertainment: food, beverages and hospitality,
 * whether the guest is staff or a client. Nothing in the posting paths knew
 * that, so every bank rule pointing at Staff Welfare carried
 * `vat_code = 'standard'` and each restaurant charge was split 15% exclusive
 * with the tax debited to VAT Input.
 *
 * `gl_accounts.default_vat_code = 'none'` is the denial marker. It reads as an
 * OVERRIDE, not a default: a caller asking for standard VAT against such an
 * account is coerced to 'none' and the coercion is logged. Every account that
 * carried 'none' before migration 521 is a balance-sheet or loan account, where
 * the coercion changes nothing.
 *
 * The POLICY is `applyVatDenial` — pure, no I/O — so a caller that already has
 * the account row (allocateTransaction reads it anyway) spends no extra query,
 * and a caller that has only an id uses the `resolve*` wrappers. Every posting
 * and suggestion path goes through one of the three, so they cannot disagree
 * about the same account again.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/lib/neon';

/** The vat code that claims no input tax. */
export const VAT_CODE_NONE = 'none';

export interface VatResolution {
  /** The code the journal must actually be posted with. */
  vatCode: string;
  /** True when the account's denial overrode what the caller asked for. */
  denied: boolean;
}

/**
 * The policy itself. `accountDefaultVatCode` is the account's stored
 * `default_vat_code`; pass null when no account applies — supplier and customer
 * allocations post the tax against their AP/AR control account, not an expense
 * account — and the requested code passes through untouched.
 */
export function applyVatDenial(
  accountDefaultVatCode: string | null | undefined,
  requestedVatCode: string | null | undefined,
  context: Record<string, unknown> = {},
): VatResolution {
  const requested = requestedVatCode || VAT_CODE_NONE;
  if (requested === VAT_CODE_NONE) return { vatCode: requested, denied: false };
  if (String(accountDefaultVatCode || '') !== VAT_CODE_NONE) {
    return { vatCode: requested, denied: false };
  }

  log.warn(
    'Input VAT denied on this account (s17(2)(a)) — posting the gross amount instead',
    { requestedVatCode: requested, ...context },
    'accounting',
  );
  return { vatCode: VAT_CODE_NONE, denied: true };
}

/** `applyVatDenial` for a caller holding only an account id. One query. */
export async function resolveVatCodeForAccount(
  companyId: string,
  glAccountId: string | null | undefined,
  requestedVatCode: string | null | undefined,
  context: Record<string, unknown> = {},
): Promise<VatResolution> {
  const requested = requestedVatCode || VAT_CODE_NONE;
  if (!glAccountId || requested === VAT_CODE_NONE) {
    return { vatCode: requested, denied: false };
  }

  const rows = (await sql`
    SELECT default_vat_code, account_code, account_name
    FROM gl_accounts
    WHERE id = ${glAccountId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];

  const account = rows[0];
  return applyVatDenial(account?.default_vat_code as string | undefined, requested, {
    companyId,
    glAccountId,
    accountCode: account?.account_code,
    accountName: account?.account_name,
    ...context,
  });
}

/**
 * Batched form for split allocations: one query for every leg, rather than one
 * query per leg. Returns `default_vat_code` keyed by account id.
 */
export async function fetchDefaultVatCodes(
  companyId: string,
  glAccountIds: string[],
): Promise<Map<string, string | null>> {
  const ids = [...new Set(glAccountIds.filter(Boolean))];
  if (ids.length === 0) return new Map();

  const rows = (await sql`
    SELECT id, default_vat_code
    FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[])
  `) as DbRow[];

  return new Map(rows.map((r) => [
    String(r.id),
    r.default_vat_code ? String(r.default_vat_code) : null,
  ]));
}

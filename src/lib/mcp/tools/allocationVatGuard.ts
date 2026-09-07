/**
 * The VAT guard for the MCP allocation path, and its batch prefetch.
 *
 * WHY THIS PATH GUARDS AT ALL. Every one of the 35 non-supply VAT lines in
 * production was posted by `mcp:bulk_allocate_bank_transactions:v1` —
 * Velocity's 34 salary lines (R237,021.60 of manufactured input tax) and
 * Brightsphere's investment disposal (R9,782.61). None by a human, by the rule
 * sweep, by the confidence gate or by provisional posting. That tool posts
 * ~8,200 of the ~10,900 bank allocations in the ledger.
 *
 * `allocateTransaction` coerces nothing BY DESIGN — it is the ATTENDED path,
 * where a screen showed the warning and the user's choice stands. Nothing shows
 * a warning here: the party choosing the code is an LLM, the tool posts
 * immediately with no review step, and a connector consent grant authorises the
 * connector once rather than this VAT choice per call. So this path behaves
 * like the other unattended posters and coerces, through the same funnel.
 *
 * WHY THE PREFETCH. `resolveRuleVatCode` batches when the caller has already
 * resolved the account's denial flag and name; otherwise it looks both up per
 * line. Unbatched, a 500-line bulk call of `standard`-coded account lines runs
 * up to 1,000 sequential SELECTs inside the per-line savepoint loop — and that
 * is not an edge case, it is precisely the salary batch this guard exists for.
 * `prefetchAllocationVatFacts` resolves every distinct contra account in two
 * queries; the per-line path stays as the fallback, because an ABSENT fact must
 * mean "look it up", never "skip the check".
 */

import {
  fetchVatDenialFlags,
} from '@/modules/accounting/services/gl/inputVatDenial';
import { fetchAccountNames } from '@/modules/accounting/services/gl/nonSupplyVatGuard';
import { resolveRuleVatCode } from '@/modules/accounting/services/gl/ruleVatResolution';
import { VAT_CODE_NONE } from '@/modules/accounting/services/gl/nonSupplyAccounts';

/**
 * Only the three fields the guard judges. Structural rather than importing
 * `AllocationLine`, which lives in the module that calls this one — the import
 * would be a cycle.
 */
export interface GuardableLine {
  allocType: string;
  contraAccountId?: string;
  vatCode?: string;
}

/** Why a claim was dropped. Distinct, because they are different statutes. */
export type VatCoercionReason = 'input_tax_denied' | 'no_supply';

/** Present on a result only when a guard actually changed the code. */
export interface VatCoercion {
  from: string;
  to: string;
  reason: VatCoercionReason;
}

/**
 * Denial flag and name per contra account, resolved once for a whole batch.
 * A missing entry is NOT "no guard" — it means the per-line lookup runs.
 */
export interface AllocationVatFacts {
  denied: Map<string, boolean>;
  names: Map<string, string>;
}

/** Two queries for the batch, rather than two per line. */
export async function prefetchAllocationVatFacts(
  companyId: string,
  accountIds: Array<string | null | undefined>,
): Promise<AllocationVatFacts> {
  const ids = [...new Set(accountIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return { denied: new Map(), names: new Map() };
  const [denied, names] = await Promise.all([
    fetchVatDenialFlags(companyId, ids),
    fetchAccountNames(companyId, ids),
  ]);
  return { denied, names };
}

export interface ResolvedLineVat {
  /** What to hand `allocateTransaction`. Unchanged unless a guard fired. */
  effectiveVatCode: string | undefined;
  vatCoerced?: VatCoercion;
}

/**
 * Resolve one line's VAT code against both guards.
 *
 * `facts` is optional: when the caller prefetched the batch, the account's
 * denial flag and name are passed straight through and no query runs. When it
 * did not — or when this particular account was not in the prefetch —
 * `resolveRuleVatCode` looks both up itself. Passing only one of the two would
 * silently run half the guard, so an account missing from either map falls back
 * to the lookup rather than being treated as clean.
 */
export async function resolveLineVatCode(
  companyId: string,
  txId: string,
  line: GuardableLine,
  toolName: string,
  facts?: AllocationVatFacts,
): Promise<ResolvedLineVat> {
  const accountId = line.contraAccountId || null;
  const prefetched = facts && accountId
    && facts.denied.has(accountId) && facts.names.has(accountId)
    ? { denied: facts.denied.get(accountId)!, name: facts.names.get(accountId)! }
    : null;

  const guarded = await resolveRuleVatCode({
    allocType: line.allocType,
    companyId,
    requestedVatCode: line.vatCode ?? VAT_CODE_NONE,
    glAccountId: accountId,
    ruleGlAccountVatDenied: prefetched?.denied,
    ruleGlAccountName: prefetched?.name,
    denialContext: { bankTxId: txId, toolName, source: 'mcp' },
    guardContext: { bankTxId: txId, ruleName: toolName },
  });

  if (!guarded.denied && !guarded.nonSupplyCoerced) {
    // Byte-identical to before this guard existed, `undefined` included.
    return { effectiveVatCode: line.vatCode };
  }
  return {
    effectiveVatCode: guarded.vatCode,
    vatCoerced: {
      from: line.vatCode ?? VAT_CODE_NONE,
      to: guarded.vatCode,
      reason: guarded.denied ? 'input_tax_denied' : 'no_supply',
    },
  };
}

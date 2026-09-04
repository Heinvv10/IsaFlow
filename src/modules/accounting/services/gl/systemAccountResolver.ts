/**
 * System Account Resolver
 *
 * Resolves system GL accounts by their account_subtype instead of hardcoded
 * account codes. This decouples business logic from specific numbering schemes,
 * allowing customers to use any chart of accounts numbering (Sage, Xero, etc.).
 *
 * Usage:
 *   const arAccountId = await getSystemAccountId('receivable', companyId);
 *   const arAccount   = await getSystemAccount('receivable', companyId);
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  MissingSystemAccountError,
  SYSTEM_ACCOUNT_KEYS,
  preferSystemAccount,
  typeFitsSubtype,
  type NearMissClaimant,
  type SystemAccountKey,
  type SystemRoleGap,
} from './systemAccountKeys';
// Re-exported: `chartOfAccountsHealth` and the resolver's own tests import both
// from here, and both now live in the leaf module so `systemRoleCoverage` can
// rank rivals by the same rule the resolver uses.
export { preferSystemAccount, typeFitsSubtype };
import { describeEmptyRole } from './systemRoleCoverage';

import type { DbRow } from '@/types/db';


// The role list lives in `systemAccountKeys.ts` as a runtime array with the
// type derived from it. It used to be a bare type union here, which forced
// every consumer needing the LIST to retype it — and the copy in
// `validateSystemAccounts` carried 9 of the 14. Re-exported so the ~40 existing
// `import type { SystemAccountKey }` sites keep working.
export type { SystemAccountKey } from './systemAccountKeys';

// ── In-memory cache (per company) ───────────────────────────────────────────

interface CachedAccount {
  id: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  accountSubtype: string;
  /** Epoch ms of gl_accounts.created_at — the tiebreak between duplicate system rows. */
  createdAt: number;
}

interface CompanyCache {
  map: Map<string, CachedAccount>;
  /**
   * Every claimant for a subtype that more than one system row claims, winner
   * included. Populated only when a role is contested; `getSystemAccount` still
   * hands out `map`'s deterministic winner and is unaffected by this.
   */
  contested: Map<string, CachedAccount[]>;
  loadedAt: number;
}

const companyCache = new Map<string, CompanyCache>();
const CACHE_TTL_MS = 60_000; // 1 minute

/** Clear the cache for a specific company (call after chart of accounts changes) */
export function clearSystemAccountCache(companyId?: string): void {
  if (companyId) {
    companyCache.delete(companyId);
  } else {
    companyCache.clear();
  }
}

async function ensureCache(companyId: string): Promise<Map<string, CachedAccount>> {
  const existing = companyCache.get(companyId);
  if (existing && Date.now() - existing.loadedAt < CACHE_TTL_MS) {
    return existing.map;
  }

  const rows = (await sql`
    SELECT id, account_code, account_name, account_type, account_subtype, created_at
    FROM gl_accounts
    WHERE company_id = ${companyId}::UUID
      AND is_system_account = true
      AND is_active = true
      AND account_subtype IS NOT NULL
  `) as DbRow[];

  const map = new Map<string, CachedAccount>();
  const contested = new Map<string, CachedAccount[]>();
  for (const r of rows) {
    const subtype = String(r.account_subtype);
    const candidate: CachedAccount = {
      id: String(r.id),
      accountCode: String(r.account_code),
      accountName: String(r.account_name),
      accountType: String(r.account_type),
      accountSubtype: subtype,
      createdAt: r.created_at instanceof Date ? r.created_at.getTime()
        : r.created_at == null ? Number.NaN : Date.parse(String(r.created_at)),
    };
    const incumbent = map.get(subtype);
    if (!incumbent) {
      map.set(subtype, candidate);
      continue;
    }
    // Two system rows claim the same role. This used to be last-row-wins in
    // heap order — production (2026-09-02) had Velocity Fibre with two
    // vat_input system rows, one a LIABILITY named "VAT Payable", and which one
    // every auto-posting used depended on physical row order. Pick
    // deterministically instead and shout: a type-consistent row beats a
    // mistyped one, then the newer row (the one a later import or seed
    // deliberately put there) beats the older.
    const winner = preferSystemAccount(incumbent, candidate);
    map.set(subtype, winner);
    const list = contested.get(subtype) ?? [incumbent];
    list.push(candidate);
    contested.set(subtype, list);
  }
  for (const [subtype, candidates] of contested) {
    if (!RESOLVED_SUBTYPES.has(subtype)) continue; // e.g. payroll_liability: many by design
    log.error('Duplicate system accounts for one subtype — resolver picked one; fix the chart', {
      companyId, subtype,
      picked: map.get(subtype)?.accountCode,
      candidates: candidates.map((c) => `${c.accountCode} ${c.accountName} (${c.accountType})`),
    }, 'accounting');
  }

  companyCache.set(companyId, { map, contested, loadedAt: Date.now() });
  return map;
}

/**
 * Every active system account claiming `key`, winner first-class among them.
 *
 * Read-only companion to `getSystemAccount` for callers that must refuse rather
 * than accept a deterministic-but-arbitrary pick — currently only the year-end
 * close, which posts a whole year's result in one entry. Reads the cache
 * `getSystemAccount` builds; issues no query of its own and changes no
 * resolution behaviour.
 *
 * @returns 0 accounts when nothing claims the role, 1 when it is cleanly held,
 *   2+ when the chart is ambiguous and the caller should say so.
 */
export async function getSystemAccountCandidates(
  key: SystemAccountKey,
  companyId: string
): Promise<CachedAccount[]> {
  const map = await ensureCache(companyId);
  const cached = companyCache.get(companyId);
  const contested = cached?.contested.get(key);
  if (contested && contested.length > 0) return [...contested];
  const winner = map.get(key);
  return winner ? [winner] : [];
}

/**
 * Subtypes the resolver actually hands out — the only ones a duplicate matters
 * for. Derived from the role array rather than restated, so it cannot drift
 * from it (payroll_liability and friends are legitimately many-per-company and
 * are absent from that array).
 */
const RESOLVED_SUBTYPES: ReadonlySet<string> = new Set<string>(SYSTEM_ACCOUNT_KEYS);

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Get a system account by its subtype key for a specific company.
 *
 * THROWS `MissingSystemAccountError` when the role is empty, and the throw is
 * deliberate. Every one of this function's ~40 call sites sits inside a service
 * that goes on to write a journal; handing them a returned refusal would make
 * each responsible for noticing it, and one that forgot would post against an
 * `undefined` account id. A silent wrong answer in the ledger is worse than a
 * 500. The refusal is rendered into something actionable at the MCP boundary
 * (`registry.ts`), which is the layer that can afford to catch it — nothing has
 * been written by the time this throws.
 *
 * The error carries the near misses, so "you have no bank account" and "your
 * bank account exists and is missing one boolean" are told apart by the caller.
 * That costs one extra query on the failing path only.
 */
export async function getSystemAccount(key: SystemAccountKey, companyId: string): Promise<CachedAccount> {
  const map = await ensureCache(companyId);
  const account = map.get(key);
  if (!account) {
    // The near-miss lookup is a SECOND query, and it must never be what decides
    // whether the caller gets a diagnosis. If the surrounding transaction is
    // already aborted (a prior statement raised and someone swallowed it), this
    // SELECT raises 25P02 and that would propagate INSTEAD of
    // MissingSystemAccountError — the registry would fall through to
    // GENERIC_FAILURE, losing the named blocker in exactly the situation where
    // working the cause out by hand is hardest. So the detail is best-effort and
    // the refusal is not: on failure we throw the same typed error with no
    // candidates, which still names the role and the remedy.
    let gap: SystemRoleGap = 'no_claimant';
    let nearMisses: NearMissClaimant[] = [];
    try {
      ({ gap, nearMisses } = await describeEmptyRole(key, companyId));
    } catch (err) {
      log.warn(
        'Could not classify the empty system account role; refusing without candidates',
        { key, companyId, err: err instanceof Error ? err.message : String(err) },
        'accounting',
      );
    }
    log.error('System account not found', { key, companyId, gap, nearMisses: nearMisses.length }, 'accounting');
    throw new MissingSystemAccountError(key, companyId, gap, nearMisses);
  }
  return account;
}

/**
 * Get only the account ID for a system account.
 * Convenience wrapper for the most common use case (building journal lines).
 */
export async function getSystemAccountId(key: SystemAccountKey, companyId: string): Promise<string> {
  const account = await getSystemAccount(key, companyId);
  return account.id;
}

/**
 * Roles this company cannot resolve — empty means every role is held.
 *
 * The `required` list here used to be nine hand-written entries, omitting
 * `opening_balance_equity`, `other_income`, `accumulated_depreciation`,
 * `depreciation_expense` and `disposal_profit_loss`. Production on 2026-09-04
 * was missing three of those five on nearly every tenant and this function
 * reported them all healthy. It now checks every role in `SYSTEM_ACCOUNT_KEYS`.
 *
 * Kept as a thin wrapper because callers wanting the near-miss detail should
 * use `getSystemRoleCoverage` directly; this is the bare-name answer.
 */
export async function validateSystemAccounts(companyId: string): Promise<string[]> {
  const map = await ensureCache(companyId);
  return SYSTEM_ACCOUNT_KEYS.filter((key) => !map.has(key));
}

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
import { GL_ACCOUNT_SUBTYPES_BY_TYPE } from '../../types/glAccountSubtypes';
import type { GLAccountType } from '../../types/gl.types';

import type { DbRow } from '@/types/db';


/**
 * Subtypes that the system requires for auto-posting and reporting.
 * Each maps to exactly one system account (is_system_account = true).
 */
export type SystemAccountKey =
  | 'bank'                      // Primary bank account
  | 'receivable'                // Accounts Receivable
  | 'payable'                   // Accounts Payable
  | 'vat_input'                 // VAT Input (claimable)
  | 'vat_output'                // VAT Output (payable)
  | 'retained_earnings'         // Retained Earnings
  | 'opening_balance_equity'    // Opening Balance Equity (clearing; nets to zero once the opening TB is complete)
  | 'default_revenue'           // Default revenue account
  | 'other_income'              // Other Income
  | 'default_expense'           // Default expense (Materials & Supplies)
  | 'admin_expense'             // Administrative Expenses
  | 'accumulated_depreciation'  // Accumulated Depreciation
  | 'depreciation_expense'      // Depreciation Expense
  | 'disposal_profit_loss';     // Profit / Loss on Disposal of Assets

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

  companyCache.set(companyId, { map, loadedAt: Date.now() });
  return map;
}

/** Subtypes the resolver actually hands out — the only ones a duplicate matters for. */
const RESOLVED_SUBTYPES: ReadonlySet<string> = new Set<SystemAccountKey>([
  'bank', 'receivable', 'payable', 'vat_input', 'vat_output', 'retained_earnings',
  'default_revenue', 'other_income', 'default_expense', 'admin_expense',
  'accumulated_depreciation', 'depreciation_expense', 'disposal_profit_loss', 'opening_balance_equity',
]);

/** True when `accountType` may legally carry `subtype` (glAccountSubtypes.ts). */
export function typeFitsSubtype(accountType: string, subtype: string): boolean {
  const allowed = GL_ACCOUNT_SUBTYPES_BY_TYPE[accountType as GLAccountType] as readonly string[] | undefined;
  return allowed?.includes(subtype) ?? false;
}

/** Exported for the unit test; deterministic and total over (typeFits, createdAt, id). */
export function preferSystemAccount(a: CachedAccount, b: CachedAccount): CachedAccount {
  const fa = typeFitsSubtype(a.accountType, a.accountSubtype);
  const fb = typeFitsSubtype(b.accountType, b.accountSubtype);
  if (fa !== fb) return fa ? a : b;
  // created_at is nullable in the schema. NaN compares false both ways, which
  // made the outcome depend on argument order — i.e. on fetch order again. An
  // unknown date ranks OLDEST so a dated row always beats it, symmetrically.
  const ca = Number.isFinite(a.createdAt) ? a.createdAt : Number.NEGATIVE_INFINITY;
  const cb = Number.isFinite(b.createdAt) ? b.createdAt : Number.NEGATIVE_INFINITY;
  if (ca !== cb) return ca > cb ? a : b;
  return a.id > b.id ? a : b;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Get a system account by its subtype key for a specific company.
 * Throws if the account is not found (misconfigured chart of accounts).
 */
export async function getSystemAccount(key: SystemAccountKey, companyId: string): Promise<CachedAccount> {
  const map = await ensureCache(companyId);
  const account = map.get(key);
  if (!account) {
    log.error('System account not found', { key, companyId }, 'accounting');
    throw new Error(
      `System account with subtype '${key}' not found for company ${companyId}. ` +
      `Ensure the chart of accounts has a system account with account_subtype = '${key}'.`
    );
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
 * Check whether all required system accounts are configured.
 * Returns a list of missing subtypes (empty = all good).
 */
export async function validateSystemAccounts(companyId: string): Promise<string[]> {
  const required: SystemAccountKey[] = [
    'bank', 'receivable', 'payable',
    'vat_input', 'vat_output', 'retained_earnings',
    'default_revenue', 'default_expense', 'admin_expense',
  ];

  const map = await ensureCache(companyId);
  return required.filter(key => !map.has(key));
}

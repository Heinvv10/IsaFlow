/**
 * System Account Resolver
 *
 * Resolves system GL accounts by their account_subtype instead of hardcoded
 * account codes. This decouples business logic from specific numbering schemes,
 * allowing customers to use any chart of accounts numbering (Sage, Xero, etc.).
 *
 * Usage:
 *   const arAccountId = await getSystemAccountId('receivable');
 *   const arAccount   = await getSystemAccount('receivable');
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { GLAccount, GLAccountSubtype } from '../types/gl.types';

type Row = Record<string, unknown>;

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
  | 'default_revenue'           // Default revenue account
  | 'other_income'              // Other Income
  | 'default_expense'           // Default expense (Materials & Supplies)
  | 'admin_expense'             // Administrative Expenses
  | 'accumulated_depreciation'  // Accumulated Depreciation
  | 'depreciation_expense';     // Depreciation Expense

// ── In-memory cache ─────────────────────────────────────────────────────────

interface CachedAccount {
  id: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  accountSubtype: string;
}

let cache: Map<string, CachedAccount> | null = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

/** Clear the cache (call after chart of accounts changes) */
export function clearSystemAccountCache(): void {
  cache = null;
  cacheLoadedAt = 0;
}

async function ensureCache(): Promise<Map<string, CachedAccount>> {
  if (cache && Date.now() - cacheLoadedAt < CACHE_TTL_MS) return cache;

  const rows = (await sql`
    SELECT id, account_code, account_name, account_type, account_subtype
    FROM gl_accounts
    WHERE is_system_account = true
      AND is_active = true
      AND account_subtype IS NOT NULL
  `) as Row[];

  const map = new Map<string, CachedAccount>();
  for (const r of rows) {
    const subtype = String(r.account_subtype);
    map.set(subtype, {
      id: String(r.id),
      accountCode: String(r.account_code),
      accountName: String(r.account_name),
      accountType: String(r.account_type),
      accountSubtype: subtype,
    });
  }

  cache = map;
  cacheLoadedAt = Date.now();
  return map;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Get a system account by its subtype key.
 * Throws if the account is not found (misconfigured chart of accounts).
 */
export async function getSystemAccount(key: SystemAccountKey): Promise<CachedAccount> {
  const map = await ensureCache();
  const account = map.get(key);
  if (!account) {
    log.error('System account not found', { key }, 'accounting');
    throw new Error(
      `System account with subtype '${key}' not found. ` +
      `Ensure the chart of accounts has a system account with account_subtype = '${key}'.`
    );
  }
  return account;
}

/**
 * Get only the account ID for a system account.
 * Convenience wrapper for the most common use case (building journal lines).
 */
export async function getSystemAccountId(key: SystemAccountKey): Promise<string> {
  const account = await getSystemAccount(key);
  return account.id;
}

/**
 * Check whether all required system accounts are configured.
 * Returns a list of missing subtypes (empty = all good).
 */
export async function validateSystemAccounts(): Promise<string[]> {
  const required: SystemAccountKey[] = [
    'bank', 'receivable', 'payable',
    'vat_input', 'vat_output', 'retained_earnings',
    'default_revenue', 'default_expense', 'admin_expense',
  ];

  const map = await ensureCache();
  return required.filter(key => !map.has(key));
}

/**
 * Opening Balance Equity — the clearing account every opening balance posts
 * its other side to (QuickBooks "Opening Balance Equity", Xero "Historical
 * Adjustment", Sage's opening-balance suspense).
 *
 * Why not retained earnings: that figure must tie to the prior year's signed
 * AFS, and it is the first number an auditor reconciles. Parking bank opening
 * balances there misstates prior profit. A dedicated equity account instead
 * nets to ZERO once the full opening trial balance is captured; a residual is
 * a signal that something is missing, and the accountant then moves it to
 * retained earnings deliberately (see the close-readiness check).
 *
 * Created on first use, one per company, as a SYSTEM account carrying the
 * reserved subtype `opening_balance_equity` — `subtypeErrorFor` refuses that
 * subtype on any user-created account, so the resolver's by-subtype lookup can
 * never be displaced by a second row.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { cache } from '@/lib/cache';
import { clearSystemAccountCache } from './systemAccountResolver';

export const OPENING_BALANCE_EQUITY_SUBTYPE = 'opening_balance_equity';
export const OPENING_BALANCE_EQUITY_NAME = 'Opening Balance Equity';
/** Seeded charts put equity at 3xxx with 3100 share capital and 3200 retained earnings. */
const PREFERRED_CODES = ['3300', '3310', '3320', '3390'] as const;
const EQUITY_HEADER_CODE = '3000';

export interface OpeningBalanceEquityAccount {
  id: string;
  accountCode: string;
  accountName: string;
  /** True when this call created the account. */
  created: boolean;
}

async function findExisting(companyId: string): Promise<OpeningBalanceEquityAccount | null> {
  const rows = (await sql`
    SELECT id, account_code, account_name
    FROM gl_accounts
    WHERE company_id = ${companyId}::UUID
      AND account_subtype = ${OPENING_BALANCE_EQUITY_SUBTYPE}
      AND is_system_account = true
      AND is_active = true
    ORDER BY account_code
    LIMIT 1
  `) as DbRow[];
  const r = rows[0];
  if (!r) return null;
  return { id: String(r.id), accountCode: String(r.account_code), accountName: String(r.account_name), created: false };
}

async function freeCode(companyId: string): Promise<string> {
  const rows = (await sql`
    SELECT account_code FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND account_code = ANY(${[...PREFERRED_CODES]}::TEXT[])
  `) as DbRow[];
  const taken = new Set(rows.map((r) => String(r.account_code)));
  const code = PREFERRED_CODES.find((c) => !taken.has(c));
  if (!code) {
    // Every preferred code is in use — refuse rather than invent one the firm
    // did not choose. The caller can create the account by hand and set the
    // subtype; this path is a convenience, not the only route.
    throw new Error(
      `No free account code among ${PREFERRED_CODES.join(', ')} for ${OPENING_BALANCE_EQUITY_NAME}; ` +
        'create an equity account with subtype opening_balance_equity manually.',
    );
  }
  return code;
}

/**
 * Returns the company's Opening Balance Equity account, creating it under the
 * 3000 equity header (when that header exists) on first use.
 */
export async function ensureOpeningBalanceEquityAccount(
  companyId: string,
): Promise<OpeningBalanceEquityAccount> {
  const existing = await findExisting(companyId);
  if (existing) return existing;

  const code = await freeCode(companyId);
  const parents = (await sql`
    SELECT id, level FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND account_code = ${EQUITY_HEADER_CODE} AND account_type = 'equity'
    LIMIT 1
  `) as DbRow[];
  const parent = parents[0];
  const parentId = parent ? String(parent.id) : null;
  const level = parent ? Number(parent.level ?? 1) + 1 : 1;

  let rows: DbRow[];
  try {
    rows = (await sql`
    INSERT INTO gl_accounts (
      company_id, account_code, account_name, account_type, account_subtype,
      normal_balance, level, display_order, is_system_account, parent_account_id, is_active, description
    ) VALUES (
      ${companyId}::UUID, ${code}, ${OPENING_BALANCE_EQUITY_NAME}, 'equity', ${OPENING_BALANCE_EQUITY_SUBTYPE},
      'credit', ${level}, 330, true, ${parentId}::UUID, true,
      'Clearing account for opening balances. Should net to zero once the full opening trial balance is captured.'
    )
    RETURNING id, account_code, account_name
  `) as DbRow[];
  } catch (err) {
    // Two first calls in flight: both saw no account and picked the same
    // code, and the unique index on (company_id, account_code) refused the
    // loser. The account now exists, so answer with it rather than failing a
    // post that a retry would succeed at. Any other error propagates.
    if ((err as { code?: unknown }).code === '23505') {
      const raced = await findExisting(companyId);
      if (raced) return raced;
    }
    throw err;
  }
  const r = rows[0]!;
  cache.invalidatePrefix(`${companyId}:gl-accounts`);
  clearSystemAccountCache(companyId);
  log.info('Created Opening Balance Equity account', { companyId, code }, 'accounting');
  return { id: String(r.id), accountCode: String(r.account_code), accountName: String(r.account_name), created: true };
}

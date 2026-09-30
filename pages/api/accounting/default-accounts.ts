/**
 * Default Accounts Configuration API
 * GET /api/accounting/default-accounts - Get default account mappings
 * POST /api/accounting/default-accounts - Save default account mappings
 * Sage equivalent: Accounts > Default Accounts
 *
 * The 8 managed roles are READ from the system-account flags themselves (the
 * holder systemAccountResolver hands out), never from app_settings, which is
 * empty for most companies. A save moves only the roles whose account it
 * changes, and refuses — rolling back everything — any save that would leave a
 * role the company held with no account (every auto-posting path needing it
 * would throw MissingSystemAccountError). The 4 unmanaged rows are stored in
 * app_settings only; nothing reads them (SET-02, open question).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql, withTransaction, type TxSql } from '@/lib/neon';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { SYSTEM_ACCOUNT_KEYS, type SystemAccountKey } from '@/modules/accounting/services/gl/systemAccountKeys';
import { getSystemRoleCoverage } from '@/modules/accounting/services/gl/systemRoleCoverage';
import { VatPeriodLockedError } from '@/modules/accounting/services/gl/journalVatLockGuard';
import {
  assertAccountChangesKeepVatLocks, type AccountAttributeChange,
} from '@/modules/accounting/services/gl/vatLockLineClassification';

const SETTINGS_KEY = 'accounting_default_accounts';

// Maps UI setting keys → system account subtypes used by systemAccountResolver.
const KEY_TO_SYSTEM_SUBTYPE: Record<string, SystemAccountKey> = {
  sales_revenue:       'default_revenue',
  sales_vat_output:    'vat_output',
  accounts_receivable: 'receivable',
  cost_of_sales:       'default_expense',
  purchase_vat_input:  'vat_input',
  accounts_payable:    'payable',
  primary_bank:        'bank',
  retained_earnings:   'retained_earnings',
};

// Expected account_type for each subtype — guards against assigning an
// asset account as "revenue" or similar cross-category mistakes.
const SUBTYPE_EXPECTED_TYPE: Record<string, string> = {
  default_revenue:  'revenue',
  vat_output:       'liability',
  receivable:       'asset',
  default_expense:  'expense',
  vat_input:        'asset',
  payable:          'liability',
  bank:             'asset',
  retained_earnings:'equity',
};

type Row = Record<string, unknown>;

/** A save that must not happen. Thrown inside the save transaction so it rolls back. */
class DefaultAccountsRefusal extends Error {}

/** Role → the account id systemAccountResolver would hand out (same winner rule). */
async function roleHolders(companyId: string, q: TxSql = sql): Promise<Map<SystemAccountKey, string>> {
  const coverage = await getSystemRoleCoverage(companyId, q);
  const holders = new Map<SystemAccountKey, string>();
  for (const role of coverage.roles) if (role.holder) holders.set(role.key, role.holder.id);
  return holders;
}

/**
 * Apply only the roles `mappings` changes, on `tx`. Throws DefaultAccountsRefusal
 * (nothing kept) for an unknown/mistyped/inactive account, a cleared role, a
 * locked-VAT reclassification, or a save that empties any role held before.
 */
async function saveMappings(tx: TxSql, companyId: string, mappings: Record<string, unknown>): Promise<void> {
  // Serialise concurrent saves for this company on the role rows.
  await tx`
    SELECT 1 FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND account_subtype = ANY(${[...SYSTEM_ACCOUNT_KEYS]}::TEXT[])
    FOR UPDATE
  `;
  const before = await roleHolders(companyId, tx);

  const changes: AccountAttributeChange[] = [];
  const moves: { subtype: SystemAccountKey; accountId: string }[] = [];
  for (const [uiKey, raw] of Object.entries(mappings)) {
    const subtype = KEY_TO_SYSTEM_SUBTYPE[uiKey];
    if (!subtype) continue;
    const accountId = typeof raw === 'string' && raw !== '' ? raw : null;
    const current = before.get(subtype) ?? null;
    if (accountId === current) continue;
    if (!accountId) {
      throw new DefaultAccountsRefusal(
        `'${uiKey}' cannot be cleared: the ${subtype} role would have no account and posting that needs it would fail. Choose a replacement account instead.`,
      );
    }
    const [row] = await tx`
      SELECT account_code, account_type, account_subtype, is_active FROM gl_accounts
      WHERE id::TEXT = ${accountId} AND company_id = ${companyId}::UUID
      LIMIT 1
    ` as Row[];
    if (!row) throw new DefaultAccountsRefusal(`Account for '${uiKey}' not found`);
    const expectedType = SUBTYPE_EXPECTED_TYPE[subtype];
    if (row.account_type !== expectedType) {
      throw new DefaultAccountsRefusal(
        `Account for '${uiKey}' must be of type '${expectedType}' (got '${String(row.account_type)}')`,
      );
    }
    if (row.is_active !== true) {
      throw new DefaultAccountsRefusal(`Account ${String(row.account_code)} for '${uiKey}' is inactive`);
    }
    const type = String(row.account_type);
    changes.push({
      accountId,
      accountCode: String(row.account_code),
      from: { accountType: type, accountSubtype: row.account_subtype == null ? null : String(row.account_subtype) },
      to: { accountType: type, accountSubtype: subtype },
    });
    moves.push({ subtype, accountId });
  }

  // Before the first write: a subtype change that would move a line inside a
  // locked (filed) VAT period into a different box is refused, naming the
  // account and the period.
  try {
    await assertAccountChangesKeepVatLocks(companyId, changes);
  } catch (err) {
    if (err instanceof VatPeriodLockedError) throw new DefaultAccountsRefusal(err.message);
    throw err;
  }

  await tx`
    INSERT INTO app_settings (key, value, company_id, updated_at)
    VALUES (${SETTINGS_KEY}, ${JSON.stringify(mappings)}::jsonb, ${companyId}, NOW())
    ON CONFLICT (key, company_id) DO UPDATE
    SET value = ${JSON.stringify(mappings)}::jsonb, updated_at = NOW()
  `;

  // Only a role this save re-points loses its old holder.
  for (const { subtype, accountId } of moves) {
    await tx`
      UPDATE gl_accounts SET is_system_account = false
      WHERE company_id = ${companyId}::UUID AND account_subtype = ${subtype}
        AND is_system_account = true AND id::TEXT <> ${accountId}
    `;
    await tx`
      UPDATE gl_accounts SET is_system_account = true, account_subtype = ${subtype}
      WHERE id::TEXT = ${accountId} AND company_id = ${companyId}::UUID
    `;
  }

  // Re-pointing an account rewrites its subtype, which can take it away from
  // another role (e.g. the admin_expense holder chosen as cost of sales).
  const after = await roleHolders(companyId, tx);
  const emptied = [...before.keys()].filter((key) => !after.has(key));
  if (emptied.length > 0) {
    throw new DefaultAccountsRefusal(
      `This change would leave ${emptied.join(', ')} with no system account; posting that needs it would fail. Nothing was saved.`,
    );
  }
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    try {
      let mappings: Record<string, string> = {};
      const [row] = await sql`
        SELECT value FROM app_settings WHERE key = ${SETTINGS_KEY} AND company_id = ${companyId}
      `;
      if (row?.value) {
        mappings = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
      }
      // The managed roles show what posting actually uses, not what was saved.
      const holders = await roleHolders(companyId);
      for (const [uiKey, subtype] of Object.entries(KEY_TO_SYSTEM_SUBTYPE)) {
        const holder = holders.get(subtype);
        if (holder) mappings[uiKey] = holder;
        else delete mappings[uiKey];
      }
      return apiResponse.success(res, { mappings });
    } catch (err) {
      log.error('Failed to fetch default accounts', { error: err instanceof Error ? err.message : String(err), module: 'accounting' });
      return apiResponse.databaseError(res, err, 'Failed to fetch default accounts');
    }
  }

  if (req.method === 'POST') {
    const { mappings } = req.body;

    if (!mappings || typeof mappings !== 'object') {
      return apiResponse.validationError(res, { mappings: 'Object of key-value mappings required' });
    }

    try {
      await withTransaction((tx) => saveMappings(tx, companyId, mappings as Record<string, unknown>));
    } catch (err) {
      if (err instanceof DefaultAccountsRefusal) return apiResponse.badRequest(res, err.message);
      log.error('Failed to save default accounts', { error: err instanceof Error ? err.message : String(err), module: 'accounting' });
      return apiResponse.databaseError(res, err, 'Failed to save default accounts');
    }
    clearSystemAccountCache(companyId);
    log.info('Default accounts saved and system flags synced', { keys: Object.keys(mappings), module: 'accounting' });
    return apiResponse.success(res, { saved: true });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));

/**
 * Default Accounts: which account holds each of the 9 managed system roles.
 *
 * READ from the system-account flags themselves (the holder
 * systemAccountResolver hands out), never from app_settings, which is empty for
 * most companies. A save moves only the roles whose account it changes, and
 * refuses — rolling back everything — when:
 *   - the page was loaded before someone else moved a role it moves (409);
 *   - a role is cleared, or the account is unknown, of the wrong type,
 *     inactive, a header with sub-accounts, or already classified as something
 *     other than that role (Hein, 2026-09-30: only an unclassified, 'other' or
 *     same-role account may take a role — no reclassifying by assignment);
 *   - a locked (filed) VAT period's figures would move;
 *   - afterwards any role held before, or moved, does not resolve to exactly
 *     the account intended.
 * The 3 unmanaged page rows (sales discount, petty cash, rounding) are stored
 * in app_settings only and read by nothing (SET-02, open question).
 */
import { sql, type TxSql } from '@/lib/neon';
import { TransactionRefusal } from '@/lib/transactionRefusal';
import { SYSTEM_ACCOUNT_KEYS, type SystemAccountKey } from './systemAccountKeys';
import { getSystemRoleCoverage } from './systemRoleCoverage';
import { lockSystemRoleWrites } from './systemRoleWriteLock';
import { VatPeriodLockedError } from './journalVatLockGuard';
import { assertAccountChangesKeepVatLocks, type AccountAttributeChange } from './vatLockLineClassification';

const SETTINGS_KEY = 'accounting_default_accounts';

/** UI setting key → the role (system account subtype) it manages. */
const KEY_TO_SYSTEM_SUBTYPE: Record<string, SystemAccountKey> = {
  sales_revenue: 'default_revenue',
  sales_vat_output: 'vat_output',
  accounts_receivable: 'receivable',
  cost_of_sales: 'default_expense',
  purchase_vat_input: 'vat_input',
  accounts_payable: 'payable',
  primary_bank: 'bank',
  retained_earnings: 'retained_earnings',
  opening_balance_equity: 'opening_balance_equity',
};

/** The account_type each role requires. */
const SUBTYPE_EXPECTED_TYPE: Record<string, string> = {
  default_revenue: 'revenue', vat_output: 'liability', receivable: 'asset', default_expense: 'expense',
  vat_input: 'asset', payable: 'liability', bank: 'asset', retained_earnings: 'equity',
  opening_balance_equity: 'equity',
};

/** Classifications an account may carry and still take any role. */
const UNCLASSIFIED = new Set(['other']);

type Row = Record<string, unknown>;

/** A save that must not happen: 400, or 409 for a stale page. Rolls the save back. */
export class DefaultAccountsRefusal extends TransactionRefusal {
  constructor(message: string, readonly status: 400 | 409 = 400) { super(message); }
}

/** The role a UI key manages — own keys only, so `constructor` is ignored like any unknown key. */
function managedSubtype(uiKey: string): SystemAccountKey | undefined {
  return Object.hasOwn(KEY_TO_SYSTEM_SUBTYPE, uiKey) ? KEY_TO_SYSTEM_SUBTYPE[uiKey] : undefined;
}

/** A stored or posted mapping: a plain object, else nothing. */
export function plainMapping(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === 'string' && value !== '' ? JSON.parse(value) : value;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>) } : {};
}

const idOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Role → the account id systemAccountResolver would hand out (same winner rule). */
async function roleHolders(companyId: string, q: TxSql = sql): Promise<Map<SystemAccountKey, string>> {
  const coverage = await getSystemRoleCoverage(companyId, q);
  const holders = new Map<SystemAccountKey, string>();
  for (const role of coverage.roles) if (role.holder) holders.set(role.key, role.holder.id);
  return holders;
}

async function storedMapping(companyId: string, q: TxSql = sql): Promise<Record<string, unknown>> {
  const [row] = await q`
    SELECT value FROM app_settings WHERE key = ${SETTINGS_KEY} AND company_id = ${companyId}
  ` as Row[];
  return plainMapping(row?.value);
}

/** What the page shows: the live holder for each managed role, app_settings for the rest. */
export async function readDefaultAccountMappings(companyId: string): Promise<Record<string, unknown>> {
  const mappings = await storedMapping(companyId);
  const holders = await roleHolders(companyId);
  for (const [uiKey, subtype] of Object.entries(KEY_TO_SYSTEM_SUBTYPE)) {
    const holder = holders.get(subtype);
    if (holder) mappings[uiKey] = holder;
    else delete mappings[uiKey];
  }
  return mappings;
}

/**
 * Apply only the roles `mappings` changes, on `tx`. `loaded` is the holder the
 * page showed for each key it sends; a role whose holder has changed since is
 * refused 409 rather than silently moved back. Throws DefaultAccountsRefusal.
 */
export async function saveDefaultAccountMappings(
  tx: TxSql, companyId: string, mappings: Record<string, unknown>, loaded: Record<string, unknown>,
): Promise<void> {
  // Serialises this save against other Default Accounts saves and the COA
  // import's role map for this company — nothing else.
  await lockSystemRoleWrites(companyId, tx);
  const chosenIds = Object.entries(mappings)
    .filter(([k, v]) => managedSubtype(k) && idOrNull(v)).map(([, v]) => v as string);
  // Role rows AND the chosen accounts, in ascending id — the order
  // lockGlAccountsForUpdate (account merge) takes them in, so the two cannot deadlock.
  await tx`
    SELECT 1 FROM gl_accounts
    WHERE company_id = ${companyId}::UUID
      AND (account_subtype = ANY(${[...SYSTEM_ACCOUNT_KEYS]}::TEXT[]) OR id::TEXT = ANY(${chosenIds}::TEXT[]))
    ORDER BY id
    FOR UPDATE
  `;
  const before = await roleHolders(companyId, tx);

  const changes: AccountAttributeChange[] = [];
  const moves: { subtype: SystemAccountKey; accountId: string }[] = [];
  const chosenFor = new Map<string, string>();
  for (const [uiKey, raw] of Object.entries(mappings)) {
    const subtype = managedSubtype(uiKey);
    if (!subtype) continue;
    const accountId = idOrNull(raw);
    const current = before.get(subtype) ?? null;
    const other = accountId ? chosenFor.get(accountId) : undefined;
    if (accountId && other) {
      throw new DefaultAccountsRefusal(`One account cannot hold two roles: '${other}' and '${uiKey}' name the same account`);
    }
    if (accountId) chosenFor.set(accountId, uiKey);
    if (accountId === current) continue;
    if (!accountId) {
      throw new DefaultAccountsRefusal(
        `'${uiKey}' cannot be cleared: the ${subtype} role would have no account and posting that needs it would fail. Choose a replacement account instead.`,
      );
    }
    const [row] = await tx`
      SELECT a.account_code, a.account_type, a.account_subtype, a.is_active,
             EXISTS (SELECT 1 FROM gl_accounts c
                     WHERE c.parent_account_id = a.id AND c.company_id = a.company_id) AS has_children
      FROM gl_accounts a
      WHERE a.id::TEXT = ${accountId} AND a.company_id = ${companyId}::UUID
      LIMIT 1
    ` as Row[];
    if (!row) throw new DefaultAccountsRefusal(`Account for '${uiKey}' not found`);
    const code = String(row.account_code);
    const expectedType = SUBTYPE_EXPECTED_TYPE[subtype];
    if (row.account_type !== expectedType) {
      throw new DefaultAccountsRefusal(`Account for '${uiKey}' must be of type '${expectedType}' (got '${String(row.account_type)}')`);
    }
    if (row.is_active !== true) throw new DefaultAccountsRefusal(`Account ${code} for '${uiKey}' is inactive`);
    // A header is hidden from the balance sheet (isReportVisibleLeaf) and
    // refused for direct posting (migration 484) — never a role holder.
    if (row.has_children === true) {
      throw new DefaultAccountsRefusal(`Account ${code} is a header with sub-accounts; choose one of its sub-accounts for '${uiKey}'`);
    }
    const fromSubtype = row.account_subtype == null ? null : String(row.account_subtype);
    if (fromSubtype !== null && fromSubtype !== subtype && !UNCLASSIFIED.has(fromSubtype)) {
      throw new DefaultAccountsRefusal(
        `Account ${code} is classified '${fromSubtype}'; only an unclassified account or one already classified '${subtype}' can hold that role. Change its classification on the chart of accounts first.`,
      );
    }
    // Last: an account that is wrong in itself is refused as such, stale page or not.
    if (idOrNull(loaded[uiKey]) !== current) {
      throw new DefaultAccountsRefusal('Default accounts changed since you loaded this page. It has been reloaded; review and save again.', 409);
    }
    changes.push({
      accountId, accountCode: code,
      from: { accountType: String(row.account_type), accountSubtype: fromSubtype },
      to: { accountType: String(row.account_type), accountSubtype: subtype },
    });
    moves.push({ subtype, accountId });
  }

  // Before the first write: a subtype change that would move a line inside a
  // locked (filed) VAT period is refused, naming the account and the period.
  try {
    await assertAccountChangesKeepVatLocks(companyId, changes, tx);
  } catch (err) {
    if (err instanceof VatPeriodLockedError) throw new DefaultAccountsRefusal(err.message);
    throw err;
  }

  // The page sends only the keys it changed, so merge into what is stored.
  const merged = JSON.stringify({ ...(await storedMapping(companyId, tx)), ...mappings });
  await tx`
    INSERT INTO app_settings (key, value, company_id, updated_at)
    VALUES (${SETTINGS_KEY}, ${merged}::jsonb, ${companyId}, NOW())
    ON CONFLICT (key, company_id) DO UPDATE SET value = ${merged}::jsonb, updated_at = NOW()
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

  // Defence in depth: every role held before or moved must now resolve to
  // exactly the account intended (an emptied or drifted role posts wrongly).
  const after = await roleHolders(companyId, tx);
  const intended = new Map<SystemAccountKey, string>(before);
  for (const { subtype, accountId } of moves) intended.set(subtype, accountId);
  const wrong = [...intended.keys()].filter((key) => after.get(key) !== intended.get(key));
  if (wrong.length > 0) {
    throw new DefaultAccountsRefusal(
      `This change would leave ${wrong.join(', ')} without the account you chose; posting would fail or use another account. Nothing was saved.`,
    );
  }
}

/**
 * Reclassify a GL account — change its `account_subtype` and/or its
 * `parent_account_id` after creation.
 *
 * These two columns were writable ONLY by `createAccount`. The row editor
 * exposed name/description/VAT, `updateAccount` wrote five columns and neither
 * of these, and no API or MCP tool offered another path. That is not a cosmetic
 * gap: `getBankAccountsStatus` selects `WHERE account_subtype = 'bank'`, so an
 * account created without the subtype can never receive a bank statement
 * import, and the only remedy available was to recreate it under a new code and
 * deactivate the original — which churns the chart, breaks external references
 * to the old code, and needs journal transfers if the account carries a
 * balance. 27 Velocity Fibre paycards were stuck in exactly that state.
 *
 * It lives in its own file rather than in `updateAccount` because the guards
 * are structural (cycles, levels, the leaf rule) and share nothing with that
 * function's flat COALESCE update — and because chartOfAccountsService is
 * already 475 lines against a 300-line cap.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { cache } from '@/lib/cache';
import type { GLAccount, GLAccountSubtype, GLAccountType } from '../../types/gl.types';
import { subtypeErrorFor } from './accountSubtypeRules';
import { ParentAccountError, assertParentUsable } from './accountParentRules';
import { clearSystemAccountCache } from './systemAccountResolver';
import { getAccountById } from './chartOfAccountsService';

export interface ReclassifyAccountInput {
  /** `undefined` leaves it alone; `null` clears it. */
  accountSubtype?: GLAccountSubtype | null;
  /** `undefined` leaves it alone; `null` promotes the account to a root. */
  parentAccountId?: string | null;
}

/**
 * Hard stop for both recursive walks below.
 *
 * The cycle guard stops THIS service from creating a loop, but it cannot undo
 * one that is already in the data — `gl_accounts.parent_account_id` has no
 * constraint preventing a cycle, and nothing before this service ever walked
 * the tree in SQL. Without a depth cap, a single pre-existing loop makes the
 * recursive CTE run forever: it holds its row locks, every concurrent write to
 * the chart of accounts queues behind it, and the only symptom is a request
 * that never returns. (Observed exactly once, from a deliberately broken build
 * during development — it wedged the dev database until the backend was
 * terminated by hand.)
 *
 * 32 is far past any real chart. The deepest seeded template is 3 levels.
 */
const MAX_TREE_DEPTH = 32;

/** Thrown for every refusal, so callers can map one class to a 400/toolError. */
export class ReclassifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReclassifyError';
  }
}

interface AccountRow {
  id: string;
  account_code: string;
  account_type: GLAccountType;
  account_subtype: string | null;
  parent_account_id: string | null;
  is_system_account: boolean;
  level: number;
}

async function loadAccount(companyId: string, id: string): Promise<AccountRow> {
  const rows = (await sql`
    SELECT id, account_code, account_type, account_subtype,
           parent_account_id, is_system_account, level
      FROM gl_accounts
     WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
     LIMIT 1
  `) as AccountRow[];
  const row = rows[0];
  if (!row) throw new ReclassifyError('Account not found');
  return row;
}

/**
 * Clearing (null) is always allowed — a NULL subtype is the state we are
 * trying to get accounts out of, not into, but refusing to clear it would make
 * this the only column on the row with no undo.
 */
function assertSubtypeAllowed(account: AccountRow, subtype: GLAccountSubtype | null): void {
  if (subtype === null) return;
  if (account.is_system_account) {
    throw new ReclassifyError(
      `Cannot change the subtype of system account ${account.account_code} — ` +
        'auto-posting resolves this account by its subtype',
    );
  }
  const error = subtypeErrorFor(
    { accountType: account.account_type, currentSubtype: account.account_subtype },
    subtype,
  );
  if (error) throw new ReclassifyError(error);
}

/**
 * Moving an account OFF the bank subtype orphans its statement rows:
 * `bank_transactions.bank_account_id` FKs to `gl_accounts(id)`, but every
 * banking screen and the import path reach those rows through
 * `account_subtype = 'bank'`. The transactions would still exist and be
 * reachable by nothing.
 */
async function assertBankSubtypeRemovable(companyId: string, account: AccountRow): Promise<void> {
  const rows = (await sql`
    SELECT COUNT(*)::INT AS cnt FROM bank_transactions
     WHERE bank_account_id = ${account.id}::UUID
       AND company_id = ${companyId}::UUID
  `) as { cnt: number }[];
  const count = Number(rows[0]?.cnt ?? 0);
  if (count > 0) {
    throw new ReclassifyError(
      `Cannot remove the bank subtype from ${account.account_code} — ${count} bank ` +
        `transaction${count === 1 ? '' : 's'} still reference it. They would become ` +
        'unreachable from every banking screen.',
    );
  }
}

/**
 * The MOVE-specific parent rules: not itself, and not one of its own
 * descendants (a cycle makes both recursive walks and the account tree
 * non-terminating). Everything a move shares with a create — existence, the
 * type match, and the leaf rule — lives in `accountParentRules`.
 */
async function assertParentAllowed(
  companyId: string,
  account: AccountRow,
  parentId: string,
): Promise<number> {
  if (parentId === account.id) {
    throw new ReclassifyError('An account cannot be its own parent');
  }

  // Existence, type match and the leaf rule are shared with `createAccount` —
  // the two paths drifted apart once already, which is how a new child could be
  // attached to a posted account while MOVING one there was refused.
  let childLevel: number;
  try {
    ({ childLevel } = await assertParentUsable(companyId, parentId, account.account_type));
  } catch (err) {
    if (err instanceof ParentAccountError) throw new ReclassifyError(err.message);
    throw err;
  }

  const descendant = (await sql`
    WITH RECURSIVE subtree AS (
      SELECT id, 1 AS depth FROM gl_accounts
       WHERE id = ${account.id}::UUID AND company_id = ${companyId}::UUID
      UNION ALL
      SELECT ch.id, s.depth + 1 FROM gl_accounts ch
        JOIN subtree s ON ch.parent_account_id = s.id
       WHERE ch.company_id = ${companyId}::UUID
         AND s.depth < ${MAX_TREE_DEPTH}
    )
    SELECT 1 FROM subtree WHERE id = ${parentId}::UUID LIMIT 1
  `) as unknown[];
  if (descendant.length > 0) {
    throw new ReclassifyError(
      `Parent ${parentId} sits below ${account.account_code} in the tree — ` +
        'that would create a cycle',
    );
  }

  return childLevel;
}

export async function reclassifyAccount(
  companyId: string,
  id: string,
  input: ReclassifyAccountInput,
): Promise<GLAccount> {
  const changingSubtype = input.accountSubtype !== undefined;
  const changingParent = input.parentAccountId !== undefined;
  if (!changingSubtype && !changingParent) {
    throw new ReclassifyError('Nothing to reclassify — pass accountSubtype or parentAccountId');
  }

  const account = await loadAccount(companyId, id);

  if (changingSubtype) {
    const next = input.accountSubtype ?? null;
    assertSubtypeAllowed(account, next);
    if (account.account_subtype === 'bank' && next !== 'bank') {
      await assertBankSubtypeRemovable(companyId, account);
    }
  }

  let newLevel = account.level;
  if (changingParent) {
    newLevel = input.parentAccountId === null
      ? 1
      : await assertParentAllowed(companyId, account, input.parentAccountId!);
  }

  const nextSubtype = changingSubtype ? (input.accountSubtype ?? null) : account.account_subtype;
  const nextParent = changingParent ? (input.parentAccountId ?? null) : account.parent_account_id;

  try {
    await sql`
      UPDATE gl_accounts
         SET account_subtype   = ${nextSubtype},
             parent_account_id = ${nextParent},
             level             = ${newLevel}
       WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    `;

    // The whole subtree shifts with it. Without this, descendants keep the
    // depth they had under the old parent and the tree view indents wrongly —
    // and `level` is what several reports group on.
    if (changingParent && newLevel !== account.level) {
      const delta = newLevel - account.level;
      await sql`
        WITH RECURSIVE subtree AS (
          SELECT id, 1 AS depth FROM gl_accounts
           WHERE parent_account_id = ${id}::UUID AND company_id = ${companyId}::UUID
          UNION ALL
          SELECT ch.id, s.depth + 1 FROM gl_accounts ch
            JOIN subtree s ON ch.parent_account_id = s.id
           WHERE ch.company_id = ${companyId}::UUID
             AND s.depth < ${MAX_TREE_DEPTH}
        )
        UPDATE gl_accounts SET level = level + ${delta}
         WHERE id IN (SELECT id FROM subtree) AND company_id = ${companyId}::UUID
      `;
    }
  } catch (err) {
    log.error('Failed to reclassify account', { id, error: err }, 'accounting');
    throw err;
  }

  cache.invalidatePrefix(`${companyId}:gl-accounts`);
  clearSystemAccountCache(companyId);

  const updated = await getAccountById(companyId, id);
  if (!updated) throw new ReclassifyError('Account not found');
  return updated;
}

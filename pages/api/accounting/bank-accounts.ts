/**
 * Bank Accounts API
 * GET /api/accounting/bank-accounts - List bank GL accounts with transaction summaries
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { BANK_SUBTYPES, isBankSubtype } from '@/modules/accounting/services/gl/accountSubtypes';
import { getBankAccountsStatus } from '@/modules/accounting/services/bank/bankAccountStatusService';
import { boundedRowWait, lockSystemRoleWrites } from '@/modules/accounting/services/gl/systemRoleWriteLock';
import { reactivationRefusal } from '@/modules/accounting/services/gl/systemRoleReactivation';
import { assertRolesKept, snapshotRoles } from '@/modules/accounting/services/gl/systemRoleInvariant';
import { holderAsParentRefusal, roleBarringChildren } from '@/modules/accounting/services/gl/roleTargetRules';
import { isSubjectToLeafRule } from '@/modules/accounting/services/gl/isReportVisibleLeaf';
import { lockGlAccountsForUpdate } from '@/modules/accounting/services/gl/glAccountLock';
import { clearSystemAccountCacheAfterCommit } from '@/modules/accounting/services/gl/systemAccountResolver';
import { lockPaymentsFromAccount, recordPayingAccountEdit } from '@/modules/accounting/services/ap/payingAccountAuthors';

// Fields are nullable as well as optional. The UI clears a field by sending
// `null` (e.g. `description: editForm.description.trim() || null`), and the
// handler's COALESCE-based UPDATE preserves the existing value on null.
const PutBankAccountSchema = z.object({
  id: UUID,
  bankAccountNumber: z.string().max(50).nullable().optional(),
  bankName: z.string().max(100).nullable().optional(),
  bankBranchName: z.string().max(100).nullable().optional(),
  bankBranchCode: z.string().max(20).nullable().optional(),
  bankAccountType: z.string().max(20).nullable().optional(),
  bankIsDefault: z.boolean().nullable().optional(),
  bankDefaultPaymentMethod: z.string().max(20).nullable().optional(),
  bankOpeningBalance: z.union([z.number(), z.string()]).nullable().optional(),
  bankOpeningBalanceDate: z.string().max(10).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  accountName: z.string().max(100).nullable().optional(),
  isActive: z.boolean().nullable().optional(),
  // Group assignment: another bank GL account acting as the sub-account
  // umbrella (e.g. "Paycards"). Unlike the COALESCE fields above, an explicit
  // null CLEARS the parent — the key being present is the update signal.
  parentAccountId: UUID.nullable().optional(),
}).strict();

/**
 * Validates a parent (group) assignment and applies it. Two-level only:
 * the parent must be a bank account in the same company that is not itself
 * a sub-account, and the account being grouped must not be an umbrella.
 * Returns an error message, or null on success.
 */
async function assignParent(companyId: string, id: string, parentId: string | null): Promise<string | null> {
  if (parentId === id) return 'An account cannot be its own group';
  if (parentId) {
    const [parent] = await sql`
      SELECT id, parent_account_id, account_type, account_subtype, account_code, is_system_account, level,
        (SELECT p.account_subtype FROM gl_accounts p
          WHERE p.id = gl_accounts.parent_account_id AND p.company_id = ${companyId}) AS parent_subtype
      FROM gl_accounts
      WHERE id = ${parentId} AND company_id = ${companyId}
    `;
    if (!parent || !isBankSubtype(parent.account_subtype as string | null)) return 'Group must be a bank account in this company';
    // The primary bank cannot become a group: its own postings would sit behind a header.
    const heldRole = roleBarringChildren(parent);
    if (heldRole) return holderAsParentRefusal(String(parent.account_code), heldRole);
    if (isBankSubtype(parent.parent_subtype as string | null)) return 'Group account is already a sub-account of another group';
    const [self] = await sql`
      SELECT 1 FROM gl_accounts
      WHERE parent_account_id = ${id} AND company_id = ${companyId}
        AND account_subtype = ANY(${BANK_SUBTYPES as string[]})
      LIMIT 1
    `;
    if (self) return 'This account is a group itself — move its sub-accounts first';
    // A group parent becomes invisible on the Bank Transactions page (the list
    // shows leaves only), so an account with its own imported transactions
    // must not be promoted to umbrella — its transactions would be unreachable.
    const [parentTx] = await sql`
      SELECT 1 FROM bank_transactions
      WHERE bank_account_id = ${parentId} AND company_id = ${companyId}
      LIMIT 1
    `;
    if (parentTx) return 'Group account has its own bank transactions — pick an account without transactions as the group';
    // A posted level 1-2 parent would become a header the balance sheet drops — the rule assertParentUsable
    // applies to every other chart edit, with its lock taken before the read for the same reason.
    if (isSubjectToLeafRule(Number(parent.level), String(parent.account_type))) {
      await lockGlAccountsForUpdate(companyId, [parentId]);
      const [posted] = await sql`
        SELECT 1 FROM gl_journal_lines WHERE gl_account_id = ${parentId}::UUID AND company_id = ${companyId}::UUID LIMIT 1`;
      if (posted) {
        return `Group account ${String(parent.account_code)} has journal lines posted to it — as a group it would become `
          + 'a header and its balance would leave the balance sheet. Pick an account with no postings as the group';
      }
    }
  }
  await boundedRowWait(() => sql`
    UPDATE gl_accounts SET parent_account_id = ${parentId}, updated_at = NOW()
    WHERE id = ${id} AND account_subtype = ANY(${BANK_SUBTYPES as string[]}) AND company_id = ${companyId}
  `);
  return null;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, user } = req as CompanyAuthedRequest;

  if (req.method === 'PUT') {
    try {
      const parsed = PutBankAccountSchema.safeParse(req.body);
      if (!parsed.success) {
        return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
      }
      const b = parsed.data;
      const { id } = b;
      const s = (v: string | null | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : null);
      const n = (v: number | string | null | undefined) =>
        v !== undefined && v !== null && v !== '' ? Number(v) : null;
      const bool = (v: boolean | null | undefined) => (typeof v === 'boolean' ? v : null);

      // Deactivating the primary bank would empty the bank role (posting then
      // fails). Checked before ANY write: a 4xx commits what came before it.
      // Under the role-write lock, so a Default Accounts save choosing this
      // account has either committed (refused here) or waits for this request.
      // Reactivating a former primary bank beside the current one would give
      // the role two holders: refused the same way.
      const changesParent = Object.prototype.hasOwnProperty.call(req.body, 'parentAccountId');
      // The role-write lock is the FIRST lock of every write here (the row may
      // be the bank holder a Default Accounts save is waiting for); the role
      // snapshot only when a holder can change: an active-state change or a grouping.
      await lockSystemRoleWrites(companyId);
      // Migration 923: the number and branch code are the EFT originator, approval content of every batch and payment
      // paying from this account. What is in flight is locked here, before any gl_accounts row (batch -> payment -> account).
      const originatorMayChange = s(b.bankAccountNumber) !== null || s(b.bankBranchCode) !== null;
      const inFlight = originatorMayChange ? await boundedRowWait(() => lockPaymentsFromAccount(companyId, id)) : null;
      const roles = typeof b.isActive === 'boolean' || changesParent ? await snapshotRoles(companyId) : null;
      if (typeof b.isActive === 'boolean') {
        const [acct] = await sql`SELECT is_system_account FROM gl_accounts WHERE id = ${id} AND company_id = ${companyId}`;
        if (acct?.is_system_account && !b.isActive) {
          return apiResponse.badRequest(res, 'Cannot deactivate the primary bank account — choose another primary bank in Default Accounts first');
        }
        const refusal = b.isActive ? await reactivationRefusal(companyId, id) : null;
        if (refusal) return apiResponse.badRequest(res, refusal);
      }

      if (changesParent) {
        const parentError = await assignParent(companyId, id, b.parentAccountId ?? null);
        if (parentError) return apiResponse.badRequest(res, parentError);
      }

      await boundedRowWait(() => sql`
        UPDATE gl_accounts SET
          bank_account_number = COALESCE(${s(b.bankAccountNumber)}, bank_account_number),
          bank_name = COALESCE(${s(b.bankName)}, bank_name),
          bank_branch_name = COALESCE(${s(b.bankBranchName)}, bank_branch_name),
          bank_branch_code = COALESCE(${s(b.bankBranchCode)}, bank_branch_code),
          bank_account_type = COALESCE(${s(b.bankAccountType)}, bank_account_type),
          bank_is_default = COALESCE(${bool(b.bankIsDefault)}, bank_is_default),
          bank_default_payment_method = COALESCE(${s(b.bankDefaultPaymentMethod)}, bank_default_payment_method),
          bank_opening_balance = COALESCE(${n(b.bankOpeningBalance)}, bank_opening_balance),
          bank_opening_balance_date = COALESCE(${s(b.bankOpeningBalanceDate)}::date, bank_opening_balance_date),
          description = COALESCE(${s(b.description)}, description),
          account_name = COALESCE(${s(b.accountName)}, account_name),
          is_active = COALESCE(${bool(b.isActive)}, is_active),
          updated_at = NOW()
        WHERE id = ${id} AND account_subtype = ANY(${BANK_SUBTYPES as string[]}) AND company_id = ${companyId}
      `);
      if (inFlight) await recordPayingAccountEdit(companyId, id, user.id, inFlight);
      if (roles) await assertRolesKept(companyId, roles);
      clearSystemAccountCacheAfterCommit(companyId);   // the resolver caches the holder's name and active state
      return apiResponse.success(res, { updated: true });
    } catch (err) {
      log.error('Failed to update bank account', { error: err }, 'accounting-api');
      // Every refusal above is RETURNED; whatever is thrown here is unexpected.
      // A 400 would COMMIT, so it goes to withErrorHandler: 500, rolled back —
      // or 503 + Retry-After for a role-lock timeout.
      throw err;
    }
  }

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PUT']);
  }

  try {
    // Active-only by default: this endpoint also feeds the account pickers on
    // bank-transactions/new and bank/statements/import-pdf, and a retired
    // account must not be offered for coding. Balance views opt in.
    const includeInactive = req.query.include_inactive === 'true';
    const accounts = await getBankAccountsStatus(companyId, { includeInactive });

    return apiResponse.success(res, accounts);
  } catch (err) {
    log.error('Failed to get bank accounts', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to get bank accounts');
  }
}

 
// Bank account structure is a financial control point — only owners
// and admins can edit. Managers can still import statements, reconcile,
// and allocate transactions through the other bank-* endpoints.
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler, { allowedRoles: ['owner', 'admin'] }))));

import {sql} from '@/lib/neon';
import {log} from '@/lib/logger';
import {cache} from '@/lib/cache';
import type {GLAccount} from '../../types/gl.types';
import type {UpdateAccountInput} from './chartOfAccountsService';
import {mapRow} from './glAccountRowMapper';
import {withGlAccountChanges} from './glAccountChangeControl';
import {detachGlInput} from './glAccountChangeRows';
import {getPostedAccountBalance,holdsMoney,formatAccountBalance} from './glAccountBalance';
async function updateAccountRaw(companyId: string, id: string, input: UpdateAccountInput): Promise<GLAccount> {
  try {
    const account = await sql`SELECT * FROM gl_accounts WHERE id = ${id} AND company_id = ${companyId}` as {
      is_system_account: boolean;
      account_name: string;
    }[];
    if (account.length === 0) throw new Error(`Account ${id} not found`);

    if (account[0]!.is_system_account && input.isActive === false) {
      throw new Error('Cannot deactivate a system account');
    }

    if (input.isActive === false) {
      const balance = await getPostedAccountBalance(companyId, id);
      if (holdsMoney(balance)) {
        throw new Error(
          `Cannot deactivate "${account[0]!.account_name}" — GL balance is R ${formatAccountBalance(balance)}. ` +
            `Transfer the balance to another account or reconcile it to zero first.`,
        );
      }
    }

    const rows = await sql`
      UPDATE gl_accounts SET
        account_name = COALESCE(${input.accountName || null}, account_name),
        description = COALESCE(${input.description ?? null}, description),
        is_active = COALESCE(${input.isActive ?? null}, is_active),
        display_order = COALESCE(${input.displayOrder ?? null}, display_order),
        default_vat_code = COALESCE(${input.defaultVatCode || null}, default_vat_code),
        vat_input_denied = COALESCE(${input.vatInputDenied ?? null}, vat_input_denied)
      WHERE id = ${id} AND company_id = ${companyId}
      RETURNING *
    `;
    cache.invalidatePrefix(`${companyId}:gl-accounts`);
    return mapRow((rows as { [key: string]: unknown }[])[0]);
  } catch (err) {
    log.error('Failed to update account', { id, error: err }, 'accounting');
    throw err;
  }
}

async function deleteAccountRaw(companyId: string, id: string): Promise<void> {
  try {
    const children = await sql`
      SELECT COUNT(*) AS cnt FROM gl_accounts
      WHERE parent_account_id = ${id} AND is_active = true AND company_id = ${companyId}
    ` as { cnt: string }[];
    if (Number(children[0]!.cnt) > 0) {
      throw new Error('Cannot delete account with active child accounts');
    }

    const accountRows = await sql`
      SELECT account_subtype, account_name
      FROM gl_accounts
      WHERE id = ${id} AND company_id = ${companyId}
      LIMIT 1
    ` as { account_subtype: string | null; account_name: string }[];

    if (accountRows.length === 0) {
      throw new Error('Account not found');
    }

    const accountName = accountRows[0]!.account_name;
    const accountSubtype = accountRows[0]!.account_subtype;

    const balance = await getPostedAccountBalance(companyId, id);

    if (holdsMoney(balance)) {
      throw new Error(
        `Cannot delete "${accountName}" — GL balance is R ${formatAccountBalance(balance)}. ` +
          `Transfer the balance to another account or reconcile it to zero first.`,
      );
    }

    if (accountSubtype === 'bank') {
      const pendingRows = await sql`
        SELECT COUNT(*) AS cnt FROM bank_transactions
        WHERE bank_account_id = ${id}
          AND company_id = ${companyId}
          AND status NOT IN ('reconciled', 'excluded')
      ` as { cnt: string }[];
      const pendingCount = Number(pendingRows[0]!.cnt);

      if (pendingCount > 0) {
        throw new Error(
          `Cannot delete bank account "${accountName}" — ${pendingCount} ` +
            `unreconciled bank transaction${pendingCount === 1 ? '' : 's'} still attached. ` +
            `Reconcile or exclude ${pendingCount === 1 ? 'it' : 'them'} first.`,
        );
      }
    }

    const deactivateResult = await sql`UPDATE gl_accounts SET is_active = false WHERE id = ${id} AND company_id = ${companyId} RETURNING id` as unknown[];
    if (deactivateResult.length === 0) throw new Error(`GL account not found: ${id}`);
    cache.invalidatePrefix(`${companyId}:gl-accounts`);
  } catch (err) {
    log.error('Failed to delete account', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function updateAccount(companyId:string,id:string,input:UpdateAccountInput):Promise<GLAccount>{
 const safe=detachGlInput(input);return withGlAccountChanges(companyId,{ids:[id]},'updated',()=>updateAccountRaw(companyId,id,safe));
}
export async function deleteAccount(companyId:string,id:string):Promise<void>{
 return withGlAccountChanges(companyId,{ids:[id]},'deactivated',()=>deleteAccountRaw(companyId,id));
}

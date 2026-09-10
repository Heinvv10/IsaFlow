import {sql} from '@/lib/neon';
import {log} from '@/lib/logger';
import {cache} from '@/lib/cache';
import type {GLAccount} from '../../types/gl.types';
import type {CreateAccountInput} from './chartOfAccountsService';
import {getAccountById} from './chartOfAccountsService';
import {mapRow} from './glAccountRowMapper';
import {withGlAccountChanges} from './glAccountChangeControl';
import {detachGlInput} from './glAccountChangeRows';
import {subtypeErrorFor,missingSubtypeError} from './accountSubtypeRules';
import {assertParentUsable} from './accountParentRules';
async function createAccountRaw(companyId: string, input: CreateAccountInput): Promise<GLAccount> {
  try {
    const subtypeError = subtypeErrorFor({ accountType: input.accountType }, input.accountSubtype)
      ?? missingSubtypeError(input.accountType, input.accountSubtype);
    if (subtypeError) throw new Error(subtypeError);

    const existing = await sql`
      SELECT id FROM gl_accounts WHERE account_code = ${input.accountCode} AND company_id = ${companyId}
    `;
    if ((existing as unknown[]).length > 0) {
      throw new Error(`Account code ${input.accountCode} already exists`);
    }

    let level = 1;
    if (input.parentAccountId) {
      const { childLevel } = await assertParentUsable(
        companyId, input.parentAccountId, input.accountType,
      );
      level = childLevel;
    }

    const rows = await sql`
      INSERT INTO gl_accounts (
        company_id, account_code, account_name, account_type, account_subtype,
        parent_account_id, description, normal_balance, level,
        default_vat_code, vat_input_denied
      ) VALUES (
        ${companyId}, ${input.accountCode}, ${input.accountName}, ${input.accountType},
        ${input.accountSubtype || null}, ${input.parentAccountId || null},
        ${input.description || null}, ${input.normalBalance}, ${level},
        ${input.defaultVatCode || null}, ${input.vatInputDenied ?? false}
      )
      RETURNING *
    `;
    cache.invalidatePrefix(`${companyId}:gl-accounts`);
    return mapRow((rows as { [key: string]: unknown }[])[0]);
  } catch (err) {
    log.error('Failed to create account', { error: err }, 'accounting');
    throw err;
  }
}


async function renameAccountCodeRaw(
  companyId: string,
  id: string,
  newCode: string,
): Promise<GLAccount> {
  const trimmed = newCode.trim();
  if (!trimmed) throw new Error('newCode is required');

  const acct = await sql`
    SELECT id, account_code FROM gl_accounts
    WHERE id = ${id} AND company_id = ${companyId}
    LIMIT 1
  ` as { id: string; account_code: string }[];
  if (acct.length === 0) throw new Error('Account not found');
  if (acct[0]!.account_code === trimmed) {
    return (await getAccountById(companyId, id))!;
  }

  const posted = await sql`
    SELECT 1 FROM gl_journal_lines
    WHERE gl_account_id = ${id} AND company_id = ${companyId}::UUID
    LIMIT 1
  ` as unknown[];
  if (posted.length > 0) {
    const err = new Error('Cannot change code — transactions have been posted to this account');
    (err as Error & { code?: string }).code = 'HAS_TRANSACTIONS';
    throw err;
  }

  const clash = await sql`
    SELECT 1 FROM gl_accounts
    WHERE company_id = ${companyId} AND account_code = ${trimmed} AND id <> ${id}
    LIMIT 1
  ` as unknown[];
  if (clash.length > 0) {
    throw new Error(`Account code ${trimmed} already exists`);
  }

  const rows = await sql`
    UPDATE gl_accounts SET account_code = ${trimmed}
    WHERE id = ${id} AND company_id = ${companyId}
    RETURNING *
  ` as { [key: string]: unknown }[];
  cache.invalidatePrefix(`${companyId}:gl-accounts`);
  return mapRow(rows[0]);
}


export async function createAccount(companyId:string,input:CreateAccountInput):Promise<GLAccount>{
 const safe=detachGlInput(input);return withGlAccountChanges(companyId,{codes:[safe.accountCode]},'created',()=>createAccountRaw(companyId,safe));
}
export async function renameAccountCode(companyId:string,id:string,newCode:string):Promise<GLAccount>{
 if(typeof newCode!=='string')throw new Error('Invalid account code');
 return withGlAccountChanges(companyId,{ids:[id]},'code_changed',()=>renameAccountCodeRaw(companyId,id,newCode));
}

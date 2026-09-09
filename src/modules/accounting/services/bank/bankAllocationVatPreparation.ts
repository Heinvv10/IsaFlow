import Decimal from 'decimal.js';
import {assertControlTx} from '../controls/context';
import type {ControlTx} from '../controls/contracts';
import type {BankAllocationPlan} from './bankAllocationPlan';
type Account=Record<string,unknown>;
export function bankVatRole(signedAmount:string){
 const spent=new Decimal(signedAmount).lt(0);
 return{role:spent?'vat_input':'vat_output',type:spent?'asset':'liability',code:spent?'1140':'2120',
  legacy:spent?['other_current_asset','tax']:['tax','other_current_liability']};
}
/** Exact role validation also applies to explicit requested IDs and every later source recheck. */
export function assertBankVatAccount(account:Account|undefined,signedAmount:string):string{
 const expected=bankVatRole(signedAmount);
 if(!account||account.is_active!==true||account.is_system_account!==true||account.account_type!==expected.type
  ||!(account.account_subtype===expected.role||(account.account_code===expected.code
   &&(account.account_subtype==null||expected.legacy.includes(String(account.account_subtype))))))throw new Error('Owned active VAT system account required');
 return String(account.id);
}
/** Preparation only: persist the choice; execution validates the same ID and never substitutes a fallback. */
export async function bindBankAllocationVatAccount(ctx:ControlTx,plan:BankAllocationPlan):Promise<BankAllocationPlan>{
 assertControlTx(ctx);
 if(!('lines' in plan)||!plan.lines.some(line=>line.vatCode==='standard'))return plan;
 const company=ctx.principal.companyId;
 const [bank]=await ctx.sql`SELECT amount::text FROM bank_transactions WHERE company_id=${company}::uuid
  AND id=${plan.bankTransactionId}::uuid FOR UPDATE` as {amount:string}[];
 if(!bank)throw new Error('Owned bank transaction not found');
 const expected=bankVatRole(bank.amount);
 let candidates:Account[];
 if(plan.vatAccountId)candidates=await ctx.sql`SELECT id,account_code,account_subtype,account_type,is_active,is_system_account
  FROM gl_accounts WHERE company_id=${company}::uuid AND id=${plan.vatAccountId}::uuid FOR SHARE` as Account[];
 else{
  candidates=await ctx.sql`SELECT id,account_code,account_subtype,account_type,is_active,is_system_account FROM gl_accounts
   WHERE company_id=${company}::uuid AND is_active=true AND is_system_account=true
    AND account_type=${expected.type} AND account_subtype=${expected.role} ORDER BY id LIMIT 2 FOR SHARE` as Account[];
  if(candidates.length>1)throw new Error('VAT system account is ambiguous');
  if(candidates.length===0)candidates=await ctx.sql`SELECT id,account_code,account_subtype,account_type,is_active,is_system_account FROM gl_accounts
   WHERE company_id=${company}::uuid AND is_active=true AND is_system_account=true AND account_type=${expected.type}
    AND account_code=${expected.code} AND (account_subtype IS NULL OR account_subtype=ANY(${expected.legacy}::text[]))
   ORDER BY id LIMIT 2 FOR SHARE` as Account[];
 }
 if(candidates.length!==1)throw new Error('VAT system account missing or ambiguous');
 return{...plan,vatAccountId:assertBankVatAccount(candidates[0],bank.amount)};
}

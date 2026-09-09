import Decimal from 'decimal.js';
import type {ControlTx} from '../controls/contracts';
import {assertControlTx} from '../controls/context';
import {resolveArAccounts} from '../controls/arControlAccounts';
const D=Decimal.clone({precision:80});
type Line={id:string;gl_account_id:string;debit:string;credit:string;account_type:string;account_subtype:string};
/** A balanced total alone does not establish a receivable, payable or cash movement. */
export async function verifyCashAccountingLegs(ctx:ControlTx,journalId:string,kind:'customer'|'supplier',document:'invoice'|'payment',amount:string,explicitBankId?:string|null){
 assertControlTx(ctx);const controlRole=kind==='customer'?'receivable':'payable';
 const accounts=await resolveArAccounts(ctx,[controlRole]);
 const controlId=String(accounts.chosen[controlRole]!.id);
 const lines=await ctx.sql`SELECT l.id,l.gl_account_id,l.debit::text,l.credit::text,a.account_type,a.account_subtype
  FROM gl_journal_lines l JOIN gl_accounts a ON a.company_id=l.company_id AND a.id=l.gl_account_id
  WHERE l.company_id=${ctx.principal.companyId}::uuid AND l.journal_entry_id=${journalId}::uuid ORDER BY l.id FOR SHARE OF l,a` as Line[];
 const control=lines.filter(l=>l.gl_account_id===controlId),other=lines.filter(l=>l.gl_account_id!==controlId);
 const controlDebit=(kind==='customer')===(document==='invoice');
 const validSide=(rows:Line[],debit:boolean)=>rows.length>0&&rows.every(l=>new D(debit?l.credit:l.debit).eq(0)&&new D(debit?l.debit:l.credit).gt(0))
  &&rows.reduce((sum,l)=>sum.add(debit?l.debit:l.credit),new D(0)).eq(amount);
 if(!validSide(control,controlDebit)||!validSide(other,!controlDebit))throw new Error('Cash source journal control amount or direction changed');
 if(document==='payment'){
  const bankIds=new Set(other.map(l=>l.gl_account_id));
  if(bankIds.size!==1||other.some(l=>l.account_type!=='asset'||l.account_subtype!=='bank')||explicitBankId&&other.some(l=>l.gl_account_id!==explicitBankId))throw new Error('Cash source journal bank account changed');
 }
 return{controlId,lines};
}

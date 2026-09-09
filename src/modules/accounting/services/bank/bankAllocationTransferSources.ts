import {z} from 'zod';
import Decimal from 'decimal.js';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from '../controls/context';
import {canonicalJson} from '../controls/canonical';
import type {ControlTx} from '../controls/contracts';
import {readExistingTransferFacts,transferJournalCandidates} from './bankTransferCandidateQueries';
const D=Decimal.clone({precision:80});
type Row=Record<string,unknown>;
const inputSchema=z.object({bankTransactionId:z.string().uuid().transform(s=>s.toLowerCase()),counterpartyAccountId:z.string().uuid().transform(s=>s.toLowerCase())}).strict();
const parse=(input:unknown)=>inputSchema.parse(JSON.parse(canonicalJson(input)));
async function bankRow(ctx:ControlTx,id:string){
 const rows=await ctx.sql`SELECT *,amount::text,transaction_date::text FROM bank_transactions WHERE company_id=${ctx.principal.companyId}::uuid AND id=${id}::uuid` as Row[];
 if(rows.length!==1)throw new Error('Owned transfer bank transaction unavailable');return rows[0]!;
}
/** Authority -> company policy -> unordered pair, before any bank/account row lock. */
export async function lockBankTransferPair(ctx:ControlTx,sourceBankTransactionId:string,counterpartyAccountId:string,options:{authority:'read'|'write'}={authority:'write'}):Promise<void>{
 assertControlTx(ctx);const input=parse({bankTransactionId:sourceBankTransactionId,counterpartyAccountId});
 if(options.authority==='read')await assertEffectivePermission(ctx,'read:bank-tx');
 else{await assertEffectivePermission(ctx,'write:bank-tx');await assertEffectivePermission(ctx,'write:post');}
 const company=ctx.principal.companyId;
 await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${company}`},0))`;
 const bank=await bankRow(ctx,input.bankTransactionId),account=String(bank.bank_account_id);
 if(account===input.counterpartyAccountId)throw new Error('Transfer bank accounts must differ');
 const pair=[account,input.counterpartyAccountId].sort().join(':');
 await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bank-transfer-pair:${company}:${pair}`},0))`;
 if((await bankRow(ctx,input.bankTransactionId)).bank_account_id!==account)throw new Error('Transfer source account changed');
}
/** Bounded transaction-held candidate material; never selects, links or posts a transfer. */
export async function readBankTransferCandidates(ctx:ControlTx,raw:unknown,options:{authority:'read'|'write'}={authority:'write'}){
 assertControlTx(ctx);const input=parse(raw),company=ctx.principal.companyId;
 await lockBankTransferPair(ctx,input.bankTransactionId,input.counterpartyAccountId,options);
 const observed=await bankRow(ctx,input.bankTransactionId),signed=new D(String(observed.amount));
 if(!signed.isFinite()||signed.isZero()||!signed.mul(100).isInteger()||signed.abs().gte('100000000000000000000'))throw new Error('Transfer source must be nonzero exact cents');
 const opposite=await ctx.sql`SELECT *,amount::text,transaction_date::text FROM bank_transactions
  WHERE company_id=${company}::uuid AND bank_account_id=${input.counterpartyAccountId}::uuid AND status='imported'
   AND amount=${signed.neg().toFixed()}::numeric AND transaction_date BETWEEN ${observed.transaction_date}::date-2 AND ${observed.transaction_date}::date+2
  ORDER BY abs(transaction_date-${observed.transaction_date}::date),created_at DESC,id LIMIT 101` as Row[];
 const journals=await transferJournalCandidates(ctx,observed,input.counterpartyAccountId);
 if(opposite.length>100||journals.length>100)throw new Error('Transfer candidate population exceeds bound');
 const ids=[...new Set([input.bankTransactionId,...opposite.map(r=>String(r.id)),...journals.map(j=>String(j.source_record_id))])].sort();
 const locked=await ctx.sql`SELECT *,amount::text,transaction_date::text FROM bank_transactions
  WHERE company_id=${company}::uuid AND id=ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE` as Row[];
 const bank=locked.find(r=>r.id===input.bankTransactionId);
 if(!bank||canonicalJson(bank)!==canonicalJson(observed)||opposite.some(r=>canonicalJson(locked.find(l=>l.id===r.id))!==canonicalJson(r)))throw new Error('Transfer candidate source changed');
 const accountIds=[String(bank.bank_account_id),input.counterpartyAccountId].sort();
 const accounts=await ctx.sql`SELECT id,company_id,account_code,account_name,account_type,account_subtype,is_active FROM gl_accounts
  WHERE company_id=${company}::uuid AND id=ANY(${accountIds}::uuid[]) ORDER BY id FOR SHARE` as Row[];
 if(accounts.length!==2||accounts.some(a=>a.is_active!==true||a.account_type!=='asset'||a.account_subtype!=='bank'))throw new Error('Owned active bank asset accounts required');
 const metadata=await ctx.sql`SELECT id,company_id,gl_account_id,currency,is_active FROM bank_accounts
  WHERE company_id=${company}::uuid AND gl_account_id=ANY(${accountIds}::uuid[]) ORDER BY id LIMIT 3 FOR SHARE` as Row[];
 const [ledger]=await ctx.sql`SELECT id,default_currency FROM companies WHERE id=${company}::uuid FOR SHARE` as Row[];
 if(metadata.length!==2||new Set(metadata.map(m=>m.gl_account_id)).size!==2||metadata.some(m=>m.currency!=='ZAR'||m.is_active!==true)||ledger?.default_currency!=='ZAR')throw new Error('Unambiguous active owned ZAR bank metadata required');
 const existingCandidates=[];
 for(const journal of journals)existingCandidates.push(await readExistingTransferFacts(ctx,bank,input.counterpartyAccountId,journal,locked));
 return{bank,sourceAccount:accounts.find(a=>a.id===bank.bank_account_id)!,sourceMetadata:metadata.find(m=>m.gl_account_id===bank.bank_account_id)!,
  counterpartyAccount:accounts.find(a=>a.id===input.counterpartyAccountId)!,counterpartyMetadata:metadata.find(m=>m.gl_account_id===input.counterpartyAccountId)!,ledger,
  oppositeCandidates:opposite,existingCandidates};
}

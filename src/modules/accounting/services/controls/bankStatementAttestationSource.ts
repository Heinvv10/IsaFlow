import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {withSavepoint} from '@/lib/neon';
import type {ControlTx} from './contracts';
import {assertControlTx} from './context';
import {riskHash} from './invoiceRiskQueriesResult';
interface StatementSource {
 account:{id:string;account_type:string;account_subtype:string;is_active:boolean};
 document:{id:string;hash:string;status:string};currency:string;
}
export function bankStatementSourceFingerprint(source:StatementSource){return riskHash(source);}
export async function assertStatementRead(ctx:ControlTx){
 assertControlTx(ctx);await assertEffectivePermission(ctx,'read:bank-tx');await assertEffectivePermission(ctx,'read:reports');
}
/** Source rows remain locked until the surrounding control transaction ends; immutable intents need no row lock. */
export async function withStatementSourceLocks<T>(ctx:ControlTx,action:()=>Promise<T>){
 await assertStatementRead(ctx);
 await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${ctx.principal.companyId}`},0))`;
 return withSavepoint('statement_attestation_sources',async()=>{
  const [setting]=await ctx.sql`SELECT current_setting('lock_timeout') AS value` as {value:string}[];
  await ctx.sql`SELECT set_config('lock_timeout','2000ms',true)`;
  const result=await action();
  await ctx.sql`SELECT set_config('lock_timeout',${setting!.value},true)`;
  return result;
 });
}
export async function loadBankStatementSource(ctx:ControlTx,accountId:string,documentId:string,expectedHash:string){
 await assertStatementRead(ctx);
 const [company]=await ctx.sql`SELECT default_currency FROM companies WHERE id=${ctx.principal.companyId}::uuid FOR SHARE` as {default_currency:string}[];
 const [account]=await ctx.sql`SELECT id,account_type,account_subtype,is_active FROM gl_accounts
  WHERE company_id=${ctx.principal.companyId}::uuid AND id=${accountId}::uuid FOR SHARE` as StatementSource['account'][];
 const [document]=await ctx.sql`SELECT id,status,raw_bytes_sha256 AS hash,
  raw_bytes IS NOT NULL AND octet_length(raw_bytes) BETWEEN 1 AND 10485760
   AND encode(digest(raw_bytes,'sha256'),'hex')=${expectedHash} AS verified
  FROM captured_documents WHERE company_id=${ctx.principal.companyId}::uuid AND id=${documentId}::uuid FOR SHARE` as (StatementSource['document']&{verified:boolean})[];
 if(!account||account.account_type!=='asset'||account.account_subtype!=='bank'||!account.is_active)throw new Error('Owned active bank account required');
 if(!document||!document.verified||document.hash!==expectedHash||['deleted','rejected'].includes(document.status))throw new Error('Actual statement bytes unavailable or changed');
 if(!company||!/^[A-Z]{3}$/.test(company.default_currency))throw new Error('Statement ledger currency unavailable');
 const source:StatementSource={account,document:{id:document.id,hash:document.hash,status:document.status},currency:company.default_currency};
 return{...source,fingerprint:bankStatementSourceFingerprint(source)};
}

import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {withSavepoint} from '@/lib/neon';
import type {ControlTx} from './contracts';
import {assertControlTx} from './context';
import {riskHash} from './invoiceRiskQueriesResult';
import {loadOwnedCapturedEvidence} from './capturedEvidenceSource';
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
 if(!account||account.account_type!=='asset'||account.account_subtype!=='bank'||!account.is_active)throw new Error('Owned active bank account required');
 const document=await loadOwnedCapturedEvidence(ctx,documentId,'read:bank-tx');
 if(!document||!document.recordedHashVerified||document.sha256!==expectedHash||!document.status)throw new Error('Actual statement bytes unavailable or changed');
 if(!company||!/^[A-Z]{3}$/.test(company.default_currency))throw new Error('Statement ledger currency unavailable');
 const source:StatementSource={account,document:{id:document.id,hash:document.sha256,status:document.status},currency:company.default_currency};
 return{...source,fingerprint:bankStatementSourceFingerprint(source)};
}

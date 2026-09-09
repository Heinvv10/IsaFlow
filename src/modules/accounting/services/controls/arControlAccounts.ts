import type {ControlTx} from './contracts';
import {assertControlTx} from './context';
import {typeFitsSubtype,type SystemAccountKey} from '../gl/systemAccountKeys';
export type ArAccount=Record<string,unknown>&{id:string};
/** Same system-account semantics as ordinary posting, without cache or ambiguous first-row selection. */
export async function resolveArAccounts(ctx:ControlTx,roles:readonly SystemAccountKey[],explicitIds:readonly string[]=[]){
 assertControlTx(ctx);const company=ctx.principal.companyId;
 const [ledger]=await ctx.sql`SELECT id,default_currency,lockdown_enabled,lockdown_date::text FROM companies WHERE id=${company}::uuid FOR SHARE` as
 {id:string;default_currency:string;lockdown_enabled:boolean;lockdown_date:string|null}[];
 if(!ledger||!/^[A-Z]{3}$/.test(ledger.default_currency))throw new Error('AR ledger currency is unknown');
 const systems=await ctx.sql`SELECT id,account_code,account_type,account_subtype,is_active,is_system_account FROM gl_accounts
 WHERE company_id=${company}::uuid AND account_subtype=ANY(${[...roles]}::text[]) AND is_system_account=true AND is_active=true ORDER BY id FOR SHARE` as ArAccount[];
 const chosen:Partial<Record<SystemAccountKey,ArAccount>>={};
 for(const role of roles){const found=systems.filter(a=>a.account_subtype===role);if(found.length!==1||!typeFitsSubtype(String(found[0]!.account_type),role))throw new Error('AR system account is missing or ambiguous');chosen[role]=found[0]!;}
 const ids=[...new Set(explicitIds)].sort();
 const explicit=await ctx.sql`SELECT id,account_code,account_type,account_subtype,is_active,is_system_account FROM gl_accounts
 WHERE company_id=${company}::uuid AND id=ANY(${ids}::uuid[]) ORDER BY id FOR SHARE` as ArAccount[];
 if(explicit.length!==ids.length||explicit.some(a=>a.is_active!==true))throw new Error('AR explicit account is missing, foreign or inactive');
 return{chosen,explicit,ledgerCurrency:ledger.default_currency,facts:{ledger,systems,explicit}};
}

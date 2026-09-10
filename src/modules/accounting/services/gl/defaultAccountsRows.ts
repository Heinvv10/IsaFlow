import type {ControlTx} from '../controls/contracts';
import {canonicalJson} from '../controls/canonical';
import {DEFAULT_ACCOUNT_ROLES,DefaultAccountsValidationError,type DefaultAccountsMappings,type DefaultAccountKey} from './defaultAccountsInput';
import {meaningfulGlRow,type GlAccountRow} from './glAccountChangeRows';
export const DEFAULT_SETTINGS_KEY='accounting_default_accounts';
export interface DefaultSettingsRow extends Record<string,unknown>{key:string;company_id:string;value:unknown}
export const managedSubtypes=Object.values(DEFAULT_ACCOUNT_ROLES).map(role=>role.subtype);
export async function defaultAccountIds(ctx:ControlTx,mappings:DefaultAccountsMappings):Promise<string[]>{
 const ids=Object.values(mappings).filter((id):id is string=>!!id);
 const rows=await ctx.sql`SELECT id FROM gl_accounts WHERE company_id=${ctx.principal.companyId}::uuid
  AND (id=ANY(${ids}::uuid[]) OR (is_system_account=true AND account_subtype=ANY(${managedSubtypes}::text[]))) ORDER BY id` as {id:string}[];
 return rows.map(row=>row.id);
}
export async function readDefaultSettings(ctx:ControlTx):Promise<DefaultSettingsRow|null>{
 const rows=await ctx.sql`SELECT to_jsonb(s) AS material FROM app_settings s WHERE company_id=${ctx.principal.companyId}::uuid
  AND key=${DEFAULT_SETTINGS_KEY} FOR UPDATE OF s` as {material:DefaultSettingsRow}[];
 if(rows.length>1)throw new Error('Ambiguous default settings');return rows[0]?.material??null;
}
export function sameMappings(row:DefaultSettingsRow|null,mappings:DefaultAccountsMappings):boolean{
 if(!row)return false;
 try{return canonicalJson(typeof row.value==='string'?JSON.parse(row.value):row.value)===canonicalJson(mappings);}
 catch{return false;}
}
export function expectedDefaultRows(before:GlAccountRow[],mappings:DefaultAccountsMappings):GlAccountRow[]{
 const roles=new Map<string,typeof DEFAULT_ACCOUNT_ROLES[DefaultAccountKey]>();
 for(const [key,id] of Object.entries(mappings))if(id){
  const role=DEFAULT_ACCOUNT_ROLES[key as DefaultAccountKey],row=before.find(a=>a.id===id);
  if(!row)throw new DefaultAccountsValidationError(`Account for '${key}' not found`);
  if(row.account_type!==role.type)throw new DefaultAccountsValidationError(`Account for '${key}' must be of type '${role.type}'`);
  roles.set(id,role);
 }
 return before.map(row=>{
  const role=roles.get(row.id);
  if(role)return{...row,is_system_account:true,account_subtype:role.subtype};
  return row.is_system_account===true&&managedSubtypes.includes(row.account_subtype as typeof managedSubtypes[number])?{...row,is_system_account:false}:row;
 });
}
export function assertDefaultRows(expected:GlAccountRow[],actual:GlAccountRow[]):void{
 if(expected.length!==actual.length||expected.some((row,index)=>!actual[index]||meaningfulGlRow(row)!==meaningfulGlRow(actual[index]!)))throw new Error('Default account changes were not retained');
}

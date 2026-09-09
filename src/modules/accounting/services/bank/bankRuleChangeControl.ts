import {withSavepoint} from '@/lib/neon';
import {UUID_RE} from '@/lib/validation';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {requireControlTx} from '../controls/context';
import {canonicalJson} from '../controls/canonical';
import {recordCommittedChange} from '../controls/changeEventService';
import type {ControlTx} from '../controls/contracts';
export type BankRuleRow=Record<string,unknown>;
/** Optional undefined fields retain the existing omitted-field semantics, without invoking accessors. */
export function detachRuleInput<T extends object>(input:T):T{
 if(!input||Object.getPrototypeOf(input)!==Object.prototype||Object.getOwnPropertySymbols(input).length)throw new Error('Invalid rule input');
 const plain:Record<string,unknown>={};
 for(const key of Object.getOwnPropertyNames(input)){
  const descriptor=Object.getOwnPropertyDescriptor(input,key)!;
  if(!descriptor.enumerable||!('value' in descriptor))throw new Error('Invalid rule input property');
  if(descriptor.value!==undefined)plain[key]=descriptor.value;
 }
 return JSON.parse(canonicalJson(plain)) as T;
}
/** Every mutation requires an issued caller; row locks serialize both edits and their version CAS. */
export async function withBankRuleChange<T>(companyId:string,ids:readonly string[],work:(ctx:ControlTx,rows:BankRuleRow[])=>Promise<T>,personId?:string):Promise<T>{
 const ctx=requireControlTx();
 if(ctx.principal.companyId!==companyId||(personId!==undefined&&personId!==ctx.principal.personId))throw new Error('Rule caller assertion mismatch');
 const keys=[...new Set((JSON.parse(canonicalJson(ids)) as string[]).map(id=>{if(typeof id!=='string'||!UUID_RE.test(id))throw new Error('Invalid rule identity');return id.toLowerCase();}))].sort();
 await assertEffectivePermission(ctx,'write:bank-tx');
 return withSavepoint('bank_rule_change',async()=>{
  const rows=keys.length?await ctx.sql`SELECT * FROM bank_categorisation_rules WHERE company_id=${companyId}::uuid AND id=ANY(${keys}::uuid[]) ORDER BY id FOR UPDATE` as BankRuleRow[]:[];
  if(rows.length!==keys.length)throw new Error('Owned bank rule not found');
  return work(ctx,rows);
 });
}
export async function recordBankRuleChange(ctx:ControlTx,id:string,before:BankRuleRow|null,after:BankRuleRow|null,action:'created'|'updated'|'toggled'|'deleted'){
 if(canonicalJson(before)===canonicalJson(after))return;
 const [version]=await ctx.sql`SELECT version FROM control_entity_versions WHERE company_id=${ctx.principal.companyId}::uuid
  AND entity_type='bank_categorisation_rule' AND entity_id=${id} FOR UPDATE` as {version:number}[];
 const previousVersion=version?Number(version.version):null;
 await recordCommittedChange(ctx,{entityType:'bank_categorisation_rule',entityId:id,previousVersion,newVersion:previousVersion===null?1:previousVersion+1,
  action:`bank_categorisation_rule.${action}`,accountingDate:null,before,after,bindingHash:null,protectedEvidenceRef:null});
}

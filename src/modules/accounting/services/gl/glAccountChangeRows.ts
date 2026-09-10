import type {ControlTx} from '../controls/contracts';
import {canonicalJson} from '../controls/canonical';
import {UUID_RE} from '@/lib/validation';
export interface GlAccountSelection {ids?:string[];codes?:string[];descendantsOf?:string;parentId?:string|null}
export interface GlAccountRow {id:string;account_code:string;[key:string]:unknown}
/** Top-level optional undefined is a legacy service input omission, never an accessor. */
export function detachGlInput<T extends object>(input:T):T{
 if(Object.getPrototypeOf(input)!==Object.prototype&&Object.getPrototypeOf(input)!==null)throw new Error('Invalid GL input');
 const copy:Record<string,unknown>={};
 for(const key of Reflect.ownKeys(input)){
  const descriptor=Object.getOwnPropertyDescriptor(input,key)!;
  if(typeof key!=='string'||!descriptor.enumerable||!('value' in descriptor))throw new Error('Invalid GL input property');
  if(descriptor.value!==undefined)Object.defineProperty(copy,key,{value:descriptor.value,enumerable:true});
 }
 return JSON.parse(canonicalJson(copy)) as T;
}
export function meaningfulGlRow(row:GlAccountRow|null):string{
 if(row===null)return 'null';const {updated_at:ignored,...values}=row;void ignored;return canonicalJson(values);
}
export async function readGlChangeRows(ctx:ControlTx,selection:GlAccountSelection):Promise<GlAccountRow[]>{
 const ids=selection.ids??[],codes=selection.codes??[],root=selection.descendantsOf??null;
 if(ids.some(id=>!UUID_RE.test(id))||(root!==null&&!UUID_RE.test(root)))throw new Error('Invalid GL account identity');
 const c=ctx.principal.companyId,parent=selection.parentId??null;
 if(parent!==null&&!UUID_RE.test(parent))throw new Error('Invalid GL parent identity');
 const rows=await ctx.sql`WITH RECURSIVE subtree(id,walk) AS (
  SELECT id,level<>CASE WHEN ${parent}::uuid IS NULL THEN 1 ELSE (SELECT p.level+1 FROM gl_accounts p WHERE p.company_id=${c}::uuid AND p.id=${parent}::uuid) END
  FROM gl_accounts WHERE company_id=${c}::uuid AND id=${root}::uuid
  UNION SELECT a.id,s.walk FROM gl_accounts a JOIN subtree s ON a.parent_account_id=s.id WHERE a.company_id=${c}::uuid AND s.walk
 ) SELECT (to_jsonb(a)-'bank_opening_balance')||jsonb_build_object('bank_opening_balance',a.bank_opening_balance::text) AS material
 FROM gl_accounts a WHERE a.company_id=${c}::uuid AND (a.id=ANY(${ids}::uuid[]) OR a.account_code=ANY(${codes}::text[]) OR a.id IN (SELECT id FROM subtree))
 ORDER BY a.id FOR UPDATE OF a` as {material:GlAccountRow}[];
 return rows.map(row=>row.material);
}

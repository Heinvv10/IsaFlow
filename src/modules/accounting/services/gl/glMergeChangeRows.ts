import type {ControlTx} from '../controls/contracts';
import {canonicalJson} from '../controls/canonical';

export interface MergePopulation {lines:{id:string;journal_entry_id:string}[];accounts:string[]}
export interface MergeJournal extends Record<string,unknown> {header:{id:string;entry_date:string;[key:string]:unknown};lines:Record<string,unknown>[]}
/** No preview caps: every source line and every potentially changed descendant. */
export async function mergePopulation(ctx:ControlTx,source:string,target:string):Promise<MergePopulation>{
 const c=ctx.principal.companyId;
 const lines=await ctx.sql`SELECT id,journal_entry_id FROM gl_journal_lines WHERE company_id=${c}::uuid
  AND gl_account_id=${source}::uuid ORDER BY id` as MergePopulation['lines'];
 const accounts=await ctx.sql`WITH RECURSIVE tree(id) AS (
  SELECT id FROM gl_accounts WHERE company_id=${c}::uuid AND id=${source}::uuid
  UNION SELECT a.id FROM gl_accounts a JOIN tree t ON a.parent_account_id=t.id WHERE a.company_id=${c}::uuid
 ) SELECT id FROM gl_accounts WHERE company_id=${c}::uuid AND (id IN (SELECT id FROM tree) OR id=${target}::uuid) ORDER BY id` as {id:string}[];
 return {lines,accounts:accounts.map(row=>row.id)};
}
export function assertMergePopulation(before:MergePopulation,after:MergePopulation):void{
 if(canonicalJson(before)!==canonicalJson(after))throw new Error('GL merge population changed; retry the operation');
}
/** Complete persisted images, independent of posting eligibility and line limits. */
export async function readMergeJournals(ctx:ControlTx,ids:string[]):Promise<MergeJournal[]>{
 const c=ctx.principal.companyId;
 const headers=await ctx.sql`SELECT to_jsonb(e) AS material FROM gl_journal_entries e
  WHERE e.company_id=${c}::uuid AND e.id=ANY(${ids}::uuid[]) ORDER BY e.id FOR UPDATE OF e` as {material:MergeJournal['header']}[];
 if(headers.length!==ids.length)throw new Error('Merge journal not found');
 const rows:{material:Record<string,unknown>}[]=[];
 let cursor:string|null=null;
 for(;;){
  const page=await ctx.sql`SELECT (to_jsonb(l)-'debit'-'credit')||jsonb_build_object('debit',l.debit::text,'credit',l.credit::text) AS material
   FROM gl_journal_lines l WHERE l.company_id=${c}::uuid AND l.journal_entry_id=ANY(${ids}::uuid[])
   AND (${cursor}::uuid IS NULL OR l.id>${cursor}::uuid) ORDER BY l.id LIMIT 2000 FOR UPDATE OF l` as {material:Record<string,unknown>}[];
  rows.push(...page);if(page.length<2000)break;cursor=String(page[page.length-1]!.material.id);
 }
 const byJournal=new Map<string,Record<string,unknown>[]>();
 for(const {material} of rows){const id=String(material.journal_entry_id);const list=byJournal.get(id)??[];list.push(material);byJournal.set(id,list);}
 return headers.map(({material:header})=>({header,lines:byJournal.get(header.id)??[]}));
}

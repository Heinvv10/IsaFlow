import {expect} from 'vitest';
import type {Pool,PoolClient} from 'pg';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
/**
 * Plans of the statements the real services send to the canonical control tables, taken as app_user with real request
 * claims so FORCE RLS is in force. `lower(entity_id)` is not leakproof, and neither is the uuid->text cast in
 * `entity_id_canonical = i.id::text`: under RLS either one stops a clause from being an index condition unless the
 * other side is a Param. Plan shape, never timing.
 */
export const CANONICAL_TABLES=['control_entity_versions','control_change_events','control_operation_effects','control_operation_approvals','control_protected_evidence'];
const TOUCHES=new RegExp(`\\b(${CANONICAL_TABLES.join('|')})\\b`);
export interface Who {companyId:string;personId:string}
export interface Statement {text:string;values:unknown[]}
export interface PlanNode {'Node Type':string;'Index Name'?:string;'Index Cond'?:string;Filter?:string;'Recheck Cond'?:string;'Join Filter'?:string;
 'Hash Cond'?:string;'Merge Cond'?:string;Plans?:PlanNode[]}
export interface Explained {text:string;nodes:PlanNode[]}
const flatten=(node:PlanNode):PlanNode[]=>[node,...(node.Plans??[]).flatMap(flatten)];
async function asAppUser<T>(pool:Pool,who:Who,work:(client:PoolClient)=>Promise<T>):Promise<T>{
 const client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",
   [JSON.stringify({sub:who.personId,company_id:who.companyId,role:'authenticated'}),who.companyId]);
  return await work(client);
 }finally{await client.query('ROLLBACK');client.release();}
}
/** Runs `work` as the request would, records every statement it sends to a canonical table, and always rolls back. */
export async function captureStatements(pool:Pool,who:Who,work:(ctx:ControlTx)=>Promise<unknown>):Promise<Statement[]>{
 const issued:Statement[]=[];
 await asAppUser(pool,who,async real=>{
  const client=new Proxy(real,{get(target,prop){
   if(prop==='query')return(text:unknown,values?:unknown[])=>{
    if(typeof text==='string'&&TOUCHES.test(text))issued.push({text,values:values??[]});
    return (target.query as (t:unknown,v?:unknown[])=>Promise<unknown>).call(target,text,values);
   };
   const value=Reflect.get(target,prop,target) as unknown;
   return typeof value==='function'?(value as (...args:unknown[])=>unknown).bind(target):value;
  }}) as PoolClient;
  const claims={sub:who.personId,company_id:who.companyId,role:'authenticated'};
  // A refusal after the statement under test is expected: the plan, not the outcome, is what this records.
  await withControlRequest({client,userId:who.personId,companyId:who.companyId,claims},{...who,authMethod:'cookie'},()=>work(requireControlTx()))
   .catch((error:unknown)=>{issued.push({text:`-- refused: ${error instanceof Error?error.message:String(error)}`,values:[]});});
 });
 return issued.filter(statement=>!statement.text.startsWith('-- refused'));
}
/** EXPLAINs each statement in a fresh transaction as app_user, after proving RLS is in force for that session. */
export async function explainAsAppUser(pool:Pool,who:Who,statements:readonly Statement[]):Promise<Explained[]>{
 return asAppUser(pool,who,async client=>{
  const [session]=(await client.query("SELECT current_user AS role,current_setting('row_security') AS rls")).rows as {role:string;rls:string}[];
  expect(session,'plans were not taken under RLS as app_user').toEqual({role:'app_user',rls:'on'});
  const explained:Explained[]=[];
  for(const statement of statements){
   const result=await client.query(`EXPLAIN (FORMAT JSON) ${statement.text}`,statement.values);
   const plan=(result.rows[0] as {'QUERY PLAN':Array<{Plan:PlanNode}>})['QUERY PLAN'][0]!.Plan;
   explained.push({text:statement.text,nodes:flatten(plan)});
  }
  return explained;
 });
}
const LOWER_LOOKUP=/lower\(\(?(\w+\.)?entity_id\)?\)/;
/** A canonical column compared with a cast of another relation's column, e.g. `(e.entity_id_canonical = (i.id)::text)`. */
const CAST_JOIN=/entity_id_canonical\)? = \(\w+(\.\w+)?\)::text|\(\w+(\.\w+)?\)::text = \(?(\w+\.)?entity_id_canonical/;
/** No lookup by lower(entity_id), and no canonical-vs-cast comparison left as a join clause over the company's rows. */
export function expectIndexableCanonicalLookups(explained:readonly Explained[]){
 expect(explained.length,'no canonical-table statement was captured').toBeGreaterThan(0);
 for(const {text,nodes} of explained)for(const node of nodes){
  for(const key of ['Index Cond','Filter','Recheck Cond','Join Filter'] as const)
   expect(node[key]??'',`${node['Node Type']} ${key} matches lower(entity_id) in:\n${text}`).not.toMatch(LOWER_LOOKUP);
  for(const key of ['Join Filter','Hash Cond','Merge Cond'] as const)
   expect(node[key]??'',`${node['Node Type']} ${key} compares entity_id_canonical with a cast column in:\n${text}`).not.toMatch(CAST_JOIN);
 }
}
/** Index Cond nodes on `table` that use the canonical column; bitmap children carry the index name, not the relation. */
export function canonicalIndexConds(explained:readonly Explained[],table:string):string[]{
 return explained.flatMap(entry=>entry.nodes).filter(node=>(node['Index Name']??'').startsWith(`${table}_`)
  &&(node['Index Cond']??'').includes('entity_id_canonical')).map(node=>node['Index Cond']!);
}
/**
 * An intent reached from a canonical column is looked up by primary key: every `id=CASE WHEN c ~ … THEN c::uuid END` in
 * the SQL is an Index Cond, so the intent read is one probe per receipt, not a scan of the company's intents.
 */
export function expectIntentsByPrimaryKey(explained:readonly Explained[]){
 const reached=explained.filter(entry=>entry.text.includes('entity_id_canonical::uuid END'));
 expect(reached.length,'no statement reaching an intent from a canonical column was captured').toBeGreaterThan(0);
 for(const {text,nodes} of reached){
  const lookups=text.split('entity_id_canonical::uuid END').length-1;
  expect(nodes.filter(node=>(node['Index Cond']??'').includes('CASE WHEN')).length,`intent lookup is not a primary-key probe in:\n${text}`).toBeGreaterThanOrEqual(lookups);
 }
}
/** Every captured statement containing `marker` (at least one) reaches its intent by a primary-key probe. */
export function expectIntentProbe(explained:readonly Explained[],marker:string){
 const found=explained.filter(entry=>entry.text.includes(marker));
 expect(found.length,`no captured statement contains ${marker}`).toBeGreaterThan(0);
 for(const {text,nodes} of found)expect(nodes.some(node=>(node['Index Cond']??'').includes('CASE WHEN')),`intent is not a primary-key probe in:\n${text}`).toBe(true);
}
/** Every captured statement containing `marker` (at least one) reads `table` through exactly one canonical Index Cond. */
export function expectCanonicalIndexCond(explained:readonly Explained[],marker:string,table:string){
 const found=explained.filter(entry=>entry.text.includes(marker));
 expect(found.length,`no captured statement contains ${marker}`).toBeGreaterThan(0);
 for(const entry of found)expect(canonicalIndexConds([entry],table),`${table} without a canonical Index Cond in:\n${entry.text}`).toHaveLength(1);
}

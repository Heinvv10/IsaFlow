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
export interface PlanNode {'Node Type':string;'Parent Relationship'?:string;Alias?:string;'Index Name'?:string;'Index Cond'?:string;Filter?:string;'Recheck Cond'?:string;'Join Filter'?:string;
 'Hash Cond'?:string;'Merge Cond'?:string;Plans?:PlanNode[]}
export interface Explained {text:string;root:PlanNode;nodes:PlanNode[]}
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
   explained.push({text:statement.text,root:plan,nodes:flatten(plan)});
  }
  return explained;
 });
}
const LOWER_LOOKUP=/lower\(\(?(\w+\.)?entity_id\)?\)/;
/** A canonical column compared with a cast of another relation's column, e.g. `(e.entity_id_canonical = (i.id)::text)`. */
const CAST_JOIN=/entity_id_canonical\)? = \(\w+(\.\w+)?\)::text|\(\w+(\.\w+)?\)::text = \(?(\w+\.)?entity_id_canonical/;
/** The key a scan actually probes: its own Index Cond, or its bitmap children's. */
const probedKey=(node:PlanNode)=>[node['Index Cond']??'',...(node['Node Type']==='Bitmap Heap Scan'?flatten(node).map(child=>child['Index Cond']??''):[])].join(' ');
function pathTo(root:PlanNode,target:PlanNode):PlanNode[]|null{
 if(root===target)return[root];
 for(const child of root.Plans??[]){const path=pathTo(child,target);if(path)return[root,...path];}
 return null;
}
/**
 * The relations a filter's `(x.col)::text` can come from as a Var: those scanned inside its own query level, i.e. under
 * the deepest enclosing subquery boundary (a Limit or Subquery Scan, or a SubPlan/InitPlan root). A relation scanned
 * outside that boundary reaches the filter as a Param.
 */
function sameLevelAliases(root:PlanNode,node:PlanNode):Set<string>{
 const path=pathTo(root,node)??[root];
 const boundary=[...path].reverse().find(step=>['Limit','Subquery Scan'].includes(step['Node Type'])
  ||['SubPlan','InitPlan'].includes(step['Parent Relationship']??''))??root;
 return new Set(flatten(boundary).filter(step=>step!==node).map(step=>step.Alias).filter((alias):alias is string=>!!alias));
}
/**
 * No lookup by lower(entity_id), and no canonical-vs-cast comparison over the company's rows: never a Join Filter, Hash
 * Cond or Merge Cond, and as a scan's Filter or Recheck Cond only beside an Index Cond on that same key (the canonical
 * column, or an intent's primary-key CASE) — unless every cast column comes from outside the scan's query level, where
 * it is a Param and the index choice is the planner's (a LIMITed LATERAL on a table the statistics call tiny).
 */
export function expectIndexableCanonicalLookups(explained:readonly Explained[]){
 expect(explained.length,'no canonical-table statement was captured').toBeGreaterThan(0);
 for(const {text,root,nodes} of explained)for(const node of nodes){
  for(const key of ['Index Cond','Filter','Recheck Cond','Join Filter'] as const)
   expect(node[key]??'',`${node['Node Type']} ${key} matches lower(entity_id) in:\n${text}`).not.toMatch(LOWER_LOOKUP);
  for(const key of ['Join Filter','Hash Cond','Merge Cond'] as const)
   expect(node[key]??'',`${node['Node Type']} ${key} compares entity_id_canonical with a cast column in:\n${text}`).not.toMatch(CAST_JOIN);
  for(const key of ['Filter','Recheck Cond'] as const){
   const condition=node[key]??'';
   if(!CAST_JOIN.test(condition)||/entity_id_canonical|CASE WHEN/.test(probedKey(node)))continue;
   const local=sameLevelAliases(root,node),cast=[...condition.matchAll(/\((\w+)\.\w+\)::text/g)].map(match=>match[1]!);
   expect(cast.filter(alias=>local.has(alias)),`${node['Node Type']} ${key} filters entity_id_canonical against a same-level cast column it does not probe by, in:\n${text}`).toEqual([]);
  }
 }
}
/** Index Cond nodes on `table` that use the canonical column; bitmap children carry the index name, not the relation. */
export function canonicalIndexConds(explained:readonly Explained[],table:string):string[]{
 return explained.flatMap(entry=>entry.nodes).filter(node=>(node['Index Name']??'').startsWith(`${table}_`)
  &&(node['Index Cond']??'').includes('entity_id_canonical')).map(node=>node['Index Cond']!);
}
/**
 * Every captured statement containing `marker` (at least one) reaches its intents by exactly `probes` primary-key
 * probes (`id = CASE WHEN c ~ … THEN c::uuid END` as an Index Cond). The count is fixed by the caller, never read from
 * the SQL, so deleting a CASE from one UNION arm cannot delete its own requirement.
 */
export function expectIntentProbes(explained:readonly Explained[],marker:string,probes:number){
 const found=explained.filter(entry=>entry.text.includes(marker));
 expect(found.length,`no captured statement contains ${marker}`).toBeGreaterThan(0);
 for(const {text,nodes} of found)expect(nodes.filter(node=>(node['Index Cond']??'').includes('CASE WHEN')).length,
  `intent primary-key probes in:\n${text}`).toBe(probes);
}
/** Every captured statement containing `marker` (at least one) reads `table` through exactly one canonical Index Cond. */
export function expectCanonicalIndexCond(explained:readonly Explained[],marker:string,table:string){
 const found=explained.filter(entry=>entry.text.includes(marker));
 expect(found.length,`no captured statement contains ${marker}`).toBeGreaterThan(0);
 for(const entry of found)expect(canonicalIndexConds([entry],table),`${table} without a canonical Index Cond in:\n${entry.text}`).toHaveLength(1);
}

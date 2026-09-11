import {expect} from 'vitest';
import type {Pool,PoolClient} from 'pg';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
/**
 * Plans of the statements the real services send to the canonical control tables, taken as app_user with real request
 * claims so FORCE RLS is in force. `lower(entity_id)` is not leakproof, and neither is the uuid->text cast in
 * `entity_id_canonical = i.id::text`: under RLS either one stops a clause from being an index condition unless the
 * other side is a Param. Plan shape, never timing, and never which index wins: on a new install's row counts every
 * path estimates one row and the planner keeps whichever index it met first, so a gate that demanded the canonical index
 * would be red on every fresh database. It asserts the lookup is in the form RLS lets be an index condition, and that
 * the index migration 684 built for it exists, instead.
 */
/**
 * The leading key columns of each canonical index migration 684 creates: the equalities every lookup states, ending in
 * the canonical column. A promotable predicate is worth nothing without an index to promote it into.
 */
const CANONICAL_INDEX_PREFIX:Record<string,string[]>={
 control_entity_versions:['company_id','entity_type','entity_id_canonical'],
 control_change_events:['company_id','entity_type','entity_id_canonical'],
 control_operation_effects:['company_id','operation','entity_type','entity_id_canonical'],
 control_operation_approvals:['company_id','entity_type','entity_id_canonical'],
 control_protected_evidence:['company_id','entity_type','entity_id_canonical'],
};
export const CANONICAL_TABLES=Object.keys(CANONICAL_INDEX_PREFIX);
const TOUCHES=new RegExp(`\\b(${CANONICAL_TABLES.join('|')})\\b`);
export interface Who {companyId:string;personId:string}
export interface Statement {text:string;values:unknown[]}
export interface PlanNode {'Node Type':string;'Relation Name'?:string;'Index Cond'?:string;Filter?:string;'Recheck Cond'?:string;'Join Filter'?:string;
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
/**
 * EXPLAINs each statement in a fresh transaction as app_user, after proving RLS is in force for that session. Nested
 * loops are off so a same-level canonical-vs-cast join can only be a Hash Cond, Merge Cond or Join Filter, all refused:
 * a cast column left in a scan's Filter is then a lateral or SubPlan Param, never a same-level Var — a distinction the
 * plan cannot show once the planner drops the trivial Subquery Scan of a `LATERAL(... OFFSET 0)`. A LATERAL still gets
 * its nested loop, being the only join that can run it.
 */
export async function explainAsAppUser(pool:Pool,who:Who,statements:readonly Statement[]):Promise<Explained[]>{
 return asAppUser(pool,who,async client=>{
  await client.query('SET LOCAL enable_nestloop=off');
  const [session]=(await client.query(`SELECT current_user AS role,current_setting('row_security') AS rls,
   (SELECT proleakproof FROM pg_proc WHERE oid='texteq'::regproc) AS leakproof`)).rows as {role:string;rls:string;leakproof:boolean}[];
  expect(session,'plans were not taken under RLS as app_user, or text equality is no longer leakproof').toEqual({role:'app_user',rls:'on',leakproof:true});
  // A valid, whole-table btree whose key starts with exactly those columns; an expression key column never matches.
  const unserved=(await client.query(`SELECT t.name FROM jsonb_each($1::jsonb) t(name,prefix) WHERE NOT EXISTS(
   SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
   WHERE i.indrelid=to_regclass(t.name) AND i.indisvalid AND i.indpred IS NULL AND am.amname='btree'
    AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum,ord)
     LEFT JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE k.ord<=jsonb_array_length(t.prefix))
     =ARRAY(SELECT jsonb_array_elements_text(t.prefix)))`,[JSON.stringify(CANONICAL_INDEX_PREFIX)])).rows.map(row=>(row as {name:string}).name);
  expect(unserved,'canonical tables without the index migration 684 creates for their lookups').toEqual([]);
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
/**
 * A canonical column compared with a cast of another relation's column, e.g. `(e.entity_id_canonical = (i.id)::text)`;
 * a Merge Cond wraps the cast once more (`(((i.id)::text) = e.entity_id_canonical)`), a UNION arm's alias is quoted.
 */
const CAST='\\(?\\((\\w+|"[^"]+")(\\.\\w+)?\\)::text\\)?';
const CAST_JOIN=new RegExp(`entity_id_canonical\\)? = ${CAST}|${CAST} = \\(?(\\w+\\.)?entity_id_canonical`);
/**
 * No lookup by lower(entity_id) anywhere, and no canonical-vs-cast comparison as a join condition: under RLS that join
 * reads every row of the company on at least one side. With nested loops off it cannot hide in a scan's Filter.
 */
export function expectIndexableCanonicalLookups(explained:readonly Explained[]){
 expect(explained.length,'no canonical-table statement was captured').toBeGreaterThan(0);
 for(const {text,nodes} of explained)for(const node of nodes){
  for(const key of ['Index Cond','Filter','Recheck Cond','Join Filter','Hash Cond','Merge Cond'] as const)
   expect(node[key]??'',`${node['Node Type']} ${key} matches lower(entity_id) in:\n${text}`).not.toMatch(LOWER_LOOKUP);
  for(const key of ['Join Filter','Hash Cond','Merge Cond'] as const)
   expect(node[key]??'',`${node['Node Type']} ${key} compares entity_id_canonical with a cast column in:\n${text}`).not.toMatch(CAST_JOIN);
 }
}
/**
 * The scan's own column, bare, on one side of `=`: text equality is leakproof, and the other side is a constant, a
 * Param or an outer relation's column (nested loops are off), so RLS lets this be an index condition. A wrapped column
 * (`lower(entity_id_canonical)`, `(entity_id_canonical)::uuid`) or a qualified one (another relation's) does not match.
 */
const CANONICAL_EQ=/(^|[(\s])entity_id_canonical = |= entity_id_canonical\)/;
const bitmapConds=(node:PlanNode):string[]=>(node.Plans??[]).filter(child=>child['Node Type'].startsWith('Bitmap'))
 .flatMap(child=>[child['Index Cond']??'',...bitmapConds(child)]);
/**
 * Scans of `table` that look it up by its canonical column in an indexable form — as their Index Cond, a bitmap child's,
 * or a Filter or Recheck Cond when the statistics made another index cheaper. Which of those is the planner's call.
 */
export function canonicalLookups(explained:readonly Explained[],table:string):PlanNode[]{
 return explained.flatMap(entry=>entry.nodes).filter(node=>node['Relation Name']===table
  &&[node['Index Cond']??'',node.Filter??'',node['Recheck Cond']??'',...bitmapConds(node)].some(condition=>CANONICAL_EQ.test(condition)));
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
/**
 * A statement's `id = CASE WHEN … THEN …::uuid END` probe (its own bare `id`, never `lower(id)` or a cast of it,
 * against the Param-derived value the CASE guards) reaches `relation` by an index-usable form: an Index Cond when
 * the planner picks that scan, a Filter or Recheck Cond when a small table's statistics make a different scan (or
 * none at all) cheaper. `expectIntentProbes` above counts only Index Cond nodes across the WHOLE statement, so a
 * multi-relation UNION query — e.g. one arm probing intents, the other reversal intents — conflates both relations
 * into one number; on a fresh, near-empty database the planner can Seq Scan the smaller table's Filter instead of
 * an Index Cond, and the pinned count goes from 2 to 1 with nothing wrong. This checks each relation is actually
 * probed by its own bare id in a usable form, and that its primary key still reaches `id`, not which scan ran today.
 */
const BARE_ID_CASE_PROBE=/(^|[(\s])(\w+\.)?id = CASE WHEN|CASE WHEN[\s\S]*?= (\w+\.)?id\b/;
export async function expectUsableIntentProbes(pool:Pool,explained:readonly Explained[],marker:string,relations:readonly string[]){
 const found=explained.filter(entry=>entry.text.includes(marker));
 expect(found.length,`no captured statement contains ${marker}`).toBeGreaterThan(0);
 for(const relation of relations){
  const usable=found.some(({nodes})=>nodes.some(node=>node['Relation Name']===relation
   &&[node['Index Cond']??'',node.Filter??'',node['Recheck Cond']??''].some(condition=>BARE_ID_CASE_PROBE.test(condition))));
  expect(usable,`${relation} is not probed by its own bare id against a Param-derived value in a statement containing ${marker}`).toBe(true);
  const {rows}=await pool.query(`SELECT 1 FROM pg_constraint co JOIN pg_attribute a ON a.attrelid=co.conrelid AND a.attnum=ANY(co.conkey)
   WHERE co.conrelid=to_regclass($1) AND co.contype='p' AND a.attname='id'`,[relation]);
  expect(rows,`${relation} has no primary key reaching id`).toHaveLength(1);
 }
}
/** Every captured statement containing `marker` (at least one) reads `table` through exactly `lookups` canonical lookups. */
export function expectCanonicalLookup(explained:readonly Explained[],marker:string,table:string,lookups=1){
 const found=explained.filter(entry=>entry.text.includes(marker));
 expect(found.length,`no captured statement contains ${marker}`).toBeGreaterThan(0);
 for(const entry of found)expect(canonicalLookups([entry],table),`${table} canonical lookups in:\n${entry.text}`).toHaveLength(lookups);
}

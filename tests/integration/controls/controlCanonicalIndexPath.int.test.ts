import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import {checkJournalRisks} from '@/modules/accounting/services/controls/journalRiskChecks';
import {journalRiskPopulationSql} from '@/modules/accounting/services/controls/journalRiskPopulationSql';
import {loadIntentReceipt} from '@/modules/accounting/services/controls/intentIdentity';
import {readControlEntityVersion} from '@/modules/accounting/services/controls/operationVersions';
import {assertHistoryEntity} from '@/modules/accounting/services/controls/controlChangeHistoryPolicy';
import {CUTOFF,seedJournalRiskPopulation} from './journalRiskCheckRunFixture';
/**
 * Control rows are matched by canonical entity identity. `lower(entity_id)` is not leakproof and these tables FORCE
 * RLS, so as app_user a `lower(entity_id)=...` lookup is never an index condition: it filters every row of the
 * company (825 ms a journal on the risk population at 1M change events). The stored `entity_id_canonical` column is
 * compared with leakproof text equality and must stay the Index Cond. Deterministic: plan shape, not timings, taken
 * from the statements the real services issue, as app_user with the worker's request claims, RLS in force.
 */
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:3});
const TABLES=['control_entity_versions','control_change_events','control_operation_effects','control_operation_approvals','control_protected_evidence'];
const TOUCHES=new RegExp(`\\b(${TABLES.join('|')})\\b`);
let fixture:ForensicFixture,journalId:string;
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);await seedJournalRiskPopulation(pool,fixture);
 const [row]=(await pool.query(`SELECT j.id::text FROM gl_journal_entries j WHERE j.company_id=$1 AND EXISTS(SELECT 1 FROM control_change_events e
  WHERE e.company_id=j.company_id AND e.entity_type='journal_entry' AND e.entity_id=j.id::text) LIMIT 1`,[fixture.companyA])).rows as {id:string}[];
 journalId=row!.id;
},180000);
afterAll(()=>pool.end());
interface PlanNode {'Node Type':string;'Relation Name'?:string;'Index Name'?:string;'Index Cond'?:string;Filter?:string;'Recheck Cond'?:string;'Join Filter'?:string;Plans?:PlanNode[]}
interface Explained {text:string;nodes:PlanNode[]}
const flatten=(node:PlanNode):PlanNode[]=>[node,...(node.Plans??[]).flatMap(flatten)];
/** Run `work` as the worker does, recording every statement it sends to a control table, then EXPLAIN each one in the same transaction. */
async function explainIssued(work:(ctx:ControlTx)=>Promise<unknown>,extra:Array<{text:string;values:unknown[]}>=[]):Promise<Explained[]>{
 const who={companyId:fixture.companyA,personId:fixture.u1.id};
 return withAuditWorkerTransaction(pool,{...who,jobId:randomUUID()},'repeatable read',Date.now()+120000,undefined,async store=>{
  const real=store.client,issued=[...extra];
  store.client=new Proxy(real,{get(target,prop){
   if(prop==='query')return(text:unknown,values?:unknown[])=>{
    if(typeof text==='string'&&TOUCHES.test(text))issued.push({text,values:values??[]});
    return (target.query as (t:unknown,v?:unknown[])=>Promise<unknown>).call(target,text,values);
   };
   const value=Reflect.get(target,prop,target) as unknown;
   return typeof value==='function'?(value as (...args:unknown[])=>unknown).bind(target):value;
  }}) as PoolClient;
  await withControlRequest(store,{...who,authMethod:'cookie'},()=>work(requireControlTx()));
  const explained:Explained[]=[];
  for(const statement of issued){
   const result=await real.query(`EXPLAIN (FORMAT JSON) ${statement.text}`,statement.values);
   const plan=(result.rows[0] as {'QUERY PLAN':Array<{Plan:PlanNode}>})['QUERY PLAN'][0]!.Plan;
   explained.push({text:statement.text,nodes:flatten(plan)});
  }
  return explained;
 });
}
const LOWER_LOOKUP=/lower\(\(?(\w+\.)?entity_id\)?\)/;
/** Nothing issued may look a control row up by lower(entity_id): under RLS that is a Filter over the company. */
function expectNoLowerLookup(explained:Explained[]){
 expect(explained.length,'no control-table statement was captured').toBeGreaterThan(0);
 for(const {text,nodes} of explained)for(const node of nodes)for(const key of ['Index Cond','Filter','Recheck Cond','Join Filter'] as const){
  expect(node[key]??'',`${node['Node Type']} ${key} matches lower(entity_id) in:\n${text}`).not.toMatch(LOWER_LOOKUP);
 }
}
/** Index Cond nodes on `table` that use the canonical column; bitmap children carry the index name, not the relation. */
function canonicalIndexConds(explained:Explained[],table:string):string[]{
 return explained.flatMap(entry=>entry.nodes).filter(node=>(node['Index Name']??'').startsWith(`${table}_`)
  &&(node['Index Cond']??'').includes('entity_id_canonical')).map(node=>node['Index Cond']!);
}
it('the journal risk population reads versions and change events through the canonical index, both readings',async()=>{
 const cursor=journalRiskPopulationSql({companyId:fixture.companyA,cutoff:CUTOFF,slabTuple:true});
 const explained=await explainIssued(ctx=>checkJournalRisks(ctx,{cutoff:CUTOFF,limit:100}),[{text:cursor.text,values:cursor.values}]);
 expectNoLowerLookup(explained);
 for(const reading of explained.filter(entry=>entry.text.includes('lineage_count'))){
  expect(canonicalIndexConds([reading],'control_entity_versions'),`entity-version LATERAL without a canonical Index Cond:\n${reading.text}`).toHaveLength(1);
  // x (change facts) and n (change count). The period's latest event (history, event) walks the company's few
  // fiscal_period events in occurred_at order and joins the period, exactly as before the canonical work.
  expect(canonicalIndexConds([reading],'control_change_events'),`change-event lookups without a canonical Index Cond:\n${reading.text}`).toHaveLength(2);
 }
 expect(explained.filter(entry=>entry.text.includes('lineage_count')),'both readings of the population were explained').toHaveLength(2);
},180000);
it('an operation-effect receipt read, a version lineage read and a change-event lookup use the canonical index',async()=>{
 const explained=await explainIssued(async ctx=>{
  await loadIntentReceipt(ctx,{entityType:'bank_allocation_intent',entityId:randomUUID().toUpperCase(),operation:'bank_allocation.post'});
  await readControlEntityVersion(ctx,{entityType:'journal_entry',entityId:journalId.toUpperCase()});
  await assertHistoryEntity(ctx,'journal_entry',journalId.toUpperCase());
 });
 expectNoLowerLookup(explained);
 expect(canonicalIndexConds(explained,'control_operation_effects'),'receipt read').toHaveLength(1);
 expect(canonicalIndexConds(explained,'control_entity_versions'),'version lineage read').toHaveLength(1);
 expect(canonicalIndexConds(explained,'control_change_events'),'change-event lookup').toHaveLength(1);
},180000);

import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {checkJournalRisks} from '@/modules/accounting/services/controls/journalRiskChecks';
import {journalRiskPopulationSql} from '@/modules/accounting/services/controls/journalRiskPopulationSql';
import {loadIntentReceipt} from '@/modules/accounting/services/controls/intentIdentity';
import {readControlEntityVersion} from '@/modules/accounting/services/controls/operationVersions';
import {assertHistoryEntity} from '@/modules/accounting/services/controls/controlChangeHistoryPolicy';
import {CUTOFF,seedJournalRiskPopulation} from './journalRiskCheckRunFixture';
import {canonicalIndexConds,captureStatements,explainAsAppUser,expectIndexableCanonicalLookups,type Who} from './canonicalPlanCapture';
/**
 * Control rows are matched by canonical entity identity. `lower(entity_id)` is not leakproof and these tables FORCE
 * RLS, so as app_user a `lower(entity_id)=...` lookup is never an index condition: it filters every row of the
 * company (825 ms a journal on the risk population at 1M change events). The stored `entity_id_canonical` column is
 * compared with leakproof text equality and must stay the Index Cond. Deterministic: plan shape, not timings, taken
 * from the statements the real services issue, as app_user with request claims, RLS in force.
 */
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:3});
let fixture:ForensicFixture,who:Who,journalId:string;
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);await seedJournalRiskPopulation(pool,fixture);who={companyId:fixture.companyA,personId:fixture.u1.id};
 const [row]=(await pool.query(`SELECT j.id::text FROM gl_journal_entries j WHERE j.company_id=$1 AND EXISTS(SELECT 1 FROM control_change_events e
  WHERE e.company_id=j.company_id AND e.entity_type='journal_entry' AND e.entity_id=j.id::text) LIMIT 1`,[fixture.companyA])).rows as {id:string}[];
 journalId=row!.id;
},180000);
afterAll(()=>pool.end());
it('the journal risk population reads versions and change events through the canonical index, both readings',async()=>{
 const cursor=journalRiskPopulationSql({companyId:fixture.companyA,cutoff:CUTOFF,slabTuple:true});
 const statements=[{text:cursor.text,values:cursor.values},...await captureStatements(pool,who,ctx=>checkJournalRisks(ctx,{cutoff:CUTOFF,limit:100}))];
 const explained=await explainAsAppUser(pool,who,statements);
 expectIndexableCanonicalLookups(explained);
 for(const reading of explained.filter(entry=>entry.text.includes('lineage_count'))){
  expect(canonicalIndexConds([reading],'control_entity_versions'),`entity-version LATERAL without a canonical Index Cond:\n${reading.text}`).toHaveLength(1);
  // x (change facts), n (change count), and the period's latest event read twice (history, event).
  expect(canonicalIndexConds([reading],'control_change_events'),`change-event lookups without a canonical Index Cond:\n${reading.text}`).toHaveLength(4);
 }
 expect(explained.filter(entry=>entry.text.includes('lineage_count')),'both readings of the population were explained').toHaveLength(2);
},180000);
it('an operation-effect receipt read, a version lineage read and a change-event lookup use the canonical index',async()=>{
 const explained=await explainAsAppUser(pool,who,await captureStatements(pool,who,async ctx=>{
  await loadIntentReceipt(ctx,{entityType:'bank_allocation_intent',entityId:randomUUID().toUpperCase(),operation:'bank_allocation.post'});
  await readControlEntityVersion(ctx,{entityType:'journal_entry',entityId:journalId.toUpperCase()});
  await assertHistoryEntity(ctx,'journal_entry',journalId.toUpperCase());
 }));
 expectIndexableCanonicalLookups(explained);
 expect(canonicalIndexConds(explained,'control_operation_effects'),'receipt read').toHaveLength(1);
 expect(canonicalIndexConds(explained,'control_entity_versions'),'version lineage read').toHaveLength(1);
 expect(canonicalIndexConds(explained,'control_change_events'),'change-event lookup').toHaveLength(1);
},180000);

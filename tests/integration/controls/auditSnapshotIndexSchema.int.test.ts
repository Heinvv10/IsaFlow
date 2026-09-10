import {randomBytes,randomUUID} from 'node:crypto';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {runAuditSnapshotJob} from '@/modules/accounting/services/controls/auditJobRunner';
import {withControlRequest,withControlJobRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot} from '@/modules/accounting/services/controls/auditJobService';
import {enqueueAuditComparison} from '@/modules/accounting/services/controls/auditComparisonJobService';
import {claimAuditJobForWorker,type AuditJobLease} from '@/modules/accounting/services/controls/auditJobLease';
import {AUDIT_WORKER_CLASS_KINDS} from '@/modules/accounting/services/controls/auditJobContract';
import type {RequestContext} from '@/lib/als';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,type ForensicFixture,validateFixtureTarget} from '../forensic-fixture';
const target=validateFixtureTarget(fixtureConfigFromEnv(process.env));
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:1});
afterAll(()=>pool.end());
it.each(['control_audit_snapshot_indexes','control_audit_snapshot_index_items','control_audit_snapshot_index_chunks'])('stores immutable tenant-protected bounded material in %s',async table=>{
 expect((await pool.query('SELECT to_regclass($1)::text AS name',[table])).rows[0].name).toBe(table);
 const row=(await pool.query("SELECT has_table_privilege('app_user',$1,'SELECT') AS read,has_table_privilege('app_user',$1,'INSERT') AS create,has_table_privilege('app_user',$1,'UPDATE') AS update,has_table_privilege('app_user',$1,'DELETE') AS delete",[table])).rows[0];
 expect(row).toEqual({read:true,create:true,update:false,delete:false});
 const rls=(await pool.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=to_regclass($1)',[table])).rows[0];
 expect(rls).toEqual({relrowsecurity:true,relforcerowsecurity:true});
});

let fixture:ForensicFixture,ownSnapshot:string,foreignSnapshot:string,liveLease:AuditJobLease;
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
function actor<T>(person:'u1'|'u2'|'u3',work:(store:RequestContext)=>Promise<T>){
 const user=fixture[person];
 return withAuditWorkerTransaction(pool,{companyId:user.companyId,personId:user.id,jobId:randomUUID()},'read committed',Date.now()+10000,undefined,
  store=>withControlRequest(store,{companyId:user.companyId,personId:user.id,authMethod:'cookie'},()=>work(store)));
}
async function claim(person:'u1'|'u2',jobId:string):Promise<AuditJobLease>{
 const user=fixture[person];
 const lease=await withAuditWorkerTransaction(pool,{companyId:user.companyId,personId:user.id,jobId},'read committed',Date.now()+15000,undefined,
  store=>claimAuditJobForWorker(store,jobId,AUDIT_WORKER_CLASS_KINDS.audit));
 if(!lease)throw new Error('Missing fixture lease');
 return lease;
}
function worker<T>(lease:AuditJobLease,fn:(ctx:ControlTx)=>Promise<T>):Promise<T>{
 return withAuditWorkerTransaction(pool,{companyId:lease.companyId,personId:lease.personId,jobId:lease.jobId},'read committed',Date.now()+15000,undefined,
  store=>withControlJobRequest(store,lease,()=>fn(requireControlTx())));
}
beforeAll(async()=>{
 fixture=await provisionForensicFixture(fixtureConfigFromEnv(process.env));
 const ids:string[]=[];
 for(const person of ['u1','u3'] as const){
  const job=await actor(person,()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));
  const user=fixture[person];
  expect(await runAuditSnapshotJob({companyId:user.companyId,personId:user.id,jobId:job.id},{pool})).toMatchObject({state:'succeeded'});ids.push(job.id);
 }
 [ownSnapshot,foreignSnapshot]=ids as [string,string];
});
it('permits owned append-only index rows but rejects foreign and different-maker creation',async()=>{
 // Storage-policy fixtures intentionally use opaque dummy envelopes; material authentication has separate tests.
 await actor('u1',async({client})=>{
  // The real worker built this header under its own live-lease authority in beforeAll.
  expect((await client.query('SELECT snapshot_id FROM control_audit_snapshot_indexes WHERE company_id=$1 AND snapshot_id=$2',[fixture.companyA,ownSnapshot])).rows).toHaveLength(1);
 });
 // Migration 673 seals a snapshot's index to appends once its build job is no longer 'running' with a
 // live lease. ownSnapshot's original build already succeeded (sealed), so re-exercising the "owned
 // append" path needs a genuinely live lease: enqueue+claim a second builder job (audit_compare permits
 // building any existing snapshot_id) and rebuild the header/items/chunks under it, exactly as the real
 // worker would.
 const compared=await actor('u1',()=>enqueueAuditComparison(requireControlTx(),{firstSnapshotId:ownSnapshot,secondSnapshotId:ownSnapshot,idempotencyKey:randomUUID()}));
 liveLease=await claim('u1',compared.id);
 // Fixture-only removal of the sealed original header/items/chunks so the live builder can recreate
 // them; ownSnapshot's underlying control_audit_snapshots row (the real snapshot) is untouched.
 for(const table of ['control_audit_snapshot_index_chunks','control_audit_snapshot_index_items','control_audit_snapshot_indexes'])
  await pool.query(`DELETE FROM ${table} WHERE company_id=$1 AND snapshot_id=$2`,[fixture.companyA,ownSnapshot]);
 await worker(liveLease,async ctx=>{
  expect(await ctx.sql`INSERT INTO control_audit_snapshot_indexes(company_id,snapshot_id,protected_header,build_job_id,build_generation,build_lease_id)
   VALUES(${fixture.companyA}::uuid,${ownSnapshot}::uuid,'{}'::jsonb,${liveLease.jobId}::uuid,${liveLease.generation},${liveLease.leaseId}::uuid) RETURNING snapshot_id`).toEqual([{snapshot_id:ownSnapshot}]);
  expect(await ctx.sql`INSERT INTO control_audit_snapshot_index_items(company_id,snapshot_id,section,ordinal,protected_item) VALUES(${fixture.companyA}::uuid,${ownSnapshot}::uuid,'records',0,'{}') RETURNING ordinal`).toEqual([{ordinal:0}]);
  expect(await ctx.sql`INSERT INTO control_audit_snapshot_index_chunks(company_id,snapshot_id,section,ordinal,chunk_ordinal,protected_chunk) VALUES(${fixture.companyA}::uuid,${ownSnapshot}::uuid,'records',0,0,'{}') RETURNING chunk_ordinal`).toEqual([{chunk_ordinal:0}]);
 });
 await expect(actor('u1',({client})=>client.query("INSERT INTO control_audit_snapshot_indexes(company_id,snapshot_id,protected_header) VALUES($1,$2,'{}')",[fixture.companyB,foreignSnapshot]))).rejects.toMatchObject({code:'42501'});
 // liveLease's job was requested (and claimed) by u1; u2 sharing company A is still refused because the
 // append policy binds to the job's requester, not merely the tenant.
 await expect(actor('u2',({client})=>client.query("INSERT INTO control_audit_snapshot_index_items(company_id,snapshot_id,section,ordinal,protected_item) VALUES($1,$2,'records',1,'{}')",[fixture.companyA,ownSnapshot]))).rejects.toMatchObject({code:'42501'});
 for(const table of ['control_audit_snapshot_indexes','control_audit_snapshot_index_items','control_audit_snapshot_index_chunks']){
  // Fixed test-owned table identifiers only; application readers use tagged SQL.
  expect((await actor('u3',({client})=>client.query(`SELECT company_id FROM ${table} WHERE company_id=$1`,[fixture.companyA]))).rows).toEqual([]);
  await expect(actor('u1',({client})=>client.query(`DELETE FROM ${table} WHERE company_id=$1`,[fixture.companyA]))).rejects.toMatchObject({code:'42501'});
 }
});
it('rejects oversized encrypted chunks at the storage boundary',async()=>{
 // Its own parent item (not test 1's ordinal 0) so this test stands alone; reuses test 1's still-live
 // lease because the header it must attach to was permanently bound to that job at INSERT time. Both
 // statements run in one worker transaction and the whole call is expected to reject: once the oversized
 // chunk hits the CHECK violation the transaction is aborted, so nothing after it (including a COMMIT)
 // can run — matching how the lineage-authority tests assert on the outer transaction, not a query inside it.
 await expect(worker(liveLease,async ctx=>{
  await ctx.sql`INSERT INTO control_audit_snapshot_index_items(company_id,snapshot_id,section,ordinal,protected_item) VALUES(${fixture.companyA}::uuid,${ownSnapshot}::uuid,'records',1,'{}')`;
  await ctx.sql`INSERT INTO control_audit_snapshot_index_chunks(company_id,snapshot_id,section,ordinal,chunk_ordinal,protected_chunk) VALUES(${fixture.companyA}::uuid,${ownSnapshot}::uuid,'records',1,0,${JSON.stringify({ciphertext:'x'.repeat(1048576)})}::jsonb)`;
 })).rejects.toMatchObject({code:'23514'});
});

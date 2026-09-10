import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {withControlRequest,withControlJobRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {claimAuditJobForWorker,type AuditJobLease} from '@/modules/accounting/services/controls/auditJobLease';
import {enqueueAuditSnapshot} from '@/modules/accounting/services/controls/auditJobService';
import {enqueueAuditComparison} from '@/modules/accounting/services/controls/auditComparisonJobService';
import {runAuditSnapshotJob} from '@/modules/accounting/services/controls/auditJobRunner';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
let f:ForensicFixture,original:string,comparison:AuditJobLease,snapshot:AuditJobLease;
const rollback=new Error('Rollback synthetic unsigned policy probe');
function actor<T>(person:'u1'|'u2',fn:()=>Promise<T>){const user=f[person];return withAuditWorkerTransaction(pool,{companyId:user.companyId,personId:user.id,jobId:randomUUID()},'read committed',Date.now()+15000,undefined,
 store=>withControlRequest(store,{companyId:user.companyId,personId:user.id,authMethod:'cookie'},fn));}
async function claim(person:'u1'|'u2',jobId:string){const user=f[person];const lease=await withAuditWorkerTransaction(pool,{companyId:user.companyId,personId:user.id,jobId},'read committed',Date.now()+15000,undefined,store=>claimAuditJobForWorker(store,jobId));if(!lease)throw new Error('Missing fixture lease');return lease;}
beforeAll(async()=>{
 f=await provisionForensicFixture(config);
 const job=await actor('u1',()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));original=job.id;
 expect(await runAuditSnapshotJob({companyId:f.companyA,personId:f.u1.id,jobId:original},{pool})).toMatchObject({state:'succeeded'});
 const compared=await actor('u2',()=>enqueueAuditComparison(requireControlTx(),{firstSnapshotId:original,secondSnapshotId:original,idempotencyKey:randomUUID()}));comparison=await claim('u2',compared.id);
 const pending=await actor('u1',()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));snapshot=await claim('u1',pending.id);
 // Fixture-only historical index removal. Original authentic snapshot remains intact.
 for(const table of ['control_audit_snapshot_index_chunks','control_audit_snapshot_index_items','control_audit_snapshot_indexes'])await pool.query(`DELETE FROM ${table} WHERE company_id=$1 AND snapshot_id=$2`,[f.companyA,original]);
});
afterAll(()=>pool.end());
function worker(lease:AuditJobLease,fn:(ctx:ControlTx)=>Promise<void>){return withAuditWorkerTransaction(pool,{companyId:lease.companyId,personId:lease.personId,jobId:lease.jobId},'read committed',Date.now()+15000,undefined,store=>withControlJobRequest(store,lease,async()=>{
 const ctx=requireControlTx();expect((await ctx.sql`SELECT current_user AS role`)[0]).toEqual({role:'app_user'});await fn(ctx);throw rollback;
}));}
// Unsigned '{}' headers/items test SQL policy only. Every probe rolls back, including valid writes.
function header(ctx:ControlTx,lease:AuditJobLease,override:{companyId?:string;jobId?:string|null;generation?:number|null;leaseId?:string|null}={}){
 return ctx.sql`INSERT INTO control_audit_snapshot_indexes(company_id,snapshot_id,protected_header,build_job_id,build_generation,build_lease_id)
 VALUES(${override.companyId??f.companyA}::uuid,${original}::uuid,'{}'::jsonb,${override.jobId===undefined?lease.jobId:override.jobId}::uuid,
 ${override.generation===undefined?lease.generation:override.generation},${override.leaseId===undefined?lease.leaseId:override.leaseId}::uuid) RETURNING snapshot_id`;
}
it('accepts a live issued second-person comparison builder and rolls back every unsigned policy probe',async()=>{
 await expect(worker(comparison,async ctx=>{
  expect(await header(ctx,comparison)).toEqual([{snapshot_id:original}]);
  expect(await ctx.sql`INSERT INTO control_audit_snapshot_index_items(company_id,snapshot_id,section,ordinal,protected_item) VALUES(${f.companyA}::uuid,${original}::uuid,'records',0,'{}') RETURNING ordinal`).toEqual([{ordinal:0}]);
  expect(await ctx.sql`INSERT INTO control_audit_snapshot_index_chunks(company_id,snapshot_id,section,ordinal,chunk_ordinal,protected_chunk) VALUES(${f.companyA}::uuid,${original}::uuid,'records',0,0,'{}') RETURNING chunk_ordinal`).toEqual([{chunk_ordinal:0}]);
 })).rejects.toBe(rollback);
 expect((await pool.query('SELECT snapshot_id FROM control_audit_snapshot_indexes WHERE company_id=$1 AND snapshot_id=$2',[f.companyA,original])).rows).toEqual([]);
});
it.each(['absent','partial','generation','lease','tenant'] as const)('refuses %s builder lineage under actual application role',async mode=>{
 const overrides={absent:{jobId:null,generation:null,leaseId:null},partial:{generation:null},generation:{generation:comparison.generation+1},lease:{leaseId:randomUUID()},tenant:{companyId:f.companyB}};
 await expect(worker(comparison,async ctx=>{await header(ctx,comparison,overrides[mode]);})).rejects.toMatchObject({code:'42501'});
});
it('refuses a genuine snapshot worker publishing an unrelated original snapshot',async()=>{
 await expect(worker(snapshot,async ctx=>{await header(ctx,snapshot);})).rejects.toMatchObject({code:'42501'});
});
it.each(['expired','replaced','completed'] as const)('refuses headers after the issued builder becomes %s inside its transaction',async mode=>{
 await expect(worker(comparison,async ctx=>{
  await invalidate(ctx,mode);await header(ctx,comparison);
 })).rejects.toMatchObject({code:'42501'});
});
async function invalidate(ctx:ControlTx,mode:'expired'|'replaced'|'completed'){
 if(mode==='expired')await ctx.sql`UPDATE control_audit_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE company_id=${f.companyA}::uuid AND job_id=${comparison.jobId}::uuid`;
 else if(mode==='replaced')await ctx.sql`UPDATE control_audit_jobs SET generation=generation+1,lease_id=${randomUUID()}::uuid WHERE company_id=${f.companyA}::uuid AND job_id=${comparison.jobId}::uuid`;
 else await ctx.sql`UPDATE control_audit_jobs SET state='failed',lease_id=NULL,lease_expires_at=NULL,completed_at=clock_timestamp() WHERE company_id=${f.companyA}::uuid AND job_id=${comparison.jobId}::uuid`;
}
it.each(['item','chunk'] as const)('refuses %s append after completing the parent builder',async kind=>{
 await expect(worker(comparison,async ctx=>{
  await header(ctx,comparison);
  if(kind==='chunk')await ctx.sql`INSERT INTO control_audit_snapshot_index_items(company_id,snapshot_id,section,ordinal,protected_item) VALUES(${f.companyA}::uuid,${original}::uuid,'records',0,'{}')`;
  await invalidate(ctx,'completed');
  if(kind==='item')await ctx.sql`INSERT INTO control_audit_snapshot_index_items(company_id,snapshot_id,section,ordinal,protected_item) VALUES(${f.companyA}::uuid,${original}::uuid,'records',0,'{}')`;
  else await ctx.sql`INSERT INTO control_audit_snapshot_index_chunks(company_id,snapshot_id,section,ordinal,chunk_ordinal,protected_chunk) VALUES(${f.companyA}::uuid,${original}::uuid,'records',0,0,'{}')`;
 })).rejects.toMatchObject({code:'42501'});
});

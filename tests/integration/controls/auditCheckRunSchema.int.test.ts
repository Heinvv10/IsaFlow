import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {AUDIT_JOB_KINDS,AUDIT_WORKER_CLASS_KINDS} from '@/modules/accounting/services/controls/auditJobContract';
import {enqueueAuditSnapshot} from '@/modules/accounting/services/controls/auditJobService';
import {enqueueAuditCheckRuns} from '@/modules/accounting/services/controls/auditCheckRunJobService';
import {claimAuditJob,type AuditJobLease} from '@/modules/accounting/services/controls/auditJobLease';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
let fixture:ForensicFixture;
beforeAll(async()=>{fixture=await provisionForensicFixture(config);});
afterAll(()=>pool.end());
type Person='u1'|'u2'|'u3';
async function asMember<T>(person:Person,work:(client:PoolClient)=>Promise<T>,commit=false):Promise<T>{
 const user=fixture[person],client=await pool.connect();
 try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify({sub:user.id,role:'authenticated',company_id:user.companyId}),user.companyId]);
  const value=await work(client);await client.query(commit?'COMMIT':'ROLLBACK');return value;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
const actor=<T>(work:()=>Promise<T>)=>asMember('u1',client=>withControlRequest({client,userId:fixture.u1.id,companyId:fixture.companyA,claims:{}},
 {personId:fixture.u1.id,companyId:fixture.companyA,authMethod:'cookie'},work),true);
async function claimedCheckRun():Promise<AuditJobLease>{
 const run=await actor(()=>enqueueAuditCheckRuns(requireControlTx(),{cutoff:'2026-09-09',checks:['journal_risk_checks'],idempotencyKey:randomUUID()}));
 const lease=await actor(()=>claimAuditJob(requireControlTx(),run.jobs[0]!.id,AUDIT_WORKER_CLASS_KINDS.check_run));if(!lease)throw new Error('Synthetic check-run claim failed');return lease;
}
const header=JSON.stringify({sealed:'synthetic'});
function insertResult(client:PoolClient,lease:Pick<AuditJobLease,'companyId'|'jobId'|'generation'|'leaseId'>,status='pass',findingCount=0){
 return client.query(`INSERT INTO control_audit_check_results(company_id,job_id,generation,lease_id,check_id,status,population_count,excluded_count,finding_count,
  snapshot_text,capture_xid,captured_at,protected_header) VALUES($1,$2,$3,$4,'journal_risk_checks',$5,0,0,$6,pg_current_snapshot()::text,pg_current_xact_id()::text,clock_timestamp(),$7::jsonb)`,
 [lease.companyId,lease.jobId,lease.generation,lease.leaseId,status,findingCount,header]);
}
function insertFinding(client:PoolClient,lease:Pick<AuditJobLease,'companyId'|'jobId'|'generation'|'leaseId'>){
 return client.query(`INSERT INTO control_audit_check_findings(company_id,job_id,generation,lease_id,ordinal,finding_key,protected_item)
  VALUES($1,$2,$3,$4,0,$5,$6::jsonb)`,[lease.companyId,lease.jobId,lease.generation,lease.leaseId,'a'.repeat(64),header]);
}
it('shared constraints name every job kind in the contract and every result column in the table',async()=>{
 const definition=async(table:string,name:string)=>(await pool.query('SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid=to_regclass($1) AND conname=$2',[table,name])).rows[0]?.def as string;
 const kinds=await definition('control_audit_job_intents','control_audit_job_intents_kind_check');
 for(const kind of AUDIT_JOB_KINDS)expect(kinds,`kind check omits ${kind}`).toContain(`'${kind}'`);
 const columns=(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='control_audit_jobs' AND column_name LIKE 'result\\_%\\_id' ORDER BY 1")).rows.map(row=>row.column_name as string);
 expect(columns).toEqual(['result_check_run_id','result_comparison_id','result_export_id','result_snapshot_id']);
 const results=await definition('control_audit_jobs','control_audit_jobs_result_check');
 for(const column of columns)expect(results,`result check omits ${column}`).toContain(column);
});
it('grants only the new result column and keeps check-run material append-only under forced RLS',async()=>{
 expect((await pool.query("SELECT has_column_privilege('app_user','control_audit_jobs','result_check_run_id','UPDATE') AS granted")).rows[0].granted).toBe(true);
 for(const table of ['control_audit_check_results','control_audit_check_findings']){
  expect((await pool.query("SELECT has_table_privilege('app_user',$1,'SELECT') AS read,has_table_privilege('app_user',$1,'INSERT') AS create,has_table_privilege('app_user',$1,'UPDATE') AS update,has_table_privilege('app_user',$1,'DELETE') AS delete",[table])).rows[0]).toEqual({read:true,create:true,update:false,delete:false});
  expect((await pool.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=to_regclass($1)',[table])).rows[0]).toEqual({relrowsecurity:true,relforcerowsecurity:true});
 }
 const money=(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name IN('control_audit_check_results','control_audit_check_findings') AND column_name ~ '(amount|total|currency|entity)'")).rows;
 expect(money).toEqual([]);
});
it('accepts result and finding rows only from the live lease of a running check-run job',async()=>{
 const lease=await claimedCheckRun();
 await asMember('u1',async client=>{await insertResult(client,lease);await insertFinding(client,lease);});
 for(const forged of [{...lease,leaseId:randomUUID()},{...lease,generation:lease.generation+1}])
  for(const insert of [insertResult,insertFinding])await expect(asMember('u1',client=>insert(client,forged))).rejects.toMatchObject({code:'42501'});
 for(const insert of [insertResult,insertFinding])await expect(asMember('u2',client=>insert(client,lease))).rejects.toMatchObject({code:'42501'});
 await pool.query("UPDATE control_audit_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE company_id=$1 AND job_id=$2",[lease.companyId,lease.jobId]);
 for(const insert of [insertResult,insertFinding])await expect(asMember('u1',client=>insert(client,lease))).rejects.toMatchObject({code:'42501'});
});
it('refuses check-run rows written under the lease of a snapshot-kind job',async()=>{
 const job=await actor(()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));
 const lease=await actor(()=>claimAuditJob(requireControlTx(),job.id,AUDIT_WORKER_CLASS_KINDS.audit));expect(lease).not.toBeNull();
 for(const insert of [insertResult,insertFinding])await expect(asMember('u1',client=>insert(client,lease!))).rejects.toMatchObject({code:'42501'});
});
it('an unknown result carries no findings and success needs the matching generation-bound result row',async()=>{
 const lease=await claimedCheckRun();
 await expect(asMember('u1',client=>insertResult(client,lease,'unknown',1))).rejects.toMatchObject({code:'23514'});
 await asMember('u1',client=>insertResult(client,lease,'unknown',0));
 const succeed=(resultId:string)=>asMember('u1',client=>client.query(`UPDATE control_audit_jobs SET state='succeeded',result_check_run_id=$3,lease_id=NULL,lease_expires_at=NULL,
  completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE company_id=$1 AND job_id=$2`,[lease.companyId,lease.jobId,resultId]));
 await expect(succeed(lease.jobId)).rejects.toMatchObject({code:'23503'});
 await expect(succeed(randomUUID())).rejects.toMatchObject({code:'23514'});
 await asMember('u1',async client=>{await insertResult(client,lease);
  await client.query(`UPDATE control_audit_jobs SET state='succeeded',result_check_run_id=job_id,lease_id=NULL,lease_expires_at=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE company_id=$1 AND job_id=$2`,[lease.companyId,lease.jobId]);
  await expect(client.query('UPDATE control_audit_jobs SET result_snapshot_id=job_id WHERE company_id=$1 AND job_id=$2',[lease.companyId,lease.jobId])).rejects.toMatchObject({code:'23514'});
 });
});

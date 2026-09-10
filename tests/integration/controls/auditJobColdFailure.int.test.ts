import {afterAll,beforeAll,expect,it} from 'vitest';
import {AUDIT_WORKER_CLASS_KINDS} from '@/modules/accounting/services/controls/auditJobContract';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {als,type RequestContext} from '@/lib/als';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,withControlJobRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot} from '@/modules/accounting/services/controls/auditJobService';
import {claimAuditJob,failAuditJobForWorker,type AuditJobLease} from '@/modules/accounting/services/controls/auditJobLease';
import {openProtectedChange,protectChangeValues} from '@/modules/accounting/services/controls/changeProtection';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});
let fixture:ForensicFixture;
beforeAll(async()=>{fixture=await provisionForensicFixture(config);});
afterAll(()=>pool.end());
async function transaction<T>(fn:(store:RequestContext)=>Promise<T>,person:'u1'|'u2'|'u3'='u1',rollback=false){
 const user=fixture[person],client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  const claims={sub:user.id,role:'authenticated',company_id:user.companyId};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
  const result=await fn({client,userId:user.id,companyId:user.companyId,claims});
  await client.query(rollback?'ROLLBACK':'COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function leased(){
 await pool.query("UPDATE personal_access_tokens SET revoked_at=NULL,scopes=ARRAY['read:reports'] WHERE company_id=$1 AND user_id=$2 AND id=$3",[fixture.companyA,fixture.u1.id,fixture.u1.tokens[0]!.id]);
 return transaction(store=>withControlRequest(store,{personId:store.userId,companyId:store.companyId!,authMethod:'pat',connectionId:fixture.u1.tokens[0]!.id,grantId:fixture.u1.tokens[0]!.id,grantedScopes:['read:reports']},async()=>{
  const job=await enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()});
  const lease=await claimAuditJob(requireControlTx(),job.id,AUDIT_WORKER_CLASS_KINDS.audit);expect(lease).not.toBeNull();return lease!;
 }));
}
async function state(lease:AuditJobLease){return(await pool.query('SELECT state,last_error_code,lease_id FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[lease.companyId,lease.jobId])).rows[0];}
it('commits sanitized failure after revoked PAT prevents the actual work context',async()=>{
 const lease=await leased();
 await pool.query('UPDATE personal_access_tokens SET revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2 AND id=$3',[fixture.companyA,fixture.u1.id,fixture.u1.tokens[0]!.id]);
 await expect(transaction(store=>withControlJobRequest(store,lease,async()=>undefined))).rejects.toThrow(/permissions/);
 await transaction(store=>failAuditJobForWorker(store,lease,'AUTHORITY_REVOKED',false));
 expect(await state(lease)).toMatchObject({state:'failed',last_error_code:'AUTHORITY_REVOKED',lease_id:null});
});
it('records failure after signed delegation expiry without constructing a principal',async()=>{
 const lease=await leased();
 const row=(await pool.query('SELECT protected_request FROM control_audit_job_intents WHERE company_id=$1 AND id=$2',[lease.companyId,lease.jobId])).rows[0];
 const saved=openProtectedChange(row.protected_request).after!;
 const expired=protectChangeValues('audit_job',null,{...saved,delegationExpiresAt:'2000-01-01T00:00:00.000Z'}).protectedPayload;
 await pool.query('UPDATE control_audit_job_intents SET protected_request=$1::jsonb WHERE company_id=$2 AND id=$3',[JSON.stringify(expired),lease.companyId,lease.jobId]);
 await expect(transaction(store=>withControlJobRequest(store,lease,async()=>undefined))).rejects.toThrow(/delegation expired/);
 await transaction(store=>failAuditJobForWorker(store,lease,'AUTHORITY_REVOKED',false));
 expect((await state(lease)).state).toBe('failed');
});
it('rejects copied leases, another person and another tenant',async()=>{
 const lease=await leased();
 await expect(transaction(store=>failAuditJobForWorker(store,{...lease},'WORKER_ERROR',false))).rejects.toThrow(/lease/);
 for(const person of ['u2','u3'] as const)await expect(transaction(store=>failAuditJobForWorker(store,lease,'WORKER_ERROR',false),person)).rejects.toThrow(/lease/);
 expect((await state(lease)).state).toBe('running');
});
it('rejects active ALS and a principal on the supplied store',async()=>{
 const lease=await leased();
 await expect(transaction(store=>als.run(store,()=>failAuditJobForWorker(store,lease,'WORKER_ERROR',false)))).rejects.toThrow(/cold/);
 await expect(transaction(store=>withControlRequest(store,{personId:store.userId,companyId:store.companyId!,authMethod:'cookie'},async()=>{
  const principal=requireControlTx().principal;
  return als.exit(()=>failAuditJobForWorker({...store,controlPrincipal:principal},lease,'WORKER_ERROR',false));
 }))).rejects.toThrow(/cold/);
});
it('refuses expired and replaced leases without overwriting queue state',async()=>{
 const lease=await leased();
 await pool.query("UPDATE control_audit_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE company_id=$1 AND job_id=$2",[lease.companyId,lease.jobId]);
 await expect(transaction(store=>failAuditJobForWorker(store,lease,'WORKER_ERROR',false))).rejects.toThrow(/expired|replaced/);
 await pool.query("UPDATE control_audit_jobs SET lease_expires_at=clock_timestamp()+interval '1 minute',lease_id=$3,generation=generation+1 WHERE company_id=$1 AND job_id=$2",[lease.companyId,lease.jobId,randomUUID()]);
 await expect(transaction(store=>failAuditJobForWorker(store,lease,'WORKER_ERROR',false))).rejects.toThrow(/expired|replaced/);
 expect((await state(lease)).last_error_code).toBeNull();
});
it('rolls back failure metadata and preserves retry behavior when committed',async()=>{
 const lease=await leased();
 await transaction(store=>failAuditJobForWorker(store,lease,'SOURCE_UNAVAILABLE',true),'u1',true);
 expect(await state(lease)).toMatchObject({state:'running',last_error_code:null,lease_id:lease.leaseId});
 await transaction(store=>failAuditJobForWorker(store,lease,'SOURCE_UNAVAILABLE',true));
 expect(await state(lease)).toMatchObject({state:'queued',last_error_code:'SOURCE_UNAVAILABLE',lease_id:null});
});

it('records explicit cancellation separately from a runtime resource limit',async()=>{
 const lease=await leased();
 await transaction(store=>failAuditJobForWorker(store,lease,'CANCELLED',false));
 expect(await state(lease)).toMatchObject({state:'failed',last_error_code:'CANCELLED',lease_id:null});
});

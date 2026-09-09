import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {withControlRequest,withControlJobRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot,getAuditJob} from '@/modules/accounting/services/controls/auditJobService';
import {enqueueAuditExport} from '@/modules/accounting/services/controls/auditExportJobService';
import {runAuditSnapshotJob} from '@/modules/accounting/services/controls/auditJobRunner';
import {claimAuditJob,type AuditJobLease} from '@/modules/accounting/services/controls/auditJobLease';
import {openAuditJobRequest} from '@/modules/accounting/services/controls/auditJobProtection';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
let fixture:ForensicFixture,snapshotId:string;
const sharedKey=randomUUID();
function actor<T>(fn:()=>Promise<T>,person:'u1'|'u2'|'u3'='u1',pat=false){
 const user=fixture[person];return withAuditWorkerTransaction(pool,{companyId:user.companyId,personId:user.id,jobId:randomUUID()},'read committed',Date.now()+10000,undefined,
 store=>withControlRequest(store,{companyId:user.companyId,personId:user.id,authMethod:pat?'pat':'cookie',...(pat?{connectionId:user.tokens[0]!.id,grantId:user.tokens[0]!.id,grantedScopes:['read:reports','read:payroll']}: {})},fn));
}
function work<T>(lease:AuditJobLease,fn:()=>Promise<T>){return withAuditWorkerTransaction(pool,{companyId:fixture.companyA,personId:fixture.u1.id,jobId:lease.jobId},'read committed',Date.now()+10000,undefined,store=>withControlJobRequest(store,lease,fn));}
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);
 await pool.query("UPDATE personal_access_tokens SET scopes=ARRAY['read:reports','read:payroll'] WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u1.id]);
 const job=await actor(()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals','payroll'],checks:[],idempotencyKey:sharedKey}));
 snapshotId=job.id;expect(await runAuditSnapshotJob({companyId:fixture.companyA,personId:fixture.u1.id,jobId:job.id},{pool})).toMatchObject({state:'succeeded'});
 // A foreground enqueue/status must never decrypt the complete retained representation.
 await pool.query("UPDATE control_audit_snapshots SET protected_snapshot='{}' WHERE company_id=$1 AND id=$2",[fixture.companyA,snapshotId]);
});
afterAll(()=>pool.end());
it('enqueues one metadata-only export with authenticated source permissions and per-kind retry identity',async()=>{
 const input={snapshotId,idempotencyKey:sharedKey};
 const jobs=await Promise.all([actor(()=>enqueueAuditExport(requireControlTx(),input)),actor(()=>enqueueAuditExport(requireControlTx(),input))]);
 expect(jobs[0]).toEqual(jobs[1]);expect(jobs[0]).toMatchObject({kind:'audit_export',state:'queued',attempts:0,resultExportId:null});
 expect(await actor(()=>getAuditJob(requireControlTx(),jobs[0]!.id))).toEqual(jobs[0]);
 const rows=(await pool.query('SELECT * FROM control_audit_job_intents WHERE company_id=$1 AND idempotency_key=$2 ORDER BY kind',[fixture.companyA,sharedKey])).rows;
 expect(rows.map(row=>row.kind)).toEqual(['audit_export','audit_snapshot']);
 expect(openAuditJobRequest(rows[0])).toMatchObject({kind:'audit_export',request:{snapshotId,permissions:['read:payroll','read:reports']}});
 expect((await pool.query('SELECT attempts,state FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[fixture.companyA,jobs[0]!.id])).rows[0]).toEqual({attempts:0,state:'queued'});
});
it('refuses foreign snapshots and caller-chosen authority or canonical hashes without enqueue effects',async()=>{
 const input={snapshotId,idempotencyKey:randomUUID()};
 for(const extra of [{companyId:fixture.companyA},{canonicalSnapshotHash:'a'.repeat(64)},{permissions:['read:reports']}])await expect(actor(()=>enqueueAuditExport(requireControlTx(),{...input,...extra}))).rejects.toThrow();
 await expect(actor(()=>enqueueAuditExport(requireControlTx(),input),'u3')).rejects.toThrow(/unavailable/);
 expect((await pool.query('SELECT id FROM control_audit_job_intents WHERE company_id=$1 AND idempotency_key=$2',[fixture.companyA,input.idempotencyKey])).rows).toEqual([]);
});
it('rolls back enqueue and denies revoked source reads before retry/status',async()=>{
 const key=randomUUID();await expect(actor(async()=>{await enqueueAuditExport(requireControlTx(),{snapshotId,idempotencyKey:key});throw new Error('Synthetic enqueue rollback');})).rejects.toThrow('Synthetic enqueue rollback');
 expect((await pool.query('SELECT id FROM control_audit_job_intents WHERE company_id=$1 AND idempotency_key=$2',[fixture.companyA,key])).rows).toEqual([]);
 const job=await actor(()=>enqueueAuditExport(requireControlTx(),{snapshotId,idempotencyKey:key}));
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'payroll',false)",[fixture.companyA,fixture.u1.id]);
 try{await expect(actor(()=>enqueueAuditExport(requireControlTx(),{snapshotId,idempotencyKey:key}))).rejects.toThrow();await expect(actor(()=>getAuditJob(requireControlTx(),job.id))).rejects.toThrow();}
 finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[fixture.companyA,fixture.u1.id]);}
});
it('retains original PAT delegation and refuses a revoked token at actual worker context bootstrap',async()=>{
 const job=await actor(()=>enqueueAuditExport(requireControlTx(),{snapshotId,idempotencyKey:randomUUID()}),'u1',true);
 const lease=await actor(()=>claimAuditJob(requireControlTx(),job.id));expect(lease).not.toBeNull();
 await work(lease!,async()=>{expect(requireControlTx().principal.authMethod).toBe('job');await assertEffectivePermission(requireControlTx(),'read:payroll');});
 await pool.query('UPDATE personal_access_tokens SET revoked_at=clock_timestamp() WHERE company_id=$1 AND id=$2',[fixture.companyA,fixture.u1.tokens[0]!.id]);
 let called=false;
 try{await expect(work(lease!,async()=>{called=true;})).rejects.toThrow();expect(called).toBe(false);}
 finally{await pool.query('UPDATE personal_access_tokens SET revoked_at=NULL WHERE company_id=$1 AND id=$2',[fixture.companyA,fixture.u1.tokens[0]!.id]);}
});

import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot,getAuditJob} from '@/modules/accounting/services/controls/auditJobService';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});
let fixture:ForensicFixture;
beforeAll(async()=>{fixture=await provisionForensicFixture(config);});
afterAll(()=>pool.end());
async function actor<T>(fn:()=>Promise<T>,person:'u1'|'u2'|'u3'='u1',rollback=false){
 const user=fixture[person],client=await pool.connect();
 try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify({sub:user.id,role:'authenticated',company_id:user.companyId}),user.companyId]);
  const value=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims:{}},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},fn);
  await client.query(rollback?'ROLLBACK':'COMMIT');return value;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
const request=()=>({cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()});
it('enqueues once without processing and refuses a changed request under the same key',async()=>{
 const input=request();
 const [first,second]=await Promise.all([actor(()=>enqueueAuditSnapshot(requireControlTx(),input)),actor(()=>enqueueAuditSnapshot(requireControlTx(),input))]);
 expect(first).toEqual(second);expect(first.state).toBe('queued');expect(first.attempts).toBe(0);
 await expect(actor(()=>enqueueAuditSnapshot(requireControlTx(),{...input,cutoff:'2026-09-08'}))).rejects.toThrow(/Idempotency/);
 expect((await pool.query('SELECT count(*)::int AS count FROM control_audit_job_intents WHERE company_id=$1 AND idempotency_key=$2',[fixture.companyA,input.idempotencyKey])).rows[0].count).toBe(1);
 expect(await actor(()=>getAuditJob(requireControlTx(),first.id))).toEqual(first);
});
it('keeps foreign people and tenants out of job status and never starts work on a read',async()=>{
 const job=await actor(()=>enqueueAuditSnapshot(requireControlTx(),request()));
 for(const person of ['u2','u3'] as const)await expect(actor(()=>getAuditJob(requireControlTx(),job.id),person)).rejects.toThrow(/not found/);
 expect((await pool.query('SELECT state,attempts FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[fixture.companyA,job.id])).rows[0]).toEqual({state:'queued',attempts:0});
});
it('rolls back request and queue together without an orphan intent',async()=>{
 const input=request();const job=await actor(()=>enqueueAuditSnapshot(requireControlTx(),input),'u1',true);
 expect((await pool.query('SELECT id FROM control_audit_job_intents WHERE company_id=$1 AND id=$2',[fixture.companyA,job.id])).rows).toHaveLength(0);
 expect((await pool.query('SELECT job_id FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[fixture.companyA,job.id])).rows).toHaveLength(0);
});
it('rechecks current permissions before enqueue and before returning saved status',async()=>{
 const job=await actor(()=>enqueueAuditSnapshot(requireControlTx(),request()));
 await pool.query("UPDATE users u SET is_active=false FROM company_users cu WHERE cu.company_id=$1 AND cu.user_id=u.id AND u.id=$2",[fixture.companyA,fixture.u1.id]);
 try{
  await expect(actor(()=>enqueueAuditSnapshot(requireControlTx(),request()))).rejects.toThrow(/permissions/);
  await expect(actor(()=>getAuditJob(requireControlTx(),job.id))).rejects.toThrow(/permissions/);
 }finally{await pool.query("UPDATE users u SET is_active=true FROM company_users cu WHERE cu.company_id=$1 AND cu.user_id=u.id AND u.id=$2",[fixture.companyA,fixture.u1.id]);}
});

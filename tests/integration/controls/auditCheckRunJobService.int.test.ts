import {afterAll,beforeAll,expect,it} from 'vitest';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture,type FixtureUser} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot,getAuditJob} from '@/modules/accounting/services/controls/auditJobService';
import {enqueueAuditCheckRuns} from '@/modules/accounting/services/controls/auditCheckRunJobService';
import {auditCheckRunGroupId} from '@/modules/accounting/services/controls/auditCheckRunContract';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:3});
let fixture:ForensicFixture;
beforeAll(async()=>{fixture=await provisionForensicFixture(config);});
afterAll(()=>pool.end());
async function actor<T>(user:FixtureUser,work:()=>Promise<T>,rollback=false):Promise<T>{
 const client=await pool.connect();
 try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify({sub:user.id,role:'authenticated',company_id:user.companyId}),user.companyId]);
  const value=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims:{}},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},work);
  await client.query(rollback?'ROLLBACK':'COMMIT');return value;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
const request=(idempotencyKey:string=randomUUID())=>({cutoff:'2026-09-09',checks:['journal_risk_checks'],idempotencyKey});
const enqueue=(user:FixtureUser,input:unknown)=>actor(user,()=>enqueueAuditCheckRuns(requireControlTx(),input));
it('writes one queued intent per check under the derived key and never starts work',async()=>{
 const input=request(),run=await enqueue(fixture.u1,input);
 expect(run.runGroupId).toBe(auditCheckRunGroupId(fixture.companyA,fixture.u1.id,input.idempotencyKey));
 expect(run.jobs).toHaveLength(1);
 expect(run.jobs[0]).toMatchObject({kind:'audit_check_run',checkId:'journal_risk_checks',runGroupId:run.runGroupId,state:'queued',attempts:0,resultCheckRunId:null});
 expect((await pool.query('SELECT kind,idempotency_key FROM control_audit_job_intents WHERE company_id=$1 AND id=$2',[fixture.companyA,run.jobs[0]!.id])).rows)
  .toEqual([{kind:'audit_check_run',idempotency_key:`${input.idempotencyKey}:journal_risk_checks`}]);
 expect(await actor(fixture.u1,()=>getAuditJob(requireControlTx(),run.jobs[0]!.id))).toEqual(run.jobs[0]);
 for(const other of [fixture.u2,fixture.u3])await expect(actor(other,()=>getAuditJob(requireControlTx(),run.jobs[0]!.id))).rejects.toThrow(/not found/);
});
it('returns the same jobs for concurrent and later repeats and refuses a different request under the key',async()=>{
 const input=request();
 const [first,second]=await Promise.all([enqueue(fixture.u1,input),enqueue(fixture.u1,input)]);
 expect(second).toEqual(first);expect(await enqueue(fixture.u1,input)).toEqual(first);
 for(const changed of [{cutoff:'2026-09-08'}])await expect(enqueue(fixture.u1,{...input,...changed})).rejects.toThrow(/Idempotency key already binds a different audit request/);
 expect((await pool.query("SELECT count(*)::int AS count FROM control_audit_job_intents WHERE company_id=$1 AND kind='audit_check_run' AND idempotency_key LIKE $2",
  [fixture.companyA,`${input.idempotencyKey}:%`])).rows[0].count).toBe(1);
 const other=await enqueue(fixture.u2,input);expect(other.jobs[0]!.id).not.toBe(first.jobs[0]!.id);
});
it('a repeat waiting on an uncommitted first enqueue returns its jobs instead of colliding',async()=>{
 const input=request();let release:()=>void=()=>undefined;const held=new Promise<void>(resolve=>{release=resolve;});
 const first=actor(fixture.u1,async()=>{const run=await enqueueAuditCheckRuns(requireControlTx(),input);await held;return run;});
 await new Promise(resolve=>setTimeout(resolve,300));
 const second=enqueue(fixture.u1,input);
 await new Promise(resolve=>setTimeout(resolve,300));release();
 const [a,b]=await Promise.all([first,second]);expect(b).toEqual(a);
});
it('serialises the quota across different members so an uncommitted enqueue counts',async()=>{
 const fresh=await provisionForensicFixture(config);
 for(let n=0;n<5;n++)await enqueue(fresh.u1,request());
 let release:()=>void=()=>undefined;const held=new Promise<void>(resolve=>{release=resolve;});
 const sixth=actor(fresh.u1,async()=>{const run=await enqueueAuditCheckRuns(requireControlTx(),request());await held;return run;});
 await new Promise(resolve=>setTimeout(resolve,300));
 const seventh=enqueue(fresh.u2,request()).then(()=>'enqueued',(error:Error)=>error.message);
 await new Promise(resolve=>setTimeout(resolve,300));release();
 expect((await sixth).jobs).toHaveLength(1);expect(await seventh).toMatch(/Audit check-run quota exceeded/);
});
it('rolls back intents and queue rows together',async()=>{
 const run=await actor(fixture.u1,()=>enqueueAuditCheckRuns(requireControlTx(),request()),true);
 expect((await pool.query('SELECT id FROM control_audit_job_intents WHERE company_id=$1 AND id=$2',[fixture.companyA,run.jobs[0]!.id])).rows).toEqual([]);
 expect((await pool.query('SELECT job_id FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[fixture.companyA,run.jobs[0]!.id])).rows).toEqual([]);
});
it('rechecks read:reports before writing any intent',async()=>{
 const input=request();
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'reports',false)",[fixture.companyA,fixture.u1.id]);
 try{await expect(enqueue(fixture.u1,input)).rejects.toThrow(/permissions/);}
 finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='reports'",[fixture.companyA,fixture.u1.id]);}
 expect((await pool.query('SELECT id FROM control_audit_job_intents WHERE company_id=$1 AND idempotency_key LIKE $2',[fixture.companyA,`${input.idempotencyKey}:%`])).rows).toEqual([]);
});
it('refuses a seventh active check-run job per company while a repeat still returns its jobs',async()=>{
 const keys=Array.from({length:6},()=>randomUUID()),runs=[];
 for(const key of keys)runs.push(await enqueue(fixture.u3,request(key)));
 await expect(enqueue(fixture.u3,request())).rejects.toThrow(/Audit check-run quota exceeded/);
 // Authority is decided before the quota is consulted, so a revoked member learns nothing about company usage.
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'reports',false)",[fixture.companyB,fixture.u3.id]);
 try{await expect(enqueue(fixture.u3,request())).rejects.toThrow(/permissions/);}
 finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='reports'",[fixture.companyB,fixture.u3.id]);}
 expect(await enqueue(fixture.u3,request(keys[0]))).toEqual(runs[0]);
 await pool.query("UPDATE control_audit_jobs SET state='failed',last_error_code='CANCELLED',completed_at=clock_timestamp() WHERE company_id=$1 AND job_id=$2",[fixture.companyB,runs[0]!.jobs[0]!.id]);
 expect((await enqueue(fixture.u3,request())).jobs[0]!.state).toBe('queued');
});
/** Seeds `count` published check runs enqueued `hoursAgo` hours ago, as the rolling window sees them. */
async function publishedRuns(company:string,person:string,count:number,hoursAgo:number){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const ids=(await client.query(`INSERT INTO control_audit_job_intents(company_id,id,requester_person_id,kind,idempotency_key,request_hash,protected_request,created_at)
   SELECT $1,gen_random_uuid(),$2,'audit_check_run','seed-'||$4||'-'||n,$3,'{"seed":true}'::jsonb,clock_timestamp()-make_interval(hours=>$4::int)
   FROM generate_series(1,$5::int) n RETURNING id`,[company,person,createHash('sha256').update('seed').digest('hex'),hoursAgo,count])).rows.map(row=>row.id as string);
  await client.query("INSERT INTO control_audit_jobs(company_id,job_id,generation) SELECT $1,unnest($2::uuid[]),1",[company,ids]);
  await client.query(`INSERT INTO control_audit_check_results(company_id,job_id,generation,lease_id,check_id,status,population_count,excluded_count,finding_count,snapshot_text,capture_xid,captured_at,protected_header)
   SELECT $1,job_id,1,gen_random_uuid(),'journal_risk_checks','unknown',0,0,0,pg_current_snapshot()::text,pg_current_xact_id()::text,clock_timestamp(),'{"seed":true}'::jsonb
   FROM control_audit_jobs WHERE company_id=$1 AND job_id=ANY($2::uuid[])`,[company,ids]);
  await client.query("UPDATE control_audit_jobs SET state='succeeded',result_check_run_id=job_id,completed_at=clock_timestamp() WHERE company_id=$1 AND job_id=ANY($2::uuid[])",[company,ids]);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
// Literal on purpose: the unit contract test pins AUDIT_CHECK_RUN_QUOTA to these, so this gate cannot drift with it.
const PER_WINDOW=100,WINDOW_HOURS=24;
it('bounds the enqueue rate over a rolling window and never locks a tenant out for good',async()=>{
 // 100 published runs — every one of them `unknown`, the outcome that must not count against a tenant forever —
 // enqueued a day and an hour ago: outside the window, so new work is admitted.
 const old=await provisionForensicFixture(config);
 await publishedRuns(old.companyA,old.u1.id,PER_WINDOW,WINDOW_HOURS+1);
 expect((await enqueue(old.u1,request())).jobs[0]!.state,'runs outside the window still refused new work').toBe('queued');
 // The same volume inside the window is refused, and refusing is the whole of it: no intent is written.
 const recent=await provisionForensicFixture(config);
 await publishedRuns(recent.companyA,recent.u1.id,PER_WINDOW,1);
 await expect(enqueue(recent.u1,request())).rejects.toThrow(/Audit check-run quota exceeded/);
 expect((await pool.query("SELECT count(*)::int AS n FROM control_audit_job_intents WHERE company_id=$1 AND kind='audit_check_run'",[recent.companyA])).rows[0].n)
  .toBe(PER_WINDOW);
});
it('requires write:audit to enqueue, while reads and job status stay on read:reports',async()=>{
 const tenant=await provisionForensicFixture(config);
 const queued=await enqueue(tenant.u2,request());
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read,can_write) VALUES($1,$2,'audit',true,false)",[tenant.companyA,tenant.u2.id]);
 try{
  await expect(enqueue(tenant.u2,request()),'a member without write:audit enqueued a check run').rejects.toMatchObject({name:'EffectivePermissionError'});
  expect(await actor(tenant.u2,()=>getAuditJob(requireControlTx(),queued.jobs[0]!.id))).toMatchObject({kind:'audit_check_run',state:'queued'});
 }finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='audit'",[tenant.companyA,tenant.u2.id]);}
});
it('status refuses a job whose published result column belongs to another kind',async()=>{
 const snapshot=await actor(fixture.u1,()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));
 await pool.query(`INSERT INTO control_audit_check_results(company_id,job_id,generation,lease_id,check_id,status,population_count,excluded_count,finding_count,snapshot_text,capture_xid,captured_at,protected_header)
  VALUES($1,$2,1,gen_random_uuid(),'journal_risk_checks','pass',0,0,0,pg_current_snapshot()::text,pg_current_xact_id()::text,clock_timestamp(),'{"seed":true}'::jsonb)`,[fixture.companyA,snapshot.id]);
 await pool.query("UPDATE control_audit_jobs SET state='succeeded',generation=1,result_check_run_id=job_id,completed_at=clock_timestamp() WHERE company_id=$1 AND job_id=$2",[fixture.companyA,snapshot.id]);
 await expect(actor(fixture.u1,()=>getAuditJob(requireControlTx(),snapshot.id))).rejects.toThrow(/Audit job result kind changed/);
});

import {runAuditJob} from '@/modules/accounting/services/controls/auditJobRunner';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot,getAuditJob} from '@/modules/accounting/services/controls/auditJobService';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {createAuditJobPoller} from '@/modules/accounting/services/controls/auditJobPoller';
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:3});
let fixture:ForensicFixture;
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY='synthetic-poller-signing-key-outside-database';
beforeAll(async()=>{fixture=await provisionForensicFixture(config);});afterAll(()=>pool.end());
async function actor<T>(person:'u1'|'u2'|'u3',action:()=>Promise<T>){
 const user=fixture[person];
 return withAuditWorkerTransaction(pool,{companyId:user.companyId,personId:user.id,jobId:randomUUID()},'read committed',Date.now()+10000,undefined,store=>
  withControlRequest(store,{companyId:user.companyId,personId:user.id,authMethod:'cookie'},action));
}
const enqueue=(person:'u1'|'u2'|'u3')=>actor(person,()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));
it('polls actual queued jobs, skips revoked oldest authority, and publishes only configured-tenant work',async()=>{
 const bad=await enqueue('u2'),good=await enqueue('u1'),foreign=await enqueue('u3');
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read,can_write) VALUES($1,$2,'reports',false,false)",[fixture.companyA,fixture.u2.id]);
 try{
  await actor('u1',()=>getAuditJob(requireControlTx(),good.id));
  expect((await pool.query('SELECT state FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[fixture.companyA,good.id])).rows[0].state).toBe('queued');
  const poller=createAuditJobPoller({companyIds:[fixture.companyA],batchSize:1},{pool,executeJob:(identity,options)=>runAuditJob(identity,{pool,...options})});
  const first=await poller.pollOnce();expect(first.attempted).toBe(1);expect(first.results[0]?.state).toBe('failed');
  const second=await poller.pollOnce();expect(second.results[0]).toMatchObject({state:'succeeded',snapshotId:good.id});
  expect((await pool.query('SELECT id FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[fixture.companyA,good.id])).rows).toHaveLength(1);
  expect((await pool.query('SELECT state,attempts FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[fixture.companyB,foreign.id])).rows[0]).toEqual({state:'queued',attempts:0});
  expect((await pool.query('SELECT state,attempts FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[fixture.companyA,bad.id])).rows[0]).toEqual({state:'queued',attempts:0});
  // End-of-keyset resets; previously unclaimable work can recover after fresh authority is restored.
  expect((await poller.pollOnce()).attempted).toBe(0);
  await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='reports'",[fixture.companyA,fixture.u2.id]);
  expect((await poller.pollOnce()).results[0]).toMatchObject({state:'succeeded',snapshotId:bad.id});
 }finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='reports'",[fixture.companyA,fixture.u2.id]);}
});

it('runs the executable once-mode CLI against only the explicitly validated synthetic database',async()=>{
 const job=await enqueue('u1');
 const result=await promisify(execFile)('bun',['scripts/forensic/run-audit-worker.ts','--company',fixture.companyA,'--once'],{
  cwd:process.cwd(),env:{...process.env,ISAFLOW_AUDIT_WORKER_DATABASE_URL:validateFixtureTarget(config).connectionString,
   ISAFLOW_AUDIT_WORKER_NODE_PATH:process.execPath,ISAFLOW_AUDIT_WORKER_ENTRY_PATH:process.env.ISAFLOW_FORENSIC_AUDIT_ARTIFACT},timeout:15000,maxBuffer:65536,
 });
 expect(result.stdout+result.stderr).toContain('Audit queue worker stopped');
 expect((await pool.query('SELECT state FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[fixture.companyA,job.id])).rows[0].state).toBe('succeeded');
});

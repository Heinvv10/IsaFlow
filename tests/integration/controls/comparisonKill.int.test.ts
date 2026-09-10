import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {comparisonDispatchFixture} from './comparisonDispatchFixture';
import {killOwnedComparisonWorker} from './comparisonKillFixture';
let f:Awaited<ReturnType<typeof comparisonDispatchFixture>>;
beforeAll(async()=>{f=await comparisonDispatchFixture();});afterAll(async()=>{await f?.close();});
it('hard-killed indexless conversion rolls back and a fresh process reclaims the expired lease exactly once',async()=>{
 const id=await f.snapshot(),before=await f.original(id);await f.removeCompanion(id,true);
 const job=await f.enqueue(id),name=`comparison_kill_${randomUUID().replaceAll('-','')}`,lock=424244;
 const blocker=await f.pool.connect(),controller=new AbortController();
 let work:ReturnType<typeof f.runner.runIsolatedAuditJob>|undefined;
 try{
  await f.pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id::text=TG_ARGV[0] AND NEW.snapshot_id::text=TG_ARGV[1] THEN PERFORM pg_advisory_xact_lock(TG_ARGV[2]::bigint); END IF; RETURN NEW; END $$`);
  // AFTER INSERT holds an actual uncommitted index row before the process is killed.
  await f.pool.query(`CREATE TRIGGER ${name} AFTER INSERT ON control_audit_snapshot_indexes FOR EACH ROW EXECUTE FUNCTION ${name}('${f.f.companyA}','${id}','${lock}')`);
  await blocker.query('SELECT pg_advisory_lock($1)',[lock]);
  work=f.runner.runIsolatedAuditJob(f.identity(job.id),{signal:controller.signal});
  let waiting=false;
  for(let n=0;n<150&&!waiting;n++){
   waiting=(await f.pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event='advisory'",[`isaflow-audit:${job.id}`])).rowCount===1;
   if(!waiting)await new Promise(resolve=>setTimeout(resolve,50));
  }
  expect(waiting).toBe(true);
  const claimed=(await f.pool.query('SELECT state,generation,lease_id,attempts FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[f.f.companyA,job.id])).rows[0];
  expect(claimed).toMatchObject({state:'running',generation:'1',attempts:1});
  const unit=await killOwnedComparisonWorker(process.env.ISAFLOW_FORENSIC_AUDIT_ARTIFACT!);
  const killed=await work;expect(killed.observation.unitName).toBe(unit);
  expect(killed.result).toMatchObject({state:'failed',failureRecorded:false});
  await blocker.query('SELECT pg_advisory_unlock($1)',[lock]);
  // Allow PostgreSQL to notice the dead connection and finish rollback after releasing the trigger lock.
  for(let n=0;n<100;n++){
   if((await f.pool.query('SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1',[`isaflow-audit:${job.id}`])).rowCount===0)break;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  for(const table of ['control_audit_snapshot_indexes','control_audit_comparison_sources'])expect((await f.pool.query(`SELECT snapshot_id FROM ${table} WHERE company_id=$1 AND snapshot_id=$2`,[f.f.companyA,id])).rows).toEqual([]);
  expect((await f.pool.query('SELECT job_id FROM control_audit_comparison_results WHERE company_id=$1 AND job_id=$2',[f.f.companyA,job.id])).rows).toEqual([]);
  expect((await f.runner.runIsolatedAuditJob(f.identity(job.id))).result).toEqual({state:'not_claimed'});
  await f.pool.query("UPDATE control_audit_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE company_id=$1 AND job_id=$2",[f.f.companyA,job.id]);
  const retry=await f.runner.runIsolatedAuditJob(f.identity(job.id));
  expect(retry.result,JSON.stringify(retry)).toMatchObject({state:'succeeded',comparisonId:job.id});
  const row=(await f.pool.query('SELECT build_job_id,build_generation,build_lease_id FROM control_audit_snapshot_indexes WHERE company_id=$1 AND snapshot_id=$2',[f.f.companyA,id])).rows[0];
  expect(row).toMatchObject({build_job_id:job.id,build_generation:'2'});expect(row.build_lease_id).not.toBe(claimed.lease_id);
  expect((await f.pool.query('SELECT state,generation,attempts FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[f.f.companyA,job.id])).rows).toEqual([{state:'succeeded',generation:'2',attempts:2}]);
  expect((await f.pool.query('SELECT job_id FROM control_audit_comparison_results WHERE company_id=$1 AND job_id=$2',[f.f.companyA,job.id])).rows).toEqual([{job_id:job.id}]);
  expect(await f.original(id)).toEqual(before);
  expect((await f.runner.runIsolatedAuditJob(f.identity(job.id))).result).toEqual({state:'not_claimed'});
 }finally{
  controller.abort();await blocker.query('SELECT pg_advisory_unlock($1)',[lock]);blocker.release();if(work)await Promise.allSettled([work]);
  await f.pool.query(`DROP TRIGGER IF EXISTS ${name} ON control_audit_snapshot_indexes`);await f.pool.query(`DROP FUNCTION IF EXISTS ${name}()`);
 }
},60000);

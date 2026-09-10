import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {comparisonDispatchFixture} from './comparisonDispatchFixture';
import {auditSystemctl} from '@/modules/accounting/services/controls/auditJobSystemd';
let f:Awaited<ReturnType<typeof comparisonDispatchFixture>>;
beforeAll(async()=>{f=await comparisonDispatchFixture();});afterAll(async()=>{await f?.close();});
it('actual cold process dispatches authenticated comparison and publishes one result with immutable originals',async()=>{
 const first=await f.snapshot();
 await f.pool.query("INSERT INTO gl_journal_entries(company_id,entry_date,source,status,created_by) VALUES($1,'2026-09-09','manual','draft',$2)",[f.f.companyA,f.f.u1.id]);
 const second=await f.snapshot(),before=await Promise.all([f.original(first),f.original(second)]),job=await f.enqueue(first,second);
 const value=await f.runner.runIsolatedAuditJob(f.identity(job.id));expect(value.result,JSON.stringify(value)).toMatchObject({state:'succeeded',comparisonId:job.id});
 expect(value.observation.memoryPeakBytes).toBeGreaterThan(0);expect(await auditSystemctl(['show',value.observation.unitName,'--property=LoadState'])).toContain('not-found');
 expect((await f.pool.query('SELECT state,result_comparison_id,attempts FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[f.f.companyA,job.id])).rows).toEqual([{state:'succeeded',result_comparison_id:job.id,attempts:1}]);
 expect((await f.pool.query("SELECT section,position FROM control_audit_comparison_items WHERE company_id=$1 AND job_id=$2",[f.f.companyA,job.id])).rows).toEqual([{section:'records',position:0}]);
 expect(await Promise.all([f.original(first),f.original(second)])).toEqual(before);
 expect((await f.runner.runIsolatedAuditJob(f.identity(job.id))).result).toEqual({state:'not_claimed'});
},30000);
it('two cold comparison jobs concurrently convert one legacy companion and retry without rewriting its original',async()=>{
 const id=await f.snapshot(),before=await f.original(id);await f.removeCompanion(id);
 const jobs=await Promise.all([f.enqueue(id),f.enqueue(id)]),name=`comparison_pause_${randomUUID().replaceAll('-','')}`,lock=424242;
 const blocker=await f.pool.connect(),controller=new AbortController();
 let work:Promise<Awaited<ReturnType<typeof f.runner.runIsolatedAuditJob>>>[]=[];
 try{
  await f.pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id::text=TG_ARGV[0] AND NEW.snapshot_id::text=TG_ARGV[1] THEN PERFORM pg_advisory_xact_lock(TG_ARGV[2]::bigint); END IF; RETURN NEW; END $$`);
  await f.pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON control_audit_comparison_sources FOR EACH ROW EXECUTE FUNCTION ${name}('${f.f.companyA}','${id}','${lock}')`);
  await blocker.query('SELECT pg_advisory_lock($1)',[lock]);
  work=jobs.map(job=>f.runner.runIsolatedAuditJob(f.identity(job.id),{signal:controller.signal}));
  let waiting=0;
  for(let n=0;n<150&&waiting<2;n++){
   waiting=Number((await f.pool.query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name=ANY($1::text[]) AND wait_event='advisory'",[jobs.map(job=>`isaflow-audit:${job.id}`)])).rows[0].count);
   if(waiting<2)await new Promise(resolve=>setTimeout(resolve,50));
  }
  expect(waiting).toBe(2);await blocker.query('SELECT pg_advisory_unlock($1)',[lock]);
  const results=await Promise.all(work);expect(results.filter(r=>r.result.state==='succeeded')).toHaveLength(1);
  expect(results.filter(r=>r.result.state==='failed')).toHaveLength(1);
  const rows=(await f.pool.query('SELECT job_id,state,attempts FROM control_audit_jobs WHERE company_id=$1 AND job_id=ANY($2::uuid[])',[f.f.companyA,jobs.map(j=>j.id)])).rows;
  const retry=rows.find(row=>row.state==='queued');expect(retry).toBeDefined();
  expect((await f.runner.runIsolatedAuditJob(f.identity(retry.job_id))).result).toMatchObject({state:'succeeded',comparisonId:retry.job_id});
  expect((await f.pool.query('SELECT snapshot_id FROM control_audit_comparison_sources WHERE company_id=$1 AND snapshot_id=$2',[f.f.companyA,id])).rows).toHaveLength(1);
  expect((await f.pool.query('SELECT job_id FROM control_audit_comparison_results WHERE company_id=$1 AND job_id=ANY($2::uuid[])',[f.f.companyA,jobs.map(j=>j.id)])).rows).toHaveLength(2);
  expect(await f.original(id)).toEqual(before);
 }finally{
  controller.abort();await blocker.query('SELECT pg_advisory_unlock($1)',[lock]);blocker.release();await Promise.allSettled(work);
  await f.pool.query(`DROP TRIGGER IF EXISTS ${name} ON control_audit_comparison_sources`);await f.pool.query(`DROP FUNCTION IF EXISTS ${name}()`);
 }
},45000);
it('legacy original lacking both its old index and companion can enter the background comparison workflow',async()=>{
 const id=await f.snapshot(),before=await f.original(id);await f.removeCompanion(id,true);
 try{
  const job=await f.enqueue(id);expect(job).toMatchObject({state:'queued',kind:'audit_compare'});
  expect((await f.pool.query('SELECT snapshot_id FROM control_audit_snapshot_indexes WHERE company_id=$1 AND snapshot_id=$2',[f.f.companyA,id])).rows).toEqual([]);
  const result=await f.runner.runIsolatedAuditJob(f.identity(job.id));
  expect(result.result,JSON.stringify(result)).toMatchObject({state:'succeeded',comparisonId:job.id});
  expect(result.observation.memoryPeakBytes).toBeGreaterThan(0);
  expect((await f.pool.query('SELECT build_job_id,build_generation FROM control_audit_snapshot_indexes WHERE company_id=$1 AND snapshot_id=$2',[f.f.companyA,id])).rows).toEqual([{build_job_id:job.id,build_generation:'1'}]);
  expect((await f.pool.query('SELECT job_id FROM control_audit_comparison_results WHERE company_id=$1 AND job_id=$2',[f.f.companyA,job.id])).rows).toEqual([{job_id:job.id}]);
  expect((await f.runner.runIsolatedAuditJob(f.identity(job.id))).result).toEqual({state:'not_claimed'});
 }
 finally{expect(await f.original(id)).toEqual(before);}
},30000);

it('two actual cold processes convert reversed indexless pairs with ordered locks and complete each result once',async()=>{
 const first=await f.snapshot();
 await f.pool.query("INSERT INTO gl_journal_entries(company_id,entry_date,source,status,created_by) VALUES($1,'2026-09-09','manual','draft',$2)",[f.f.companyA,f.f.u1.id]);
 const second=await f.snapshot(),ids=[first,second],before=await Promise.all(ids.map(f.original));
 for(const id of ids)await f.removeCompanion(id,true);
 const jobs=await Promise.all([f.enqueue(first,second),f.enqueue(second,first)]),jobIds=jobs.map(job=>job.id);
 const name=`indexless_pause_${randomUUID().replaceAll('-','')}`,lock=424243;
 const blocker=await f.pool.connect(),controller=new AbortController();
 let work:Promise<Awaited<ReturnType<typeof f.runner.runIsolatedAuditJob>>>[]=[];
 try{
  await f.pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id::text=TG_ARGV[0] THEN PERFORM pg_advisory_xact_lock(TG_ARGV[1]::bigint); END IF; RETURN NEW; END $$`);
  await f.pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON control_audit_snapshot_indexes FOR EACH ROW EXECUTE FUNCTION ${name}('${f.f.companyA}','${lock}')`);
  await blocker.query('SELECT pg_advisory_lock($1)',[lock]);
  work=jobs.map(job=>f.runner.runIsolatedAuditJob(f.identity(job.id),{signal:controller.signal}));
  let waiting=0;
  for(let n=0;n<150&&waiting<2;n++){
   waiting=Number((await f.pool.query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name=ANY($1::text[]) AND wait_event='advisory'",[jobIds.map(id=>`isaflow-audit:${id}`)])).rows[0].count);
   if(waiting<2)await new Promise(resolve=>setTimeout(resolve,50));
  }
  // One process is inside the index INSERT trigger; the other waits for the same ordered source lock.
  expect(waiting).toBe(2);
  expect((await f.pool.query('SELECT snapshot_id FROM control_audit_snapshot_indexes WHERE company_id=$1 AND snapshot_id=ANY($2::uuid[])',[f.f.companyA,ids])).rows).toEqual([]);
  await blocker.query('SELECT pg_advisory_unlock($1)',[lock]);
  const results=await Promise.all(work);
  expect(results.some(result=>result.result.state==='succeeded')).toBe(true);
  for(const job of jobs){
   const row=(await f.pool.query('SELECT state,last_error_code FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[f.f.companyA,job.id])).rows[0];
   if(row.state==='queued')expect((await f.runner.runIsolatedAuditJob(f.identity(job.id))).result).toMatchObject({state:'succeeded',comparisonId:job.id});
   else expect(row.state,JSON.stringify(row)).toBe('succeeded');
  }
  const indexes=(await f.pool.query('SELECT snapshot_id,build_job_id,build_generation,build_lease_id FROM control_audit_snapshot_indexes WHERE company_id=$1 AND snapshot_id=ANY($2::uuid[])',[f.f.companyA,ids])).rows;
  expect(indexes.map(row=>row.snapshot_id).sort()).toEqual([...ids].sort());
  expect(new Set(indexes.map(row=>row.build_job_id)).size).toBe(1);
  for(const row of indexes){expect(jobIds).toContain(row.build_job_id);expect(Number(row.build_generation)).toBeGreaterThan(0);expect(row.build_lease_id).toMatch(/^[a-f0-9-]{36}$/);}
  expect((await f.pool.query('SELECT snapshot_id FROM control_audit_comparison_sources WHERE company_id=$1 AND snapshot_id=ANY($2::uuid[])',[f.f.companyA,ids])).rows).toHaveLength(2);
  expect((await f.pool.query('SELECT job_id FROM control_audit_comparison_results WHERE company_id=$1 AND job_id=ANY($2::uuid[])',[f.f.companyA,jobIds])).rows.map(row=>row.job_id).sort()).toEqual([...jobIds].sort());
  expect((await f.pool.query("SELECT job_id,section,position FROM control_audit_comparison_items WHERE company_id=$1 AND job_id=ANY($2::uuid[])",[f.f.companyA,jobIds])).rows).toHaveLength(2);
  expect(await Promise.all(ids.map(f.original))).toEqual(before);
  for(const job of jobs)expect((await f.runner.runIsolatedAuditJob(f.identity(job.id))).result).toEqual({state:'not_claimed'});
 }finally{
  controller.abort();await blocker.query('SELECT pg_advisory_unlock($1)',[lock]);blocker.release();await Promise.allSettled(work);
  await f.pool.query(`DROP TRIGGER IF EXISTS ${name} ON control_audit_snapshot_indexes`);await f.pool.query(`DROP FUNCTION IF EXISTS ${name}()`);
 }
},60000);

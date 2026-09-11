import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {authorityLockFixture,type Timed} from './authorityLockFixture';
import {runAuditSnapshotJob} from '@/modules/accounting/services/controls/auditJobRunner';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot} from '@/modules/accounting/services/controls/auditJobService';
import {readRetainedAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotPublication';
let x:Awaited<ReturnType<typeof authorityLockFixture>>;
beforeAll(async()=>{x=await authorityLockFixture();},60000);
afterAll(async()=>{if(x)await x.close();});
const person=(who:'u1'|'u2')=>({companyId:x.f.companyA,personId:x.f[who].id,authMethod:'cookie' as const});
async function asCookie<T>(who:'u1'|'u2',action:()=>Promise<T>){
 return withAuditWorkerTransaction(x.pool,{companyId:x.f.companyA,personId:x.f[who].id,jobId:randomUUID()},'read committed',Date.now()+15000,undefined,
  store=>withControlRequest(store,person(who),action));
}
const ok=(label:string,row:PromiseSettledResult<Timed>)=>{
 expect(row.status,`${label} did not complete`).toBe('fulfilled');
 const value=(row as PromiseFulfilledResult<Timed>).value;
 expect(value.status,`${label}: ${JSON.stringify(value.body)}`).toBe(200);
 expect(value.ms,`${label} waited behind the audit job`).toBeLessThan(1000);
 return value;
};

it('serves same-company reads, writes, MCP calls and an authority write while an audit job sits in its work transaction',async()=>{
 const job=await asCookie('u1',()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));
 await x.holdPublication();
 const run=runAuditSnapshotJob({companyId:x.f.companyA,personId:x.f.u1.id,jobId:job.id},{pool:x.pool});
 try{
  const worker=await x.pausedWorker();
  const rows=await Promise.allSettled([
   x.rest('GET','/api/accounting/control-approvals',{},'u1'),
   x.rest('GET','/api/accounting/control-approvals',{},'u2'),
   x.rest('POST','/api/accounting/audit-check-runs',{cutoff:'2026-09-09',checks:['journal_risk_checks'],idempotencyKey:randomUUID()},'u2'),
   x.mcp('company_profile',{},'u1'),
   x.mcp('company_profile',{},'u2'),
   // An administrator narrows the job principal's own authority (the rows the job's check read) while it runs.
   x.rest('POST','/api/accounting/permissions',{userId:x.f.u1.id,moduleKey:'audit',canRead:true,canWrite:false},'u2'),
  ]);
  const labels=['REST read (job principal)','REST read (other person)','REST controlled write','MCP read (job principal)','MCP read (other person)','REST authority write'];
  const measured=rows.map((row,i)=>`${labels[i]}: ${row.status==='fulfilled'?`${row.value.status} in ${row.value.ms} ms`:'no reply within 12 s'}`).join('; ');
  rows.forEach((row,i)=>ok(`${labels[i]!} [${measured}]`,row));
  for(const i of [3,4])expect(JSON.stringify((rows[i] as PromiseFulfilledResult<Timed>).value.body)).not.toContain('"isError":true');
  // A revocation of the permission the job itself needs also commits at once.
  const started=Date.now();
  await x.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'reports',false)",[x.f.companyA,x.f.u1.id]);
  expect(Date.now()-started).toBeLessThan(1000);
  // The paused work transaction holds no company authority lock at all.
  expect(await x.authorityLocks(worker)).toEqual([]);
 }finally{await x.release();}
 try{
  // The job runs under the authority valid when it started; every reader of its output re-authorises.
  expect(await run).toMatchObject({state:'succeeded',snapshotId:job.id});
  await expect(asCookie('u1',()=>readRetainedAuditSnapshot(requireControlTx(),job.id))).rejects.toThrow(/permission/i);
  expect(await asCookie('u2',()=>readRetainedAuditSnapshot(requireControlTx(),job.id))).toMatchObject({snapshot:expect.anything()});
 }finally{await x.pool.query('DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2',[x.f.companyA,x.f.u1.id]);}
},60000);

it('lets two same-company readers hold the company authority lock at once',async()=>{
 let entered=0,resume!:()=>void;const both=new Promise<void>(resolve=>{resume=resolve;});
 const hold=(who:'u1'|'u2')=>asCookie(who,async()=>{
  const {resolveEffectivePermissions}=await import('@/lib/auth/effectivePermissions');
  await resolveEffectivePermissions(requireControlTx());if(++entered===2)resume();await both;
 });
 const readers=[hold('u1'),hold('u2')];
 try{
  await Promise.race([both,new Promise((_,reject)=>setTimeout(()=>reject(new Error('The second reader queued behind the first')),6000))]);
  const locks=await x.authorityLocks();
  expect(locks.filter(l=>l.granted).map(l=>l.mode)).toEqual(['ShareLock','ShareLock']);
 }finally{resume();await Promise.allSettled(readers);}
 for(const reader of readers)await expect(reader).resolves.toBeUndefined();
},20000);

it('still serialises an authority change against a check and the action it authorises',async()=>{
 let checked!:()=>void,resume!:()=>void;const ready=new Promise<void>(r=>{checked=r;}),proceed=new Promise<void>(r=>{resume=r;});
 const reader=asCookie('u1',async()=>{
  const {assertEffectivePermission}=await import('@/lib/auth/effectivePermissions');
  await assertEffectivePermission(requireControlTx(),'read:reports');checked();await proceed;
  // The action the check authorised, in the same transaction: nothing may have changed underneath it.
  await assertEffectivePermission(requireControlTx(),'read:reports');
 });
 const writer=await x.pool.connect();
 try{
  await ready;
  // Each writer shape the checked authority depends on: a new narrowing override, a role change, a suspension.
  for(const statement of [
   ["INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'reports',false)",[x.f.companyA,x.f.u1.id]],
   ["UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2",[x.f.companyA,x.f.u1.id]],
   ["UPDATE users SET is_active=false WHERE id=$1",[x.f.u1.id]],
  ] as const){
   await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='500ms'");
   await expect(writer.query(statement[0],[...statement[1]]),statement[0]).rejects.toMatchObject({code:'55P03'});
   await writer.query('ROLLBACK');
  }
  resume();await expect(reader).resolves.toBeUndefined();
  // Once the reader has committed, the same change lands immediately.
  await writer.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'reports',false)",[x.f.companyA,x.f.u1.id]);
 }finally{resume();await Promise.allSettled([reader]);writer.release();
  await x.pool.query('DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2',[x.f.companyA,x.f.u1.id]);}
},20000);

it('bounds the wait for a held company authority lock and answers 503 with a retry hint',async()=>{
 const holder=await x.pool.connect();
 try{
  await holder.query('BEGIN');
  await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('control-authority:'||$1::text,0))",[x.f.companyA]);
  const [restRead,mcpRead]=await Promise.all([x.rest('GET','/api/accounting/control-approvals',{},'u2'),x.mcp('company_profile',{},'u2')]);
  for(const [label,row] of [['REST',restRead],['MCP',mcpRead]] as const){
   expect(row.status,`${label}: ${JSON.stringify(row.body)}`).toBe(503);
   expect(row.retryAfter,label).toMatch(/^\d+$/);
   expect(row.ms,label).toBeGreaterThanOrEqual(4500);expect(row.ms,label).toBeLessThan(9000);
  }
 }finally{await holder.query('ROLLBACK');holder.release();}
 // Nothing was left pinned: the next read is served at once.
 const after=await x.rest('GET','/api/accounting/control-approvals',{},'u2');
 expect(after.status).toBe(200);expect(after.ms).toBeLessThan(1000);
},30000);

it('bounds every database function that takes the company authority key',async()=>{
 const rows=(await x.pool.query(`SELECT p.oid::regprocedure::text AS fn,p.prosrc,p.proconfig FROM pg_proc p
  WHERE p.prosrc LIKE '%control-authority:%' ORDER BY 1`)).rows as {fn:string;prosrc:string;proconfig:string[]|null}[];
 expect(rows.map(r=>r.fn)).toEqual(['control_approval_authorities(uuid,uuid)','control_beneficiary_authorities(uuid,uuid)',
  'control_exception_owner(uuid,text)','control_lock_permission_principal(uuid,text)']);
 for(const row of rows){
  expect(row.proconfig,row.fn).toContain('lock_timeout=5s');
  expect(row.prosrc,row.fn).toContain("pg_advisory_xact_lock_shared(hashtextextended('control-authority:'");
  expect(row.prosrc.replaceAll('pg_advisory_xact_lock_shared',''),row.fn).not.toContain('pg_advisory_xact_lock');
 }
});

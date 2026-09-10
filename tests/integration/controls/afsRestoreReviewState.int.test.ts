import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {platformImportApprovalFixture} from './platformImportApprovalFixture';
import {restoreVersion,saveVersion} from '@/modules/accounting/services/afs/afsVersionHistoryService';

/**
 * A restore replaces a section's content. It must never RAISE the section's review status -
 * that was a way for anyone who could save a version, the preparer included, to turn a
 * pending mandatory section into 'reviewed' and unblock submission and partner review.
 */
describe('AFS version restore and review state: actual PostgreSQL',()=>{
 let h:Awaited<ReturnType<typeof platformImportApprovalFixture>>;
 beforeAll(async()=>{h=await platformImportApprovalFixture();},30000);
 afterAll(async()=>{await h?.close();});
 async function section(status:string){
  const document=randomUUID(),id=randomUUID();
  await h.pool.query(`INSERT INTO afs_documents(id,company_id,document_type,reporting_framework,status) VALUES($1,$2,'afs','ifrs_smes','draft')`,[document,h.f.companyA]);
  await h.pool.query(`INSERT INTO afs_sections(id,document_id,company_id,section_type,status,content,reviewed_by)
   VALUES($1,$2,$3,'notes',$4,'{"title":"Notes","blocks":[]}'::jsonb,$5)`,[id,document,h.f.companyA,status,status==='pending'?null:h.f.u1.id]);
  return id;
 }
 const read=async(id:string)=>(await h.pool.query('SELECT status,version_history FROM afs_sections WHERE company_id=$1 AND id=$2',[h.f.companyA,id])).rows[0];
 const as=<T>(fn:()=>Promise<T>,impersonator:string|null=null)=>h.member(h.f.u2.id,()=>fn(),false,impersonator);

 it('never turns a pending section into a reviewed one',async()=>{
  const id=await section('pending');
  await as(()=>saveVersion(h.f.companyA,id,h.f.u2.id));
  await as(()=>restoreVersion(h.f.companyA,id,1,h.f.u2.id));
  expect((await read(id)).status).toBe('pending');
 });

 it.each(['reviewed','signed_off'])('drops a %s section back to pending and records that the restore invalidated the review',async status=>{
  const id=await section(status);
  // Seed the history directly: saveVersion itself demotes signed_off to reviewed (a
  // separate, pre-existing behaviour), which would hide the signed_off case.
  await h.pool.query(`UPDATE afs_sections SET version_history=jsonb_build_array(jsonb_build_object('version',1,
   'savedAt','2024-03-01T00:00:00.000Z','savedBy',$3::text,'content','{"title":"Notes","blocks":[]}'::jsonb))
   WHERE company_id=$1 AND id=$2`,[h.f.companyA,id,h.f.u1.id]);
  await as(()=>restoreVersion(h.f.companyA,id,1,h.f.u2.id));
  const row=await read(id);
  expect(row.status).toBe('pending');
  expect(JSON.stringify(row.version_history)).toContain(`invalidated the section's prior ${status} review`);
 });

 it('decides invalidation on the committed status when a review lands during the restore',async()=>{
  const id=await section('pending');
  await as(()=>saveVersion(h.f.companyA,id,h.f.u2.id));
  // A reviewer's UPDATE is in flight and holds the row; the restore starts while the
  // section still reads 'pending' to anyone not waiting for that lock.
  const reviewer=await h.pool.connect();
  let restore:Promise<unknown>|undefined;
  try{
   await reviewer.query('BEGIN');
   await reviewer.query("UPDATE afs_sections SET status='reviewed',reviewed_by=$3 WHERE company_id=$1 AND id=$2",[h.f.companyA,id,h.f.u1.id]);
   const reviewerPid=(await reviewer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
   restore=as(()=>restoreVersion(h.f.companyA,id,1,h.f.u2.id));
   // Commit only once the restore's backend is actually blocked behind the reviewer's row
   // lock - never on a timer, which under load could commit before the restore reads.
   const deadline=Date.now()+15000;
   while((await h.pool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[reviewerPid])).rows[0].n===0){
    if(Date.now()>deadline)throw new Error('restore never blocked behind the reviewer lock');
    await new Promise(resolve=>setTimeout(resolve,20));
   }
   await reviewer.query('COMMIT');
  }finally{reviewer.release();}
  await restore;
  // The review committed first, so it covered the old content: the restore must drop it and
  // say so, not carry 'reviewed' onto content nobody reviewed.
  const row=await read(id);
  expect(row.status).toBe('pending');
  expect(JSON.stringify(row.version_history)).toContain("invalidated the section's prior reviewed review");
 });

 it('refuses an impersonated restore that would change review state, and allows one that would not',async()=>{
  const reviewed=await section('reviewed');
  await as(()=>saveVersion(h.f.companyA,reviewed,h.f.u2.id));
  await expect(as(()=>restoreVersion(h.f.companyA,reviewed,1,h.f.u2.id),h.admin))
   .rejects.toThrow('An impersonated session cannot record an independent review');
  expect((await read(reviewed)).status).not.toBe('pending');
  const pending=await section('pending');
  await as(()=>saveVersion(h.f.companyA,pending,h.f.u2.id));
  await expect(as(()=>restoreVersion(h.f.companyA,pending,1,h.f.u2.id),h.admin)).resolves.toBeTruthy();
  expect((await read(pending)).status).toBe('pending');
 });
});

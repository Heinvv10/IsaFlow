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
  await as(()=>saveVersion(h.f.companyA,id,h.f.u2.id));
  await as(()=>restoreVersion(h.f.companyA,id,1,h.f.u2.id));
  const row=await read(id);
  expect(row.status).toBe('pending');
  expect(JSON.stringify(row.version_history)).toContain(`invalidated the section's prior ${status} review`);
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

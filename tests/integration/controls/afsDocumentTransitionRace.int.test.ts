import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {platformImportApprovalFixture} from './platformImportApprovalFixture';
import {sql} from '@/lib/neon';
import {lockSectionForWrite,voidSectionAttestation} from '@/modules/accounting/services/afs/afsSectionAttestation';
import {promoteToPartnerReview,signOffDocument,submitDocumentForReview} from '@/modules/accounting/services/afs/afsReviewService';

/**
 * A document transition decides on its sections. A content write in flight when the transition
 * starts must either finish first and be seen, or wait until the transition commits and then be
 * refused - never finish unseen, leaving a signed-off (locked) document holding content nobody
 * attested. The interleaving is forced, not slept on: the transition is started while a writer
 * holds its locks, and the writer commits only once Postgres reports the transition blocked.
 */
describe('AFS document transitions against an in-flight section write: actual PostgreSQL',()=>{
 let h:Awaited<ReturnType<typeof platformImportApprovalFixture>>;
 beforeAll(async()=>{h=await platformImportApprovalFixture();},30000);
 afterAll(async()=>{await h?.close();});
 async function documentWith(docStatus:string,sectionStatus:string){
  const doc=randomUUID(),section=randomUUID();
  await h.pool.query(`INSERT INTO afs_documents(id,company_id,document_type,reporting_framework,status) VALUES($1,$2,'afs','ifrs_smes',$3)`,[doc,h.f.companyA,docStatus]);
  await h.pool.query(`INSERT INTO afs_sections(id,document_id,company_id,section_type,status,content,reviewed_by,signed_off_by)
   VALUES($1,$2,$3,'synthetic_race',$4,'{"title":"Attested","blocks":[]}'::jsonb,$5,$6)`,[section,doc,h.f.companyA,sectionStatus,h.f.u2.id,sectionStatus==='signed_off'?h.f.u2.id:null]);
  return{doc,section};
 }
 const transitions:[string,string,string,(doc:string)=>Promise<unknown>,string][]=[
  ['sign-off','partner_review','signed_off',doc=>signOffDocument(h.f.companyA,doc,h.f.u2.id),'not yet signed off'],
  ['submission','draft','reviewed',doc=>submitDocumentForReview(h.f.companyA,doc,h.f.u2.id),'not yet reviewed'],
  ['promotion','in_review','reviewed',doc=>promoteToPartnerReview(h.f.companyA,doc,h.f.u2.id),'not yet reviewed'],
 ];
 it.each(transitions)('%s waits for the write and then sees the voided review',async(_name,docStatus,sectionStatus,transition,refusal)=>{
  const {doc,section}=await documentWith(docStatus,sectionStatus);
  let release!:()=>void;const released=new Promise<void>(done=>{release=done;});
  let holding!:()=>void;const held=new Promise<void>(done=>{holding=done;});
  // The preparer's overrides PUT, stopped after it has voided the review but before it commits.
  const writer=h.member(h.f.u1.id,async()=>{
   const locked=await lockSectionForWrite(h.f.companyA,doc,section);
   await voidSectionAttestation(h.f.companyA,locked,h.f.u1.id,'Section overrides changed');
   await sql`UPDATE afs_sections SET overrides='{"title":"Unattested","blocks":[]}'::jsonb WHERE company_id=${h.f.companyA}::UUID AND id=${section}::UUID`;
   holding();await released;
  });
  let run:Promise<unknown>|undefined;
  try{
   await held;
   let announce!:(pid:number)=>void;const started=new Promise<number>(done=>{announce=done;});
   run=h.member(h.f.u2.id,async()=>{
    const rows=await sql`SELECT pg_backend_pid() AS pid` as {pid:number}[];announce(rows[0]!.pid);
    return transition(doc);
   });
   run.catch(()=>undefined);
   const pid=await started;let blocked=false;
   for(let attempt=0;attempt<200&&!blocked;attempt++){
    blocked=(await h.pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0].blocked;
    if(!blocked)await new Promise(done=>setTimeout(done,10));
   }
   expect(blocked,'the transition never waited on the in-flight write').toBe(true);
  }finally{release();await writer;}
  await expect(run,'the transition passed on a review the write had voided').rejects.toThrow(refusal);
  const status=(await h.pool.query('SELECT status FROM afs_documents WHERE company_id=$1 AND id=$2',[h.f.companyA,doc])).rows[0].status;
  expect(status).toBe(docStatus);
 });
});

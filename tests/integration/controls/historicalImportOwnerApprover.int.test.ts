import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {platformImportApprovalFixture} from './platformImportApprovalFixture';
import {gl39Fixture} from './gl39Fixture';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';

/**
 * Hein, 2026-09-11: a tenant 'owner' as well as an 'admin' may approve a historical
 * import. Still a second person, cookie session only, never impersonated, never the
 * preparing platform admin — and no other operation's approver role widens.
 */
describe('owner-or-admin approver for historical imports: actual PostgreSQL',()=>{
 let h:Awaited<ReturnType<typeof platformImportApprovalFixture>>;
 let g:Awaited<ReturnType<typeof gl39Fixture>>;
 beforeAll(async()=>{h=await platformImportApprovalFixture();g=await gl39Fixture();},60000);
 afterAll(async()=>{await h?.close();await g?.close();});
 async function asRole<T>(company:string,user:string,role:string,fn:()=>Promise<T>):Promise<T>{
  const before=(await h.pool.query('SELECT role FROM company_users WHERE company_id=$1 AND user_id=$2',[company,user])).rows[0]?.role;
  await h.pool.query('UPDATE company_users SET role=$3 WHERE company_id=$1 AND user_id=$2',[company,user,role]);
  try{return await fn();}finally{await h.pool.query('UPDATE company_users SET role=$3 WHERE company_id=$1 AND user_id=$2',[company,user,before]);}
 }

 it('lets a tenant owner approve a platform import, which then posts',async()=>{
  const p=await h.prepared(),approval=await h.request(p.ref);
  await asRole(h.f.companyA,h.f.u2.id,'owner',()=>h.review(approval.id));
  const effect=await h.execute(p.ref,approval.id);
  expect(effect).toMatchObject({importId:p.ref.entityId,kind:'customer_invoice',amount:'1150'});
  expect(await h.noEffects(p.ref)).toEqual({journals:1,effects:1});
 });

 it.each(['admin','owner_or_admin'])('keeps a tenant rule exact: an owner cannot approve a journal reversal under a %s rule',async approverRole=>{
  const {id}=await g.journal();await g.post(id);
  const rule=randomUUID();
  // A tenant rule is never mandatory: typing the import policy's role into one must not admit owners.
  await g.pool.query("INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,approver_role) VALUES($1,$2,'Owner scope','journal_entry','amount','any',$3)",[rule,g.f.companyA,approverRole]);
  try{
   const ref={entityType:'journal_entry',entityId:id,operation:'journal.reverse' as const,reversalDate:g.today};
   const approval=await g.actor(ctx=>requestOperationApproval(ctx,ref),'u1');
   await asRole(g.f.companyA,g.f.u2.id,'owner',async()=>{
    await expect(g.actor(ctx=>decideOperationApproval(ctx,approval.id,'approved'),'u2')).rejects.toThrow('No pending policy accepts this approver role');
   });
   expect((await g.pool.query('SELECT status FROM control_operation_approvals WHERE company_id=$1 AND id=$2',[g.f.companyA,approval.id])).rows[0].status).toBe('pending');
  }finally{await g.pool.query('DELETE FROM approval_rules WHERE company_id=$1 AND id=$2',[g.f.companyA,rule]);}
 });

 it('refuses the preparing platform admin even as the tenant owner',async()=>{
  const p=await h.prepared(),approval=await h.request(p.ref);
  await h.pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')",[h.f.companyA,h.admin]);
  try{
   await expect(h.member(h.admin,ctx=>decideOperationApproval(ctx,approval.id,'approved'))).rejects.toThrow(/Self approval/i);
  }finally{await h.pool.query('DELETE FROM company_users WHERE company_id=$1 AND user_id=$2',[h.f.companyA,h.admin]);}
  expect(await h.noEffects(p.ref)).toEqual({journals:0,effects:0});
 });

 it('refuses an impersonated owner and an owner acting through a bearer token',async()=>{
  const p=await h.prepared(),approval=await h.request(p.ref);
  await asRole(h.f.companyA,h.f.u2.id,'owner',async()=>{
   await expect(h.member(h.f.u2.id,ctx=>decideOperationApproval(ctx,approval.id,'approved'),false,h.admin)).rejects.toThrow(/impersonat/i);
   await expect(h.member(h.f.u2.id,ctx=>decideOperationApproval(ctx,approval.id,'approved'),true)).rejects.toThrow('An authenticated human decision is required');
  });
  expect((await h.pool.query('SELECT status FROM control_operation_approvals WHERE company_id=$1 AND id=$2',[h.f.companyA,approval.id])).rows[0].status).toBe('pending');
 });

 it('takes the owner allowance from the company import policy, and a change voids an open request',async()=>{
  const setFlag=(value:boolean)=>h.pool.query('UPDATE control_mandatory_import_policies SET owner_may_approve=$2 WHERE company_id=$1',[h.f.companyA,value]);
  await setFlag(false);
  try{
   const p=await h.prepared(),approval=await h.request(p.ref);
   await asRole(h.f.companyA,h.f.u2.id,'owner',async()=>{
    await expect(h.review(approval.id)).rejects.toThrow('No pending policy accepts this approver role');
    // Requested while owners were excluded: allowing them now changes the bound policy, so the old request is dead.
    await setFlag(true);
    await expect(h.review(approval.id)).rejects.toThrow('Approval material changed');
   });
  }finally{await setFlag(true);}
 });

 it('stores the allowance as immutable per-company policy data, on for every company',async()=>{
  const {rows}=await h.pool.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE owner_may_approve)::int AS allowed,
   has_table_privilege('app_user','control_mandatory_import_policies','UPDATE,DELETE,TRUNCATE') AS app_mutate,
   has_table_privilege('platform_admin','control_mandatory_import_policies','UPDATE,DELETE,TRUNCATE') AS platform_mutate
   FROM control_mandatory_import_policies`);
  expect(rows[0]).toMatchObject({app_mutate:false,platform_mutate:false});
  expect(rows[0].allowed).toBe(rows[0].total);
  const migration=await readFile('scripts/migrations/sql/686_import_policy_owner_approver.sql','utf8');
  const client=await h.pool.connect();
  try{await client.query('BEGIN');await client.query(migration);await client.query(migration);}
  finally{await client.query('ROLLBACK');client.release();}
 });
});

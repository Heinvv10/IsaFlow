import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {platformImportApprovalFixture} from './platformImportApprovalFixture';
import {historicalHash,readHistoricalImportSource,storeHistoricalImportSource} from '@/modules/accounting/services/controls/historicalImportSourceService';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import {prepareHistoricalImport} from '@/modules/accounting/services/controls/historicalImportPreparation';

describe('platform historical import persisted maker and independent tenant approval: actual PostgreSQL',()=>{
 let h:Awaited<ReturnType<typeof platformImportApprovalFixture>>;
 beforeAll(async()=>{h=await platformImportApprovalFixture();},30000);
 afterAll(async()=>{await h?.close();});
 it.each(['customer_invoice','supplier_invoice'] as const)('posts exact 2023 %s once from retained bytes without maker membership',async kind=>{
  expect((await h.pool.query('SELECT company_id FROM company_users WHERE user_id=$1',[h.admin])).rows).toHaveLength(0);
  const p=await h.prepared(kind);
  expect((await h.member(h.f.u2.id,ctx=>readHistoricalImportSource(ctx,p.retained.sourceId))).bytes.equals(p.bytes)).toBe(true);
  expect(await h.noEffects(p.ref)).toEqual({journals:0,effects:0});
  await expect(h.execute(p.ref)).rejects.toThrow();
  const approval=await h.request(p.ref);await h.review(approval.id);
  const [first,second]=await Promise.all([h.execute(p.ref,approval.id),h.execute(p.ref,approval.id)]);
  expect(second).toEqual(first);expect(await h.execute(p.ref)).toEqual(first);
  expect(first).toMatchObject({importId:p.ref.entityId,kind,accountingDate:'2023-02-28',amount:'1150',currency:'ZAR'});
  const documents=await h.pool.query(kind==='customer_invoice'
   ?'SELECT subtotal::text,tax_amount::text,total_amount::text,amount_paid::text FROM customer_invoices WHERE company_id=$1 AND id=$2'
   :'SELECT subtotal::text,tax_amount::text,total_amount::text,amount_paid::text FROM supplier_invoices WHERE company_id=$1 AND id=$2',[h.f.companyA,first.documentId]);
  expect(documents.rows).toEqual([{subtotal:'1000.00',tax_amount:'150.00',total_amount:'1150.00',amount_paid:'0.00'}]);
  const journal=(await h.pool.query('SELECT status,entry_date::text,created_by::text FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[h.f.companyA,first.journalEntryId])).rows[0];
  expect(journal).toEqual({status:'posted',entry_date:'2023-02-28',created_by:h.admin});
  const totals=(await h.pool.query('SELECT SUM(debit)::text AS debit,SUM(credit)::text AS credit FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2',[h.f.companyA,first.journalEntryId])).rows[0];
  expect(Number(totals.debit)).toBe(1150);expect(Number(totals.credit)).toBe(1150);
  expect(await h.noEffects(p.ref)).toEqual({journals:1,effects:1});
  expect((await h.pool.query("SELECT status FROM fiscal_periods WHERE company_id=$1 AND start_date='2023-02-01'",[h.f.companyA])).rows[0].status).toBe('closed');
 });
 it('rejects maker self-review through a separate tenant session and another token',async()=>{
  const p=await h.prepared(),approval=await h.request(p.ref);
  await h.pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",[h.f.companyA,h.admin]);
  const token=h.f.u1.tokens[1]!;
  try{
   await expect(h.member(h.admin,ctx=>decideOperationApproval(ctx,approval.id,'approved'))).rejects.toThrow(/Self/i);
   await h.pool.query('UPDATE personal_access_tokens SET user_id=$3 WHERE company_id=$1 AND id=$2',[h.f.companyA,token.id,h.admin]);
   await expect(h.member(h.admin,ctx=>decideOperationApproval(ctx,approval.id,'approved'),true)).rejects.toThrow(/human|Self/i);
   expect(await h.noEffects(p.ref)).toEqual({journals:0,effects:0});
  }finally{
   await h.pool.query('UPDATE personal_access_tokens SET user_id=$3 WHERE company_id=$1 AND id=$2',[h.f.companyA,token.id,h.f.u1.id]);
   await h.pool.query('DELETE FROM company_users WHERE company_id=$1 AND user_id=$2',[h.f.companyA,h.admin]);
  }
 });
 it('rechecks revoked maker and reviewer before execution and receipt replay',async()=>{
  const p=await h.prepared(),approval=await h.request(p.ref);await h.review(approval.id);
  for(const afterExecution of [false,true]){
   if(afterExecution)await h.execute(p.ref,approval.id);
   try{await h.pool.query("UPDATE users SET role='viewer' WHERE id=$1",[h.admin]);await expect(h.execute(p.ref,approval.id)).rejects.toThrow();}
   finally{await h.pool.query("UPDATE users SET role='super_admin' WHERE id=$1",[h.admin]);}
   try{await h.pool.query("UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2",[h.f.companyA,h.f.u2.id]);await expect(h.execute(p.ref,approval.id)).rejects.toThrow();}
   finally{await h.pool.query("UPDATE company_users SET role='admin' WHERE company_id=$1 AND user_id=$2",[h.f.companyA,h.f.u2.id]);}
   expect(await h.noEffects(p.ref)).toEqual({journals:afterExecution?1:0,effects:afterExecution?1:0});
  }
 });
 it('invalidates approval after current account material or retained source changes',async()=>{
  const p=await h.prepared(),approval=await h.request(p.ref);await h.review(approval.id);
  try{await h.pool.query("UPDATE gl_accounts SET account_name='Changed source account' WHERE company_id=$1 AND id=$2",[h.f.companyA,h.revenue]);await expect(h.execute(p.ref,approval.id)).rejects.toThrow(/changed/i);}
  finally{await h.pool.query("UPDATE gl_accounts SET account_name='PI-R' WHERE company_id=$1 AND id=$2",[h.f.companyA,h.revenue]);}
  try{await h.pool.query('UPDATE control_historical_import_sources SET content_hash=$3 WHERE company_id=$1 AND id=$2',[h.f.companyA,p.retained.sourceId,'a'.repeat(64)]);await expect(h.execute(p.ref,approval.id)).rejects.toThrow();}
  finally{await h.pool.query('UPDATE control_historical_import_sources SET content_hash=$3 WHERE company_id=$1 AND id=$2',[h.f.companyA,p.retained.sourceId,p.retained.contentHash]);}
  expect(await h.noEffects(p.ref)).toEqual({journals:0,effects:0});
 });
 it('refuses replacing retained bytes under a different target hash',async()=>{
  const bytes=Buffer.from(JSON.stringify(h.body()));
  await expect(h.maker({action:'retain',sourceHash:historicalHash(Buffer.from('different bytes'))},ctx=>storeHistoricalImportSource(ctx,{bytes,mimeType:'application/json'}))).rejects.toThrow();
 });
 it('refuses preparing another source under a valid target selection',async()=>{
  const p=await h.prepared();const source=JSON.parse(p.bytes.toString()) as {sourceKey:string};
  await expect(h.maker({action:'prepare',sourceId:randomUUID()},ctx=>prepareHistoricalImport(ctx,{sourceSystem:'csv',sourceKey:source.sourceKey,kind:'customer_invoice',mode:'post_journal',accountingDate:'2023-02-28',evidenceId:p.retained.sourceId,sourceRecordIds:['1','2','3']}))).rejects.toThrow();
 });
 it('refuses an ordinary journal approval through the target-bound import context',async()=>{
  const journal=randomUUID();
  await h.pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,status,source,created_by) VALUES($1,$2,$3,'2023-02-28','draft','manual',$4)",[journal,h.f.companyA,`PI-${journal}`,h.admin]);
  await h.pool.query("INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit) SELECT company_id,$2,id,CASE WHEN account_code='PI-C' THEN 1150 ELSE 0 END,CASE WHEN account_code='PI-R' THEN 1150 ELSE 0 END FROM gl_accounts WHERE company_id=$1 AND account_code IN ('PI-C','PI-R')",[h.f.companyA,journal]);
  await expect(h.maker({action:'request',importId:randomUUID()},ctx=>requestOperationApproval(ctx,{entityType:'journal_entry',entityId:journal,operation:'journal.post'}))).rejects.toThrow();
  expect((await h.pool.query('SELECT status FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[h.f.companyA,journal])).rows[0].status).toBe('draft');
 });
});

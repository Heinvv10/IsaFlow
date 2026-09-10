import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {platformImportApprovalFixture} from './platformImportApprovalFixture';
import {historicalHash,readHistoricalImportSource,storeHistoricalImportSource} from '@/modules/accounting/services/controls/historicalImportSourceService';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import {executeHistoricalImport} from '@/modules/accounting/services/controls/historicalImportExecution';
import {prepareHistoricalImport} from '@/modules/accounting/services/controls/historicalImportPreparation';
import {assertHistoryEntity} from '@/modules/accounting/services/controls/controlChangeHistoryPolicy';
import {readHistoricalImportSourceKind} from '@/modules/accounting/services/controls/historicalImportSourceKind';
import {historicalImportInvoiceEvidence} from '@/modules/accounting/services/controls/historicalImportInvoiceEvidence';

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
 it.each(['account','source'] as const)('invalidates approval after independent %s material changes',async changed=>{
  const p=await h.prepared(),approval=await h.request(p.ref);await h.review(approval.id);
  if(changed==='account'){
   try{await h.pool.query("UPDATE gl_accounts SET account_name='Changed source account' WHERE company_id=$1 AND id=$2",[h.f.companyA,h.revenue]);await expect(h.execute(p.ref,approval.id)).rejects.toThrow(/changed/i);}
   finally{await h.pool.query("UPDATE gl_accounts SET account_name='PI-R' WHERE company_id=$1 AND id=$2",[h.f.companyA,h.revenue]);}
  }else{
   try{await h.pool.query('UPDATE control_historical_import_sources SET content_hash=$3 WHERE company_id=$1 AND id=$2',[h.f.companyA,p.retained.sourceId,'a'.repeat(64)]);await expect(h.execute(p.ref,approval.id)).rejects.toThrow(/source.*changed/i);}
   finally{await h.pool.query('UPDATE control_historical_import_sources SET content_hash=$3 WHERE company_id=$1 AND id=$2',[h.f.companyA,p.retained.sourceId,p.retained.contentHash]);}
  }
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
 it('refuses a different saved import under a valid execution target and a foreign approval',async()=>{
  const a=await h.prepared(),b=await h.prepared('supplier_invoice');
  const approval=await h.request(a.ref);await h.review(approval.id);
  await expect(h.maker({action:'execute',importId:b.ref.entityId},ctx=>executeHistoricalImport(ctx,a.ref,approval.id))).rejects.toThrow();
  await expect(h.execute(b.ref,approval.id)).rejects.toThrow();
  await expect(h.execute(a.ref,randomUUID())).rejects.toThrow();
  expect(await h.noEffects(a.ref)).toEqual({journals:0,effects:0});expect(await h.noEffects(b.ref)).toEqual({journals:0,effects:0});
 });
 it('confines history and invoice-evidence reads to the selected source while the same maker holds another posted import',async()=>{
  const a=await h.prepared(),b=await h.prepared(),approval=await h.request(b.ref);await h.review(approval.id);
  const invoiceB=(await h.execute(b.ref,approval.id)).documentId;if(!invoiceB)throw new Error('Posted import B produced no invoice');
  for(const selection of [{action:'prepare',sourceId:a.retained.sourceId},{action:'execute',importId:a.ref.entityId}] as const){
   // History entity reads need read:audit, outside the platform ceiling: refused for the selected source too, so this is not the identity guard.
   for(const source of [a,b])await expect(h.maker(selection,ctx=>assertHistoryEntity(ctx,'historical_import_source',source.retained.sourceId))).rejects.toThrow(/Current permissions do not allow/);
   await expect(h.maker(selection,ctx=>readHistoricalImportSourceKind(ctx,b.retained.sourceId))).rejects.toThrow('Platform import source identity differs');
   await expect(h.maker(selection,ctx=>historicalImportInvoiceEvidence(ctx,'customer_invoice',invoiceB))).rejects.toThrow('Platform import authority');
   await expect(h.maker(selection,ctx=>readHistoricalImportSourceKind(ctx,a.retained.sourceId))).resolves.toBe('customer_invoice');
  }
  expect(await h.noEffects(a.ref)).toEqual({journals:0,effects:0});
 });
 it('refuses an actual other-tenant source through a selected company',async()=>{
  const bytes=Buffer.from(JSON.stringify(h.body()));
  const retained=await h.maker({action:'retain',sourceHash:historicalHash(bytes)},ctx=>storeHistoricalImportSource(ctx,{bytes,mimeType:'application/json'}));
  // Trusted fixture relocates this test-only source to the other tenant. Its protected association stays original and must not be disclosed.
  await h.pool.query('UPDATE control_historical_import_sources SET company_id=$3 WHERE company_id=$1 AND id=$2',[h.f.companyA,retained.sourceId,h.f.companyB]);
  await expect(h.maker({action:'prepare',sourceId:retained.sourceId},ctx=>readHistoricalImportSource(ctx,retained.sourceId))).rejects.toThrow();
 });
 it.each(['control_operation_effects','control_change_events','control_protected_evidence'] as const)('rolls back financial writes and committed events after a caught %s INSERT failure',async table=>{
  const p=await h.prepared(),approval=await h.request(p.ref);await h.review(approval.id);
  const before=(await h.pool.query('SELECT id FROM control_change_events WHERE company_id=$1 ORDER BY id',[h.f.companyA])).rows;
  const name=`pi_failure_${randomUUID().replaceAll('-','')}`;
  // Identifiers come only from this closed table list and hexadecimal random UUID, never untrusted input.
  await h.pool.query(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN IF NEW.company_id::text=current_setting('control.synthetic_pi_company',true)
    AND NEW.entity_id=current_setting('control.synthetic_pi_import',true)
    THEN RAISE EXCEPTION 'Synthetic platform import retained INSERT failure'; END IF; RETURN NEW; END $$`);
  await h.pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.${name}()`);
  let caught='';
  try{
   await h.maker({action:'execute',importId:p.ref.entityId},async ctx=>{
    await ctx.sql`SELECT set_config('control.synthetic_pi_company',${h.f.companyA},true),set_config('control.synthetic_pi_import',${p.ref.entityId},true)`;
    try{await executeHistoricalImport(ctx,p.ref,approval.id);}catch(error){caught=error instanceof Error?error.message:String(error);}
   }).catch(error=>{if(!caught)throw error;});
  }finally{
   await h.pool.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);await h.pool.query(`DROP FUNCTION IF EXISTS public.${name}()`);
  }
  expect(caught).toContain('Synthetic platform import retained INSERT failure');
  expect(await h.noEffects(p.ref)).toEqual({journals:0,effects:0});
  expect((await h.pool.query('SELECT id FROM customer_invoices WHERE company_id=$1 AND invoice_number=$2',[h.f.companyA,(JSON.parse(p.bytes.toString()) as {sourceKey:string}).sourceKey])).rows).toHaveLength(0);
  expect((await h.pool.query('SELECT id FROM control_change_events WHERE company_id=$1 ORDER BY id',[h.f.companyA])).rows).toEqual(before);
  expect((await h.pool.query('SELECT status FROM control_operation_approvals WHERE company_id=$1 AND id=$2',[h.f.companyA,approval.id])).rows[0].status).toBe('approved');
  expect((await h.execute(p.ref,approval.id)).documentId).toBeTruthy();
 });
 it.each(['prepare','execute'] as const)('refuses every unconfined tenant reader under a %s target',async action=>{
  const p=await h.prepared();
  const selection=action==='prepare'?{action,sourceId:p.retained.sourceId} as const:{action,importId:p.ref.entityId} as const;
  const {loadJournalRiskPopulation}=await import('@/modules/accounting/services/controls/journalRiskQueries');
  const {queryThreeWayMatch}=await import('@/modules/accounting/services/ap/threeWayMatchQueryService');
  const {readSupplierBankChangeStatus}=await import('@/modules/accounting/services/controls/beneficiaryStatusService');
  // The ceiling must cover only what the confined import path itself needs: a generic
  // reader reaching assertEffectivePermission on the BYPASSRLS platform client is refused.
  await expect(h.maker(selection,ctx=>loadJournalRiskPopulation(ctx,null))).rejects.toThrow(/Current permissions do not allow/);
  await expect(h.maker(selection,ctx=>queryThreeWayMatch(ctx,{}))).rejects.toThrow(/Current permissions do not allow/);
  await expect(h.maker(selection,ctx=>readSupplierBankChangeStatus(ctx,{supplierId:h.supplier}))).rejects.toThrow(/Current permissions do not allow/);
 });
 it('refuses an ordinary journal approval through the target-bound import context',async()=>{
  const journal=randomUUID();
  await h.pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,status,source,created_by) VALUES($1,$2,$3,'2023-02-28','draft','manual',$4)",[journal,h.f.companyA,`PI-${journal}`,h.admin]);
  await h.pool.query("INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit) SELECT company_id,$2,id,CASE WHEN account_code='PI-C' THEN 1150 ELSE 0 END,CASE WHEN account_code='PI-R' THEN 1150 ELSE 0 END FROM gl_accounts WHERE company_id=$1 AND account_code IN ('PI-C','PI-R')",[h.f.companyA,journal]);
  await expect(h.maker({action:'request',importId:randomUUID()},ctx=>requestOperationApproval(ctx,{entityType:'journal_entry',entityId:journal,operation:'journal.post'}))).rejects.toThrow();
  expect((await h.pool.query('SELECT status FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[h.f.companyA,journal])).rows[0].status).toBe('draft');
 });
});

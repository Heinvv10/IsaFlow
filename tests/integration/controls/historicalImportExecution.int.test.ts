import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {storeHistoricalImportSource,readHistoricalImportSource} from '@/modules/accounting/services/controls/historicalImportSourceService';
import {prepareHistoricalImport} from '@/modules/accounting/services/controls/historicalImportPreparation';
import {cancelSupplierInvoice} from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import {processSupplierPayment} from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import {cancelCustomerInvoice} from '@/modules/accounting/services/ar/customerInvoiceCancelService';
import {confirmCustomerPayment} from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import {historicalImportInvoiceEvidence} from '@/modules/accounting/services/controls/historicalImportInvoiceEvidence';
import {executeControlledOperation} from '@/modules/accounting/services/controls/approvalExecutionService';
import {materializeHistoricalImportOperation} from '@/modules/accounting/services/controls/historicalImportMaterializer';
import {registerGeneratedJournal} from '@/modules/accounting/services/controls/generatedJournalPermit';
import {postJournalEntry} from '@/modules/accounting/services/gl/journalEntryPostingService';
import {executeHistoricalImport} from '@/modules/accounting/services/controls/historicalImportExecution';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import type {ControlTx,OperationRef} from '@/modules/accounting/services/controls/contracts';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config),pool=new Pool({connectionString:target.connectionString,ssl:false,max:4,statement_timeout:10000});
let fixture:ForensicFixture;const customer=randomUUID(),supplier=randomUUID(),period=randomUUID(),revenue=randomUUID(),bank=randomUUID();
const scopes=['read:imports','write:imports','read:invoices','write:invoices','read:reports','write:journals','write:post','write:approvals'];
async function actor<T>(person:'u1'|'u2'|'u3',fn:(ctx:ControlTx)=>Promise<T>,bearer=false){const client=await pool.connect(),user=fixture[person];try{
 await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
 await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
 const token=user.tokens[person==='u1'?1:0]!;
 const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:bearer?'pat':'cookie',
  ...(bearer?{connectionId:token.id,grantId:token.id,grantedScopes:scopes}:{})},()=>fn(requireControlTx()));
 if((await client.query('COMMIT')).command!=='COMMIT')throw new Error('Synthetic request did not commit');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);
 await pool.query("UPDATE companies SET default_currency='ZAR',lockdown_enabled=false WHERE id=$1",[fixture.companyA]);
 await pool.query('UPDATE personal_access_tokens SET scopes=$2::text[] WHERE company_id=$1',[fixture.companyA,scopes]);
 await pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'Synthetic historical execution customer')",[customer,fixture.companyA]);
 await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic historical execution supplier')",[supplier,fixture.companyA]);
 for(const [id,code,type,subtype] of [[randomUUID(),'HI-C','asset','receivable'],[revenue,'HI-R','revenue','default_revenue'],[randomUUID(),'HI-V','liability','vat_output'],[bank,'HI-B','asset','bank'],[randomUUID(),'HI-P','liability','payable'],[randomUUID(),'HI-E','expense','default_expense'],[randomUUID(),'HI-I','asset','vat_input']])
  await pool.query('INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,level,is_system_account) VALUES($1,$2,$3,$3,$4,$5,$6,true,3,true)',[id,fixture.companyA,code,type,subtype,['liability','revenue'].includes(type)?'credit':'debit']);
 await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic historical February',2,2023,'2023-02-01','2023-02-28','closed')",[period,fixture.companyA]);
 await pool.query("INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,'Synthetic historical corrections',3,2023,'2023-03-01','2023-03-31','open')",[fixture.companyA]);
 await pool.query("INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,'Synthetic current corrections',9,2026,'2026-09-01','2026-09-30','open')",[fixture.companyA]);
});
afterAll(async()=>{await pool.end();});
async function prepared(kind:'customer_invoice'|'supplier_invoice'|'gl'|'opening_balance'='customer_invoice'):Promise<OperationRef>{
 const key=randomUUID(),ar=kind!=='supplier_invoice',invoice=kind==='customer_invoice'||kind==='supplier_invoice';
 const body={version:1,sourceSystem:'csv',sourceKey:key,kind,mode:'post_journal',accountingDate:'2023-02-28',currency:'ZAR',records:[
  {recordId:'1',accountCode:ar?'HI-C':'HI-P',debit:ar?'115':'0',credit:ar?'0':'115',description:'Historical receivable'},
  {recordId:'2',accountCode:ar?'HI-R':'HI-E',debit:ar?'0':'100',credit:ar?'100':'0',description:'Historical revenue'},
  {recordId:'3',accountCode:ar?'HI-V':'HI-I',debit:ar?'0':'15',credit:ar?'15':'0',description:'Historical output VAT'}],
 ...(invoice?{document:{partyId:ar?customer:supplier,invoiceNumber:key,dueDate:'2023-03-31',subtotal:'100',taxAmount:'15',totalAmount:'115',amountPaid:'0',settlements:[]}}:{})};
 const source=await actor('u1',ctx=>storeHistoricalImportSource(ctx,{bytes:Buffer.from(JSON.stringify(body)),mimeType:'application/json'}));
 const result=await actor('u1',ctx=>prepareHistoricalImport(ctx,{sourceSystem:'csv',sourceKey:key,kind,mode:'post_journal',accountingDate:'2023-02-28',evidenceId:source.sourceId,sourceRecordIds:['1','2','3']}));
 return{entityType:'historical_import',entityId:result.importId,operation:'historical_import.post'};
}
async function approved(ref:OperationRef){const approval=await actor('u1',ctx=>requestOperationApproval(ctx,ref));
 await actor('u2',ctx=>decideOperationApproval(ctx,approval.id,'approved'));return approval.id;}
it('posts a genuinely evidenced independently approved historical invoice once and preserves the closed fiscal period',async()=>{
 const ref=await prepared();
 await expect(actor('u1',ctx=>executeHistoricalImport(ctx,ref))).rejects.toThrow('Independent');
 const approval=await actor('u1',ctx=>requestOperationApproval(ctx,ref));
 await expect(actor('u1',ctx=>decideOperationApproval(ctx,approval.id,'approved'),true)).rejects.toThrow('human');
 await expect(actor('u1',ctx=>decideOperationApproval(ctx,approval.id,'approved'))).rejects.toThrow('Self');
 await actor('u2',ctx=>decideOperationApproval(ctx,approval.id,'approved'));
 const results=await Promise.all([actor('u1',ctx=>executeHistoricalImport(ctx,ref,approval.id)),actor('u1',ctx=>executeHistoricalImport(ctx,ref,approval.id))]);
 expect(results[0]).toEqual(results[1]);const result=results[0]!;expect(result).toMatchObject({importId:ref.entityId,amount:'115',currency:'ZAR',accountingDate:'2023-02-28'});
 expect((await pool.query('SELECT status FROM fiscal_periods WHERE company_id=$1 AND id=$2',[fixture.companyA,period])).rows[0].status).toBe('closed');
 expect((await pool.query('SELECT status,source,source_record_id FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[fixture.companyA,result.journalEntryId])).rows[0]).toMatchObject({status:'posted',source:'auto_gl_import',source_record_id:ref.entityId});
 expect((await pool.query('SELECT status,total_amount::text,amount_paid::text FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,result.documentId])).rows[0]).toMatchObject({status:'approved',total_amount:'115.00',amount_paid:'0.00'});
 expect((await pool.query("SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2 AND operation='historical_import.post'",[fixture.companyA,ref.entityId])).rows).toHaveLength(1);
 expect(await actor('u1',ctx=>executeHistoricalImport(ctx,ref))).toEqual(result);
 expect(await actor('u2',ctx=>historicalImportInvoiceEvidence(ctx,'customer_invoice',result.documentId!))).toMatchObject({subtotal:'100',taxAmount:'15',totalAmount:'115',importId:ref.entityId});
 try{
  await pool.query('UPDATE personal_access_tokens SET scopes=$3::text[] WHERE company_id=$1 AND id=$2',[fixture.companyA,fixture.u2.tokens[0]!.id,['read:invoices']]);
  const summary=await actor('u2',ctx=>historicalImportInvoiceEvidence(ctx,'customer_invoice',result.documentId!),true);
  expect(summary).toMatchObject({subtotal:'100',taxAmount:'15',totalAmount:'115'});
  await expect(actor('u2',ctx=>readHistoricalImportSource(ctx,summary!.sourceId),true)).rejects.toThrow('Current permissions');
 }finally{await pool.query('UPDATE personal_access_tokens SET scopes=$3::text[] WHERE company_id=$1 AND id=$2',[fixture.companyA,fixture.u2.tokens[0]!.id,scopes]);}

 try{await pool.query('UPDATE customer_invoices SET total_amount=116 WHERE company_id=$1 AND id=$2',[fixture.companyA,result.documentId]);
  await expect(actor('u2',ctx=>historicalImportInvoiceEvidence(ctx,'customer_invoice',result.documentId!))).rejects.toThrow('header differs');}
 finally{await pool.query('UPDATE customer_invoices SET total_amount=115 WHERE company_id=$1 AND id=$2',[fixture.companyA,result.documentId]);}

 try{await pool.query("UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u2.id]);
  await expect(actor('u1',ctx=>executeHistoricalImport(ctx,ref))).rejects.toThrow();await expect(actor('u1',ctx=>executeHistoricalImport(ctx,ref,approval.id))).rejects.toThrow();}
 finally{await pool.query("UPDATE company_users SET role='admin' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u2.id]);}
});
it('refuses changed approved material and foreign actor execution without a journal prefix',async()=>{
 const ref=await prepared(),id=await approved(ref);
 await expect(actor('u3',ctx=>executeHistoricalImport(ctx,ref,id))).rejects.toThrow();
 try{await pool.query("UPDATE gl_accounts SET account_name='Changed historical source basis' WHERE company_id=$1 AND id=$2",[fixture.companyA,revenue]);
  await expect(actor('u1',ctx=>executeHistoricalImport(ctx,ref,id))).rejects.toThrow('changed');}
 finally{await pool.query("UPDATE gl_accounts SET account_name='HI-R' WHERE company_id=$1 AND id=$2",[fixture.companyA,revenue]);}
 expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[fixture.companyA,ref.entityId])).rows).toHaveLength(0);
});
it('rechecks company lockdown after approval before historical posting',async()=>{
 const ref=await prepared(),id=await approved(ref);
 try{await pool.query("UPDATE companies SET lockdown_enabled=true,lockdown_date='2023-02-28' WHERE id=$1",[fixture.companyA]);await expect(actor('u1',ctx=>executeHistoricalImport(ctx,ref,id))).rejects.toThrow('lockdown');}
 finally{await pool.query('UPDATE companies SET lockdown_enabled=false WHERE id=$1',[fixture.companyA]);}
 expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[fixture.companyA,ref.entityId])).rows).toHaveLength(0);
});

it('keeps a posted historical source-summary invoice cancellable through the ordinary shared AR path',async()=>{
 const ref=await prepared(),id=await approved(ref),result=await actor('u1',ctx=>executeHistoricalImport(ctx,ref,id));
 const cancelled=await actor('u1',()=>cancelCustomerInvoice(fixture.companyA,result.documentId!,fixture.u1.id,{reversalDate:'2023-03-01'}));
 expect(cancelled.reversedJournalEntryId).toBeTruthy();
 expect((await pool.query('SELECT status FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,result.documentId])).rows[0].status).toBe('cancelled');
});
it('keeps a posted historical source-summary invoice payable through the ordinary shared AR receipt path',async()=>{
 const ref=await prepared(),id=await approved(ref),result=await actor('u1',ctx=>executeHistoricalImport(ctx,ref,id)),payment=randomUUID();
 await pool.query("INSERT INTO customer_payments(id,company_id,client_id,payment_date,total_amount,currency_code,bank_account_id,created_by) VALUES($1,$2,$3,'2023-03-01',115,'ZAR',$4,$5)",[payment,fixture.companyA,customer,bank,fixture.u1.id]);
 await pool.query('INSERT INTO customer_payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,115)',[payment,result.documentId]);
 await actor('u1',()=>confirmCustomerPayment(fixture.companyA,payment,fixture.u1.id));
 expect((await pool.query('SELECT status,amount_paid::text FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,result.documentId])).rows[0]).toMatchObject({status:'paid',amount_paid:'115.00'});
});
it('rolls back a real journal prefix when a caught subledger SQL failure occurs, preserving approval for retry',async()=>{
 const ref=await prepared(),id=await approved(ref);
 await pool.query(`CREATE OR REPLACE FUNCTION public.synthetic_historical_import_failure() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF current_setting('control.synthetic_import_failure',true)='true' THEN RAISE EXCEPTION 'Synthetic import subledger failure'; END IF; RETURN NEW; END $$`);
 await pool.query('CREATE TRIGGER synthetic_historical_import_failure BEFORE INSERT ON customer_invoices FOR EACH ROW EXECUTE FUNCTION public.synthetic_historical_import_failure()');
 try{
  const caught=await actor('u1',async ctx=>{
   await ctx.sql`SELECT set_config('control.synthetic_import_failure','true',true)`;
   try{await executeHistoricalImport(ctx,ref,id);return 'unexpected success';}catch(error){return error instanceof Error?error.message:String(error);}
  });
  expect(caught).toContain('Synthetic import subledger failure');
 }finally{
  await pool.query('DROP TRIGGER IF EXISTS synthetic_historical_import_failure ON customer_invoices');
  await pool.query('DROP FUNCTION IF EXISTS public.synthetic_historical_import_failure()');
 }
 expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[fixture.companyA,ref.entityId])).rows).toHaveLength(0);
 expect((await pool.query('SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2',[fixture.companyA,ref.entityId])).rows).toHaveLength(0);
 expect((await pool.query('SELECT status FROM control_operation_approvals WHERE company_id=$1 AND id=$2',[fixture.companyA,id])).rows[0].status).toBe('approved');
 expect((await actor('u1',ctx=>executeHistoricalImport(ctx,ref,id))).documentId).toBeTruthy();
});

it('records actual PAT provenance on the historical journal, without caller-supplied human actor metadata',async()=>{
 const ref=await prepared(),id=await approved(ref),result=await actor('u1',ctx=>executeHistoricalImport(ctx,ref,id),true);
 expect((await pool.query('SELECT actor_type,actor_token_jti,posting_agent,source_document_hash FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[fixture.companyA,result.journalEntryId])).rows[0]).toMatchObject({actor_type:'agent',actor_token_jti:fixture.u1.tokens[1]!.id,posting_agent:'mcp:historical_import:v1',source_document_hash:expect.stringMatching(/^[a-f0-9]{64}$/)});
});

it.each(['gl','opening_balance','supplier_invoice'] as const)('executes the approved exact %s source group',async kind=>{
 const ref=await prepared(kind),approval=await approved(ref),result=await actor('u1',ctx=>executeHistoricalImport(ctx,ref,approval));
 expect(result).toMatchObject({kind,amount:'115',currency:'ZAR'});
 if(kind==='supplier_invoice')expect(await actor('u2',ctx=>historicalImportInvoiceEvidence(ctx,kind,result.documentId!))).toMatchObject({subtotal:'100',taxAmount:'15',totalAmount:'115'});
 else expect(result.documentId).toBeUndefined();
});
it('keeps an imported supplier source-summary invoice cancellable through the shared AP path',async()=>{
 const ref=await prepared('supplier_invoice'),approval=await approved(ref),result=await actor('u1',ctx=>executeHistoricalImport(ctx,ref,approval));
 await actor('u1',()=>cancelSupplierInvoice(fixture.companyA,result.documentId!,fixture.u1.id));
 expect((await pool.query('SELECT status FROM supplier_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,result.documentId])).rows[0].status).toBe('cancelled');
});
it('keeps an imported supplier source-summary invoice payable through the shared AP path',async()=>{
 const ref=await prepared('supplier_invoice'),approval=await approved(ref),result=await actor('u1',ctx=>executeHistoricalImport(ctx,ref,approval)),payment=randomUUID();
 await pool.query("INSERT INTO supplier_payments(id,company_id,supplier_id,payment_date,total_amount,bank_account_id,status,created_by) VALUES($1,$2,$3,'2023-03-01',115,$4,'approved',$5)",[payment,fixture.companyA,supplier,bank,fixture.u1.id]);
 await pool.query('INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,115)',[payment,result.documentId]);
 await actor('u1',()=>processSupplierPayment(fixture.companyA,payment,fixture.u1.id));
 expect((await pool.query('SELECT status,amount_paid::text FROM supplier_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,result.documentId])).rows[0]).toMatchObject({status:'paid',amount_paid:'115.00'});
});

it('rechecks the exact registered historical child plan at the final shared posting boundary',async()=>{
 const ref=await prepared(),approval=await approved(ref),journal=randomUUID();
 await expect(actor('u1',ctx=>executeControlledOperation(ctx,ref,approval,async permit=>{
  const material=await materializeHistoricalImportOperation(ctx,ref),facts=material.observedSources[0]!.facts as {period:{id:string};source:{contentHash:string};plan:Array<{glAccountId:string;debit:string;credit:string;description:string;vatType?:string}>};
  await ctx.sql`INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,source_record_id,status,created_by,source_document_hash)
   VALUES(${journal}::uuid,${fixture.companyA}::uuid,${`HI-${ref.entityId}`},${permit.accountingDate}::date,${facts.period.id}::uuid,
    'Synthetic historical child mutation','auto_gl_import',${ref.entityId}::uuid,'draft',${fixture.u1.id}::uuid,${facts.source.contentHash})`;
  for(const line of facts.plan)await ctx.sql`INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description,vat_type)
   VALUES(${fixture.companyA}::uuid,${journal}::uuid,${line.glAccountId}::uuid,${line.debit},${line.credit},${line.description},${line.vatType??null})`;
  const parentControl={permit,parent:ref};await registerGeneratedJournal(ctx,parentControl,journal,'journal.post');
  // Simulate a faulty internal importer mutating a valid registered child. Amount remains identical.
  await ctx.sql`UPDATE gl_journal_lines SET gl_account_id=${bank}::uuid WHERE company_id=${fixture.companyA}::uuid AND journal_entry_id=${journal}::uuid AND debit>0`;
  await postJournalEntry(fixture.companyA,journal,fixture.u1.id,{parentControl});return{journalEntryId:journal};
 }))).rejects.toThrow();
 expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[fixture.companyA,journal])).rows).toHaveLength(0);
});

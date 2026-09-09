import {capturedStorage} from './capturedEvidenceTestStorage';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {seedApAccounts} from './apSyntheticAccounts';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {finalizeRequestTransaction} from '@/lib/auth/transactionFinalization';
import {voidSupplierPayment,processSupplierPayment} from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import {seedReleaseSupplier} from './paymentReleaseFixture';
import {approveSupplierInvoice,cancelSupplierInvoice} from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import {createBatch,approveBatch,processBatch} from '@/modules/accounting/services/ap/batchPaymentService';
import {loadPaymentReleaseIntent} from '@/modules/accounting/services/ap/paymentReleaseMaterializer';
import {createPaymentReleaseIntent,enqueuePaymentRelease} from '@/modules/accounting/services/ap/paymentReleaseService';
import {schedulePaymentReleaseDispatch,closePaymentReleasePool} from '@/modules/accounting/services/ap/paymentReleaseDispatcher';
import {getReleasedEftFile} from '@/modules/accounting/services/ap/paymentReleaseFile';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:3});
let providerTransport:typeof fetch|undefined;
let fixture:ForensicFixture,accounts:Awaited<ReturnType<typeof seedApAccounts>>;
beforeAll(async()=>{
 process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
 process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
 const localFetch=globalThis.fetch;
 vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL,init?:RequestInit)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.toString():input.url);
  if(url.origin===new URL(process.env.SUPABASE_URL!).origin&&url.pathname.startsWith('/storage/v1/object/captured-documents/'))return localFetch(input,init);
  if(url.href==='https://api.netcash.co.za/v1/eft/submit'&&providerTransport)return providerTransport(input,init);
  throw new Error('External requests are disabled in synthetic release tests');
 }));
 expect(capturedStorage()).toBeDefined();
 fixture=await provisionForensicFixture(config);
 await pool.query("UPDATE companies SET name='Synthetic release' WHERE id=$1",[fixture.companyA]);accounts=await seedApAccounts(pool,fixture.companyA);
 await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
 VALUES($1,$2,'Synthetic release September',9,2026,'2026-09-01','2026-09-30','open')`,[randomUUID(),fixture.companyA]);
});
afterAll(async()=>{await closePaymentReleasePool();await pool.end();vi.unstubAllGlobals();});
async function actor<T>(action:(ctx:ControlTx)=>Promise<T>,person:'u1'|'u2'='u1'){
 const client=await pool.connect(),user=fixture[person];
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",
   [JSON.stringify({sub:user.id,role:'authenticated',company_id:user.companyId}),user.companyId]);
  const value=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims:{}},
   {personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>action(requireControlTx()));
  await finalizeRequestTransaction(client,false);return value;
 }catch(error){await finalizeRequestTransaction(client,true);throw error;}finally{client.release();}
}
it('refuses individual reversal of a one-child batch before journal or settlement changes',async()=>{
 const supplier=randomUUID(),batch=randomUUID(),payment=randomUUID();
 await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)',[supplier,fixture.companyA,'Synthetic batch supplier']);
 await pool.query(`INSERT INTO supplier_payment_batches(id,company_id,batch_number,batch_date,total_amount,payment_count,payment_method,status,created_by)
  VALUES($1,$2,$3,'2026-09-09',115,1,'eft','processed',$4)`,[batch,fixture.companyA,batch,fixture.u1.id]);
 await pool.query(`INSERT INTO supplier_payments(id,company_id,supplier_id,payment_number,payment_date,total_amount,status,batch_id,created_by)
  VALUES($1,$2,$3,$4,'2026-09-09',115,'processed',$5,$6)`,[payment,fixture.companyA,supplier,payment.slice(0,30),batch,fixture.u1.id]);
 await expect(actor(()=>voidSupplierPayment(fixture.companyA,payment,fixture.u1.id))).rejects.toThrow('batch');
 const result=await pool.query('SELECT status FROM supplier_payments WHERE company_id=$1 AND id=$2',[fixture.companyA,payment]);
 expect(result.rows[0].status).toBe('processed');
 const effects=await pool.query('SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2',[fixture.companyA,payment]);
 expect(effects.rowCount).toBe(0);
});

it('posts one aggregate journal and consumes independent release approval into immutable reservations',async()=>{
 const {supplier,batch}=await postedBatch();
 const journals=await pool.query("SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source='auto_batch_payment' AND source_record_id=$2",[fixture.companyA,batch.id]);
 expect(journals.rowCount).toBe(1);
 const payments=await pool.query('SELECT id,status,gl_journal_entry_id FROM supplier_payments WHERE company_id=$1 AND batch_id=$2',[fixture.companyA,batch.id]);
 expect(payments.rows).toHaveLength(1);expect(payments.rows[0].gl_journal_entry_id).toBe(journals.rows[0].id);
 const intent=await actor(ctx=>createPaymentReleaseIntent(ctx,{batchId:batch.id,channel:'eft',bankFormat:'fnb'}));
 const approval=await actor(ctx=>requestOperationApproval(ctx,{entityType:'payment_release_intent',entityId:intent.intentId,operation:'payment_release.dispatch'}));
 await expect(actor(ctx=>decideOperationApproval(ctx,approval.id,'approved'))).rejects.toThrow();
 await actor(ctx=>decideOperationApproval(ctx,approval.id,'approved'),'u2');
 await actor(ctx=>enqueuePaymentRelease(ctx,intent.intentId,approval.id));
 const reserved=await pool.query('SELECT payment_id FROM control_payment_release_reservations WHERE company_id=$1 AND intent_id=$2',[fixture.companyA,intent.intentId]);
 expect(reserved.rows).toEqual([{payment_id:payments.rows[0].id}]);
 await expect(actor(async ctx=>{await schedulePaymentReleaseDispatch(ctx,intent.intentId);throw new Error('Synthetic rollback');})).rejects.toThrow('Synthetic rollback');
 const rolled=await pool.query('SELECT state FROM control_payment_release_outbox WHERE company_id=$1 AND intent_id=$2',[fixture.companyA,intent.intentId]);
 expect(rolled.rows[0].state).toBe('ready');
 await actor(ctx=>schedulePaymentReleaseDispatch(ctx,intent.intentId));
 const exported=await pool.query('SELECT state FROM control_payment_release_outbox WHERE company_id=$1 AND intent_id=$2',[fixture.companyA,intent.intentId]);
 expect(exported.rows[0].state).toBe('exported');
 const file=await actor(ctx=>getReleasedEftFile(ctx,intent.intentId));expect(file.content).toContain(supplier.bank.accountNumber);
 await actor(ctx=>schedulePaymentReleaseDispatch(ctx,intent.intentId));
 const attempts=await pool.query("SELECT id FROM control_change_events WHERE company_id=$1 AND entity_id=$2 AND action='payment_release.attempting'",[fixture.companyA,intent.intentId]);
 expect(attempts.rowCount).toBe(1);
});

async function postedBatch(process=true,amount=115){
 const supplier=await seedReleaseSupplier(pool,fixture,(person,fn)=>actor(fn,person));
 const invoice=randomUUID();
 await pool.query(`INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,subtotal,tax_rate,tax_amount,total_amount,currency,status,created_by)
 VALUES($1,$2,$3,$4,'2026-09-09',100,15,15,115,'ZAR','draft',$5)`,[invoice,fixture.companyA,supplier.supplier,invoice,fixture.u1.id]);
 await pool.query(`INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,line_total,tax_rate,tax_amount,gl_account_id)
 VALUES($1,'Synthetic release expense',1,100,100,15,15,$2)`,[invoice,accounts.default_expense]);
 await actor(()=>approveSupplierInvoice(fixture.companyA,invoice,fixture.u1.id));
 await pool.query(`UPDATE gl_accounts SET bank_account_number='00123456789',bank_branch_code='001234',bank_account_type='current'
 WHERE company_id=$1 AND id=$2`,[fixture.companyA,accounts.bank]);
 const batch=await actor(()=>createBatch(fixture.companyA,{batchDate:'2026-09-09',paymentMethod:'eft',bankAccountId:accounts.bank,
 payments:[{supplierId:supplier.supplier,invoiceAllocations:[{invoiceId:invoice,amount}]}]},fixture.u1.id));
 await actor(()=>approveBatch(fixture.companyA,batch.id,fixture.u1.id));
 if(process)await actor(()=>processBatch(fixture.companyA,batch.id,fixture.u1.id));
 return{supplier,batch,invoice};
}

it.each(['unknown','accepted'] as const)('commits attempting before fake Netcash transport and never retransmits %s outcome',async expected=>{
 const {batch}=await postedBatch();
 await pool.query("UPDATE companies SET netcash_enabled=true,netcash_service_key='synthetic-service-key',netcash_payouts_key='synthetic-payout-key' WHERE id=$1",[fixture.companyA]);
 const intent=await actor(ctx=>createPaymentReleaseIntent(ctx,{batchId:batch.id,channel:'netcash'}));
 const approval=await actor(ctx=>requestOperationApproval(ctx,{entityType:'payment_release_intent',entityId:intent.intentId,operation:'payment_release.dispatch'}));
 await actor(ctx=>decideOperationApproval(ctx,approval.id,'approved'),'u2');
 await actor(ctx=>enqueuePaymentRelease(ctx,intent.intentId,approval.id));
 let observedState:unknown,observedAttempt:unknown;
 const transport=vi.fn(async()=>{
  const visible=await pool.query('SELECT state,attempt_id FROM control_payment_release_outbox WHERE company_id=$1 AND intent_id=$2',[fixture.companyA,intent.intentId]);
  observedState=visible.rows[0]?.state;observedAttempt=visible.rows[0]?.attempt_id;
  return expected==='accepted'?new Response(JSON.stringify({batchReference:'synthetic-confirmed'}),{status:200}):new Response('uncertain',{status:503});
 });
 providerTransport=transport;
 await actor(ctx=>schedulePaymentReleaseDispatch(ctx,intent.intentId));
 const result=await pool.query('SELECT state FROM control_payment_release_outbox WHERE company_id=$1 AND intent_id=$2',[fixture.companyA,intent.intentId]);
 expect(result.rows[0].state).toBe(expected);expect(transport).toHaveBeenCalledTimes(1);
 expect(observedState).toBe('attempting');expect(observedAttempt).toBeTruthy();
 await actor(ctx=>schedulePaymentReleaseDispatch(ctx,intent.intentId));
 expect(transport).toHaveBeenCalledTimes(1);
});
it('concurrent independently approved intents cannot reserve the same payment twice',async()=>{
 const {batch}=await postedBatch();
 const intents=[];
 for(let i=0;i<2;i++){
  const intent=await actor(ctx=>createPaymentReleaseIntent(ctx,{batchId:batch.id,channel:'eft',bankFormat:'fnb'}));
  const approval=await actor(ctx=>requestOperationApproval(ctx,{entityType:'payment_release_intent',entityId:intent.intentId,operation:'payment_release.dispatch'}));
  await actor(ctx=>decideOperationApproval(ctx,approval.id,'approved'),'u2');intents.push({intentId:intent.intentId,approvalId:approval.id});
 }
 const results=await Promise.allSettled(intents.map(intent=>actor(ctx=>enqueuePaymentRelease(ctx,intent.intentId,intent.approvalId))));
 expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
 expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
 const reservations=await pool.query('SELECT intent_id FROM control_payment_release_reservations WHERE company_id=$1 AND intent_id=ANY($2::uuid[])',[fixture.companyA,intents.map(intent=>intent.intentId)]);
 expect(reservations.rowCount).toBe(1);
 const outboxes=await pool.query('SELECT intent_id FROM control_payment_release_outbox WHERE company_id=$1 AND intent_id=ANY($2::uuid[])',[fixture.companyA,intents.map(intent=>intent.intentId)]);
 expect(outboxes.rowCount).toBe(1);
});
it('rechecks revoked approver authority before taking a queued dispatch claim',async()=>{
 const {batch}=await postedBatch();
 const intent=await actor(ctx=>createPaymentReleaseIntent(ctx,{batchId:batch.id,channel:'eft',bankFormat:'fnb'}));
 const approval=await actor(ctx=>requestOperationApproval(ctx,{entityType:'payment_release_intent',entityId:intent.intentId,operation:'payment_release.dispatch'}));
 await actor(ctx=>decideOperationApproval(ctx,approval.id,'approved'),'u2');
 await actor(ctx=>enqueuePaymentRelease(ctx,intent.intentId,approval.id));
 await pool.query("UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u2.id]);
 try{
  await actor(ctx=>schedulePaymentReleaseDispatch(ctx,intent.intentId));
  const row=await pool.query('SELECT state,attempt_id FROM control_payment_release_outbox WHERE company_id=$1 AND intent_id=$2',[fixture.companyA,intent.intentId]);
  expect(row.rows[0]).toEqual({state:'ready',attempt_id:null});
 }finally{await pool.query("UPDATE company_users SET role='admin' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u2.id]);}
});

it.each(['cancel','other settlement'] as const)('refuses release after source %s despite an earlier independent approval',async change=>{
 const {batch,invoice,supplier}=await postedBatch(false,60);
 const intent=await actor(ctx=>createPaymentReleaseIntent(ctx,{batchId:batch.id,channel:'eft',bankFormat:'fnb'}));
 const approval=await actor(ctx=>requestOperationApproval(ctx,{entityType:'payment_release_intent',entityId:intent.intentId,operation:'payment_release.dispatch'}));
 await actor(ctx=>decideOperationApproval(ctx,approval.id,'approved'),'u2');
 if(change==='cancel')await actor(()=>cancelSupplierInvoice(fixture.companyA,invoice,fixture.u1.id));
 else{
  const other=await actor(()=>createBatch(fixture.companyA,{batchDate:'2026-09-09',paymentMethod:'eft',bankAccountId:accounts.bank,
   payments:[{supplierId:supplier.supplier,invoiceAllocations:[{invoiceId:invoice,amount:55}]}]},fixture.u1.id));
  await actor(()=>approveBatch(fixture.companyA,other.id,fixture.u1.id));
  await actor(()=>processBatch(fixture.companyA,other.id,fixture.u1.id));
 }
 await expect(actor(ctx=>enqueuePaymentRelease(ctx,intent.intentId,approval.id))).rejects.toThrow();
 const reservations=await pool.query('SELECT payment_id FROM control_payment_release_reservations WHERE company_id=$1 AND intent_id=$2',[fixture.companyA,intent.intentId]);
 expect(reservations.rowCount).toBe(0);
});
it('preserves payment preparation through its own settlement but requires a new release intent',async()=>{
 const {batch}=await postedBatch(false);
 const intent=await actor(ctx=>createPaymentReleaseIntent(ctx,{batchId:batch.id,channel:'eft',bankFormat:'fnb'}));
 const approval=await actor(ctx=>requestOperationApproval(ctx,{entityType:'payment_release_intent',entityId:intent.intentId,operation:'payment_release.dispatch'}));
 await actor(ctx=>decideOperationApproval(ctx,approval.id,'approved'),'u2');
 await actor(()=>processBatch(fixture.companyA,batch.id,fixture.u1.id));
 await expect(actor(ctx=>enqueuePaymentRelease(ctx,intent.intentId,approval.id))).rejects.toThrow('sources changed');
 const current=await actor(ctx=>createPaymentReleaseIntent(ctx,{batchId:batch.id,channel:'eft',bankFormat:'fnb'}));
 expect(current.intentId).not.toBe(intent.intentId);
});

it('direct source materialization refuses a cancelled invoice without central release dispatch',async()=>{
 const {batch,invoice}=await postedBatch(false);
 const intent=await actor(ctx=>createPaymentReleaseIntent(ctx,{batchId:batch.id,channel:'eft',bankFormat:'fnb'}));
 await actor(ctx=>loadPaymentReleaseIntent(ctx,intent.intentId));
 await actor(()=>cancelSupplierInvoice(fixture.companyA,invoice,fixture.u1.id));
 await expect(actor(ctx=>loadPaymentReleaseIntent(ctx,intent.intentId))).rejects.toThrow();
});
it('direct materialization binds later committed invoice changes without central dispatch',async()=>{
 const {batch,invoice}=await postedBatch(false);
 const intent=await actor(ctx=>createPaymentReleaseIntent(ctx,{batchId:batch.id,channel:'eft',bankFormat:'fnb'}));
 await actor(ctx=>loadPaymentReleaseIntent(ctx,intent.intentId));
 // Synthetic writer observation: actual committed row change, no external financial transaction.
 await pool.query('UPDATE supplier_invoices SET amount_paid=1 WHERE company_id=$1 AND id=$2',[fixture.companyA,invoice]);
 await expect(actor(ctx=>loadPaymentReleaseIntent(ctx,intent.intentId))).rejects.toThrow();
});

it.each(['doubled','reversed direction','wrong bank'] as const)('refuses a fresh release intent when its posted settlement journal is %s',async corruption=>{
 const {batch}=await postedBatch();
 if(corruption==='doubled')await pool.query(`UPDATE gl_journal_lines SET debit=debit*2,credit=credit*2 WHERE company_id=$1
  AND journal_entry_id=(SELECT gl_journal_entry_id FROM supplier_payment_batches WHERE company_id=$1 AND id=$2)`,[fixture.companyA,batch.id]);
 else if(corruption==='reversed direction')await pool.query(`UPDATE gl_journal_lines SET debit=credit,credit=debit WHERE company_id=$1
  AND journal_entry_id=(SELECT gl_journal_entry_id FROM supplier_payment_batches WHERE company_id=$1 AND id=$2)`,[fixture.companyA,batch.id]);
 else await pool.query(`UPDATE gl_journal_lines SET gl_account_id=$3 WHERE company_id=$1 AND gl_account_id=$4
  AND journal_entry_id=(SELECT gl_journal_entry_id FROM supplier_payment_batches WHERE company_id=$1 AND id=$2)`,[fixture.companyA,batch.id,accounts.default_expense,accounts.bank]);
 await expect(actor(ctx=>createPaymentReleaseIntent(ctx,{batchId:batch.id,channel:'eft',bankFormat:'fnb'}))).rejects.toThrow('settlement');
});

it.each(['revoked approver','expired approval'] as const)('refuses EFT download after export with %s',async changed=>{
 const {batch}=await postedBatch();
 const intent=await actor(ctx=>createPaymentReleaseIntent(ctx,{batchId:batch.id,channel:'eft',bankFormat:'fnb'}));
 const approval=await actor(ctx=>requestOperationApproval(ctx,{entityType:'payment_release_intent',entityId:intent.intentId,operation:'payment_release.dispatch'}));
 await actor(ctx=>decideOperationApproval(ctx,approval.id,'approved'),'u2');
 await actor(ctx=>enqueuePaymentRelease(ctx,intent.intentId,approval.id));
 await actor(ctx=>schedulePaymentReleaseDispatch(ctx,intent.intentId));
 if(changed==='revoked approver')await pool.query("UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u2.id]);
 else await pool.query("UPDATE control_operation_approvals SET requested_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' WHERE company_id=$1 AND id=$2",[fixture.companyA,approval.id]);
 try{await expect(actor(ctx=>getReleasedEftFile(ctx,intent.intentId))).rejects.toThrow();}
 finally{await pool.query("UPDATE company_users SET role='admin' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u2.id]);}
});
it('refuses standalone processing of an approved batch child before individual journal creation',async()=>{
 const {batch}=await postedBatch(false);
 const [payment]=(await pool.query('SELECT id FROM supplier_payments WHERE company_id=$1 AND batch_id=$2',[fixture.companyA,batch.id])).rows;
 await expect(actor(()=>processSupplierPayment(fixture.companyA,payment.id,fixture.u1.id))).rejects.toThrow('batch');
 expect((await pool.query('SELECT status,gl_journal_entry_id FROM supplier_payments WHERE company_id=$1 AND id=$2',[fixture.companyA,payment.id])).rows[0]).toEqual({status:'approved',gl_journal_entry_id:null});
});

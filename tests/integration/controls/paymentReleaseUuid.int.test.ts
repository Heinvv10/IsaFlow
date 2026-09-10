import {capturedStorage} from './capturedEvidenceTestStorage';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {uuidBoundaryFixture,upper} from './uuidBoundaryFixture';
import {seedApAccounts} from './apSyntheticAccounts';
import {seedReleaseSupplier} from './paymentReleaseFixture';
import {approveSupplierInvoice} from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import {createBatch,approveBatch,processBatch} from '@/modules/accounting/services/ap/batchPaymentService';
import {createPaymentReleaseIntent,enqueuePaymentRelease} from '@/modules/accounting/services/ap/paymentReleaseService';
import {schedulePaymentReleaseDispatch,closePaymentReleasePool} from '@/modules/accounting/services/ap/paymentReleaseDispatcher';
import {getReleasedEftFile} from '@/modules/accounting/services/ap/paymentReleaseFile';
let f:Awaited<ReturnType<typeof uuidBoundaryFixture>>,accounts:Awaited<ReturnType<typeof seedApAccounts>>;
beforeAll(async()=>{
 const localFetch=globalThis.fetch;
 vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL,init?:RequestInit)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.toString():input.url);
  if(url.origin===new URL(process.env.SUPABASE_URL!).origin&&url.pathname.startsWith('/storage/v1/object/captured-documents/'))return localFetch(input,init);
  throw new Error('External requests are disabled in synthetic release tests');
 }));
 expect(capturedStorage()).toBeDefined();
 f=await uuidBoundaryFixture();
 await f.pool.query("UPDATE companies SET name='Synthetic UUID release' WHERE id=$1",[f.f.companyA]);accounts=await seedApAccounts(f.pool,f.f.companyA);
 await f.pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
  VALUES($1,$2,'Synthetic UUID release September',9,2026,'2026-09-01','2026-09-30','open')`,[randomUUID(),f.f.companyA]);
 await f.pool.query(`UPDATE gl_accounts SET bank_account_number='00123456789',bank_branch_code='001234',bank_account_type='current'
  WHERE company_id=$1 AND id=$2`,[f.f.companyA,accounts.bank]);
},60000);
afterAll(async()=>{await closePaymentReleasePool();await f?.close();vi.unstubAllGlobals();});
type Queued=Awaited<ReturnType<typeof enqueuePaymentRelease>>;
/** A processed one-payment batch to an independently verified beneficiary, prepared as an immutable EFT release. */
async function prepared(){
 const company=f.f.companyA,user=f.f.u1.id,supplier=await seedReleaseSupplier(f.pool,f.f,(person,fn)=>f.actor(fn,person)),invoice=randomUUID();
 await f.pool.query(`INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,subtotal,tax_rate,tax_amount,total_amount,currency,status,created_by)
  VALUES($1,$2,$3,$4,'2026-09-09',100,15,15,115,'ZAR','draft',$5)`,[invoice,company,supplier.supplier,invoice,user]);
 await f.pool.query(`INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,line_total,tax_rate,tax_amount,gl_account_id)
  VALUES($1,'Synthetic UUID release expense',1,100,100,15,15,$2)`,[invoice,accounts.default_expense]);
 await f.actor(()=>approveSupplierInvoice(company,invoice,user));
 const batch=await f.actor(()=>createBatch(company,{batchDate:'2026-09-09',paymentMethod:'eft',bankAccountId:accounts.bank,
  payments:[{supplierId:supplier.supplier,invoiceAllocations:[{invoiceId:invoice,amount:115}]}]},user));
 await f.actor(()=>approveBatch(company,batch.id,user));await f.actor(()=>processBatch(company,batch.id,user));
 const intent=await f.actor(ctx=>createPaymentReleaseIntent(ctx,{batchId:batch.id,channel:'eft',bankFormat:'fnb'}));
 upper(intent.intentId);
 return{...intent,supplier,operation:{entityType:'payment_release_intent',entityId:intent.intentId,operation:'payment_release.dispatch' as const}};
}
const enqueue=(id:string,approvalId:string)=>f.actor(ctx=>enqueuePaymentRelease(ctx,id,approvalId));
async function state(id:string){
 const rows=async(sql:string)=>(await f.pool.query(sql,[f.f.companyA,id])).rows;
 return{reservations:await rows('SELECT payment_id FROM control_payment_release_reservations WHERE company_id=$1 AND intent_id=$2::uuid'),
  outbox:await rows('SELECT state,provider_reference FROM control_payment_release_outbox WHERE company_id=$1 AND intent_id=$2::uuid'),
  attempts:await rows("SELECT id FROM control_change_events WHERE company_id=$1 AND lower(entity_id)=lower($2) AND action='payment_release.attempting'"),
  effects:await f.effects('payment_release_intent','payment_release.dispatch',id),
  consumed:(await f.approvals('payment_release_intent',id)).filter(a=>a.status==='consumed').length};
}
function expectOneQueuedRelease(saved:Awaited<ReturnType<typeof state>>){
 expect(saved.reservations).toHaveLength(1);expect(saved.outbox).toHaveLength(1);expect(saved.effects).toHaveLength(1);
 expect(saved.consumed).toBe(1);expect(saved.attempts.length).toBeLessThanOrEqual(1);
}
it.each([false,true])('binds the queued release receipt and provider reference to canonical identity after initial uppercase=%s enqueue',async uppercase=>{
 const p=await prepared(),approval=await f.approve(p.operation),caseVariant=upper(p.intentId);
 const first=await enqueue(uppercase?caseVariant:p.intentId,approval);
 expect(first.intentId).toBe(p.intentId);
 await expect(enqueue(p.intentId,approval)).resolves.toEqual(first);
 await expect(enqueue(caseVariant,approval)).resolves.toEqual(first);
 const saved=await state(p.intentId);
 expectOneQueuedRelease(saved);expect(saved.outbox[0].provider_reference).toBe(p.intentId);
});
it('dispatches and downloads an EFT release addressed by uppercase UUID after canonical enqueue',async()=>{
 const p=await prepared(),caseVariant=upper(p.intentId);
 await enqueue(p.intentId,await f.approve(p.operation));
 const dispatch=await f.attempt(()=>f.actor(ctx=>schedulePaymentReleaseDispatch(ctx,caseVariant)));
 const saved=await state(p.intentId);
 expect({state:saved.outbox[0]?.state,error:dispatch.error instanceof Error?dispatch.error.message:null}).toEqual({state:'exported',error:null});
 expectOneQueuedRelease(saved);
 const file=await f.actor(ctx=>getReleasedEftFile(ctx,caseVariant));
 expect(file.content).toContain(p.supplier.bank.accountNumber);
});
it('cannot reserve or queue one release twice through an independently approved UUID case variant',async()=>{
 const p=await prepared(),first=await enqueue(p.intentId,await f.approve(p.operation));
 const second=await f.attempt(async()=>enqueue(upper(p.intentId),await f.approve({...p.operation,entityId:upper(p.intentId)})));
 expectOneQueuedRelease(await state(p.intentId));
 if(second.value)expect(second.value).toEqual(first);else expect(second.error).toBeInstanceOf(Error);
});
it('serializes concurrently enqueued independently approved lower and uppercase releases to one reservation',async()=>{
 const p=await prepared(),lowerApproval=await f.approve(p.operation),upperApproval=await f.approve({...p.operation,entityId:upper(p.intentId)});
 const outcomes=await Promise.allSettled([enqueue(p.intentId,lowerApproval),enqueue(upper(p.intentId),upperApproval)]);
 expect(outcomes.filter((o):o is PromiseFulfilledResult<Queued>=>o.status==='fulfilled')).toHaveLength(1);
 expectOneQueuedRelease(await state(p.intentId));
});

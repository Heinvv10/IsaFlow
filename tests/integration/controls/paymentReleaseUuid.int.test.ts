import {capturedStorage} from './capturedEvidenceTestStorage';
import {log} from '@/lib/logger';
import * as Sentry from '@sentry/nextjs';
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
async function prepared(channel:'eft'|'netcash'='eft'){
 const company=f.f.companyA,user=f.f.u1.id,supplier=await seedReleaseSupplier(f.pool,f.f,(person,fn)=>f.actor(fn,person)),invoice=randomUUID();
 await f.pool.query(`INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,subtotal,tax_rate,tax_amount,total_amount,currency,status,created_by)
  VALUES($1,$2,$3,$4,'2026-09-09',100,15,15,115,'ZAR','draft',$5)`,[invoice,company,supplier.supplier,invoice,user]);
 await f.pool.query(`INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,line_total,tax_rate,tax_amount,gl_account_id)
  VALUES($1,'Synthetic UUID release expense',1,100,100,15,15,$2)`,[invoice,accounts.default_expense]);
 await f.actor(()=>approveSupplierInvoice(company,invoice,user));
 const batch=await f.actor(()=>createBatch(company,{batchDate:'2026-09-09',paymentMethod:'eft',bankAccountId:accounts.bank,
  payments:[{supplierId:supplier.supplier,invoiceAllocations:[{invoiceId:invoice,amount:115}]}]},user));
 await f.actor(()=>approveBatch(company,batch.id,user));await f.actor(()=>processBatch(company,batch.id,user));
 const intent=await f.actor(ctx=>createPaymentReleaseIntent(ctx,channel==='eft'?{batchId:batch.id,channel,bankFormat:'fnb'}:{batchId:batch.id,channel}));
 upper(intent.intentId);
 return{...intent,supplier,batchId:batch.id,operation:{entityType:'payment_release_intent',entityId:intent.intentId,operation:'payment_release.dispatch' as const}};
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
/**
 * A refused post-commit claim used to leave no trace at all: settleControlTransaction only logs the
 * observer error, and 'ready' is indistinguishable from a release nobody has dispatched yet.
 */
async function events(intentId:string,action:string){
 return(await f.pool.query(`SELECT after_values->>'reason' AS reason,after_values->>'status' AS status FROM control_change_events
  WHERE company_id=$1 AND entity_type='payment_release_outbox' AND lower(entity_id)=lower($2) AND action=$3`,[f.f.companyA,intentId,action])).rows;
}
/**
 * A refused claim used to leave no trace at all: settleControlTransaction discards the observer error
 * and logs only the outcome, and 'ready' is indistinguishable from a release nobody has dispatched yet.
 */
it('records a durable failure when the post-commit release claim cannot run',async()=>{
 const company=f.f.companyA;
 await f.pool.query("UPDATE companies SET netcash_enabled=true,netcash_service_key='synthetic-service',netcash_payouts_key='synthetic-payouts' WHERE id=$1",[company]);
 const p=await prepared('netcash');
 await enqueue(p.intentId,await f.approve(p.operation));
 await f.pool.query('UPDATE companies SET netcash_service_key=NULL,netcash_payouts_key=NULL WHERE id=$1',[company]);
 const dispatch=await f.attempt(()=>f.actor(ctx=>schedulePaymentReleaseDispatch(ctx,p.intentId)));
 const saved=await state(p.intentId);
 expect({error:dispatch.error instanceof Error?dispatch.error.message:null,state:saved.outbox[0]?.state}).toEqual({error:null,state:'ready'});
 expect(await events(p.intentId,'payment_release.dispatch_failed')).toEqual([{reason:'Release provider configuration changed',status:'ready'}]);
 expect(await events(p.intentId,'payment_release.acknowledgement_failed')).toEqual([]);
});
/**
 * Worse than a refused claim: transmit returned, so for a real provider the money is gone, and the
 * acknowledgement is what failed. The outbox is left 'attempting', which alone does not say the
 * provider accepted it. A synthetic trigger forces exactly that acknowledgement failure.
 */
it('records a durable failure when the provider result cannot be acknowledged after transmit',async()=>{
 const p=await prepared();
 await enqueue(p.intentId,await f.approve(p.operation));
 await f.pool.query(`CREATE OR REPLACE FUNCTION public.synthetic_release_ack_failure() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF NEW.intent_id='${p.intentId}'::uuid AND NEW.state='exported' THEN RAISE EXCEPTION 'Synthetic release acknowledgement failure'; END IF; RETURN NEW; END $$`);
 try{
  await f.pool.query('DROP TRIGGER IF EXISTS synthetic_release_ack_failure ON control_payment_release_outbox');
  await f.pool.query('CREATE TRIGGER synthetic_release_ack_failure BEFORE UPDATE ON control_payment_release_outbox FOR EACH ROW EXECUTE FUNCTION public.synthetic_release_ack_failure()');
  const dispatch=await f.attempt(()=>f.actor(ctx=>schedulePaymentReleaseDispatch(ctx,p.intentId)));
  const saved=await state(p.intentId);
  expect({error:dispatch.error instanceof Error?dispatch.error.message:null,state:saved.outbox[0]?.state}).toEqual({error:null,state:'attempting'});
 }finally{
  await f.pool.query('DROP TRIGGER IF EXISTS synthetic_release_ack_failure ON control_payment_release_outbox');
  await f.pool.query('DROP FUNCTION IF EXISTS public.synthetic_release_ack_failure()');
 }
 const recorded=await events(p.intentId,'payment_release.acknowledgement_failed');
 expect(recorded).toHaveLength(1);
 expect(recorded[0].status).toBe('attempting');
 expect(recorded[0].reason).toContain('after provider outcome exported (FILE_GENERATED)');
 expect(await events(p.intentId,'payment_release.dispatch_failed')).toEqual([]);
});
/**
 * SYNTHESIZED legacy state, NOT old-code output: no fad0f57f7 baseline seed exists for this operation,
 * so the retained entity_id is rewritten to uppercase by a hand UPDATE below. What that stands in for
 * is real — old code wrote entity_id from the caller's spelling — but this row was produced by current
 * code and edited, and it is weaker evidence than the AR case, which replays a receipt a genuine
 * fad0f57f7 worktree wrote.
 */
it('loads a payment settlement whose retained receipt kept a legacy uppercase entity_id',async()=>{
 const p=await prepared(),company=f.f.companyA;
 const rewritten=await f.pool.query(`UPDATE control_operation_effects SET entity_id=upper(entity_id)
  WHERE company_id=$1 AND operation IN('supplier_payment.process','supplier_payment_batch.process')
   AND lower(entity_id) IN(SELECT lower(id::text) FROM supplier_payment_batches WHERE company_id=$1 AND id=$2::uuid
    UNION SELECT lower(id::text) FROM supplier_payments WHERE company_id=$1 AND batch_id=$2::uuid) RETURNING entity_id`,[company,p.batchId]);
 expect(rewritten.rows.length).toBeGreaterThan(0);
 expect(rewritten.rows.every(r=>r.entity_id===r.entity_id.toUpperCase())).toBe(true);
 const again=await f.attempt(()=>f.actor(ctx=>createPaymentReleaseIntent(ctx,{batchId:p.batchId,channel:'eft',bankFormat:'fnb'})));
 expect({error:again.error instanceof Error?again.error.message:null,status:again.value?.status}).toEqual({error:null,status:'prepared'});
});
/**
 * A failure against a row another attempt already advanced still has to leave a trace, and the trace
 * has to say which it was: the recorded status is the state observed under FOR UPDATE, so 'attempting'
 * reads as an attempt that lost the race rather than as a release nobody dispatched. Reaching
 * 'attempting' through a forced acknowledgement failure, then breaking the reservation population so
 * the next claim throws, is the deterministic stand-in for that concurrent dispatcher.
 */
it('records a dispatch failure against an advanced release under the state it actually observed',async()=>{
 const p=await prepared();
 await enqueue(p.intentId,await f.approve(p.operation));
 await f.pool.query(`CREATE OR REPLACE FUNCTION public.synthetic_release_advance_only() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF NEW.intent_id='${p.intentId}'::uuid AND NEW.state='exported' THEN RAISE EXCEPTION 'Synthetic release acknowledgement failure'; END IF; RETURN NEW; END $$`);
 try{
  await f.pool.query('DROP TRIGGER IF EXISTS synthetic_release_advance_only ON control_payment_release_outbox');
  await f.pool.query('CREATE TRIGGER synthetic_release_advance_only BEFORE UPDATE ON control_payment_release_outbox FOR EACH ROW EXECUTE FUNCTION public.synthetic_release_advance_only()');
  await f.actor(ctx=>schedulePaymentReleaseDispatch(ctx,p.intentId));
 }finally{
  await f.pool.query('DROP TRIGGER IF EXISTS synthetic_release_advance_only ON control_payment_release_outbox');
  await f.pool.query('DROP FUNCTION IF EXISTS public.synthetic_release_advance_only()');
 }
 expect((await state(p.intentId)).outbox[0]?.state).toBe('attempting');
 expect((await f.pool.query('DELETE FROM control_payment_release_reservations WHERE company_id=$1 AND intent_id=$2::uuid',[f.f.companyA,p.intentId])).rowCount).toBe(1);
 await f.actor(ctx=>schedulePaymentReleaseDispatch(ctx,p.intentId));
 expect((await state(p.intentId)).outbox[0]?.state).toBe('attempting');
 expect(await events(p.intentId,'payment_release.dispatch_failed')).toEqual([{reason:'Release reservation population changed',status:'attempting'}]);
});
/**
 * The catch in recordFailedDispatch is the whole mitigation for a record that cannot be written, and
 * it is the only path where an escaping error would reach settleControlTransaction, which discards it.
 * A trigger that refuses the change-event INSERT forces exactly that, with no spy involved: the
 * dispatch still resolves, no event exists, and the outbox is untouched.
 */
it('swallows a failure to record a failed dispatch rather than escaping the observer',async()=>{
 const company=f.f.companyA;
 await f.pool.query("UPDATE companies SET netcash_enabled=true,netcash_service_key='synthetic-service',netcash_payouts_key='synthetic-payouts' WHERE id=$1",[company]);
 const p=await prepared('netcash');
 await enqueue(p.intentId,await f.approve(p.operation));
 await f.pool.query('UPDATE companies SET netcash_service_key=NULL,netcash_payouts_key=NULL WHERE id=$1',[company]);
 const before=(await state(p.intentId)).outbox;
 // Read the calls BEFORE mockRestore: in Vitest mockRestore also resets the mock, so reading
 // mock.calls afterwards always yields [] no matter what was captured.
 const errors=vi.spyOn(log,'error').mockImplementation(()=>{});
 let reported:Array<[unknown,unknown]>=[];
 await f.pool.query(`CREATE OR REPLACE FUNCTION public.synthetic_change_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF NEW.company_id='${company}'::uuid AND NEW.entity_type='payment_release_outbox' THEN RAISE EXCEPTION 'Synthetic change event failure'; END IF; RETURN NEW; END $$`);
 try{
  await f.pool.query('DROP TRIGGER IF EXISTS synthetic_change_event_failure ON control_change_events');
  await f.pool.query('CREATE TRIGGER synthetic_change_event_failure BEFORE INSERT ON control_change_events FOR EACH ROW EXECUTE FUNCTION public.synthetic_change_event_failure()');
  const dispatch=await f.attempt(()=>f.actor(ctx=>schedulePaymentReleaseDispatch(ctx,p.intentId)));
  reported=errors.mock.calls.map(call=>[call[0],(call[1] as {reason?:string}|undefined)?.reason]);
  expect(dispatch.error).toBeUndefined();
 }finally{
  errors.mockRestore();
  await f.pool.query('DROP TRIGGER IF EXISTS synthetic_change_event_failure ON control_change_events');
  await f.pool.query('DROP FUNCTION IF EXISTS public.synthetic_change_event_failure()');
 }
 expect(await events(p.intentId,'payment_release.dispatch_failed')).toEqual([]);
 expect((await state(p.intentId)).outbox).toEqual(before);
 // The log line is the whole mitigation once the record cannot be written.
 expect(reported).toEqual([['Release dispatch failure could not be recorded; queued release requires reconciliation',
  'Release provider configuration changed']]);
});
/** A queued netcash release whose credentials vanish after enqueue, so its post-commit claim throws. */
async function refusedNetcashRelease(){
 const company=f.f.companyA;
 await f.pool.query("UPDATE companies SET netcash_enabled=true,netcash_service_key='synthetic-service',netcash_payouts_key='synthetic-payouts' WHERE id=$1",[company]);
 const p=await prepared('netcash');
 await enqueue(p.intentId,await f.approve(p.operation));
 await f.pool.query('UPDATE companies SET netcash_service_key=NULL,netcash_payouts_key=NULL WHERE id=$1',[company]);
 return p;
}
/**
 * The property the 30s recorder budget nearly broke. The dispatch pool sets statement_timeout 5s BELOW
 * its client-side query_timeout 6s, so a recorder stuck behind a version-table lock is cancelled by the
 * SERVER, its ROLLBACK runs, and the connection returns to the pool clean. Invert that ordering and the
 * client gives up while the server statement keeps waiting: the connection goes back still holding an
 * open transaction, the outbox FOR UPDATE lock and this tenant's role for the next borrower.
 */
it('returns the recorder connection to the pool clean after a lock-wait timeout',async()=>{
 const p=await refusedNetcashRelease();
 const errors=vi.spyOn(log,'error').mockImplementation(()=>{});
 const holder=await f.pool.connect();let reported:unknown[]=[],stray:number|null=null;
 try{
  await holder.query('BEGIN');
  // What withInvoiceMatchSourceLocks takes, held here for longer than the pool's whole budget.
  await holder.query('LOCK TABLE control_entity_versions IN SHARE ROW EXCLUSIVE MODE');
  const holderPid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
  const dispatch=await f.attempt(()=>f.actor(ctx=>schedulePaymentReleaseDispatch(ctx,p.intentId)));
  expect(dispatch.error).toBeUndefined();
  reported=errors.mock.calls.map(call=>(call[1] as {code?:unknown}|undefined)?.code);
  // Still under the lock: a clean pool has no other client backend mid-statement or mid-transaction.
  stray=Number((await f.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
   AND backend_type='client backend' AND pid NOT IN($1,pg_backend_pid())
   AND state IN('active','idle in transaction','idle in transaction (aborted)')`,[holderPid])).rows[0].n);
 }finally{errors.mockRestore();await holder.query('ROLLBACK');holder.release();}
 expect(stray).toBe(0);
 // The server cancelled it: 57014, never the client's code-less 'Query read timeout'.
 expect(reported).toEqual(['57014']);
 // Nothing left holding the outbox row, and no late COMMIT persisted the record reported as lost.
 const probe=await f.pool.connect();
 try{
  await probe.query('BEGIN');
  await expect(probe.query('SELECT 1 FROM control_payment_release_outbox WHERE company_id=$1 AND intent_id=$2::uuid FOR UPDATE NOWAIT',[f.f.companyA,p.intentId])).resolves.toBeDefined();
 }finally{await probe.query('ROLLBACK');probe.release();}
 expect(await events(p.intentId,'payment_release.dispatch_failed')).toEqual([]);
},30000);
/**
 * SENTRY_ENABLED is unset in tests, so without this the reporting block could be deleted and every
 * other case would stay green. A real Sentry client whose beforeSend captures and drops the event
 * proves the fatal report, its tags and its exception actually reach the tracker — nothing is sent.
 */
it('reports a failure to record a failed dispatch to the error tracker, tagged by company and intent',async()=>{
 const p=await refusedNetcashRelease(),captured:Sentry.ErrorEvent[]=[];
 const priorGate=process.env.SENTRY_ENABLED;
 Sentry.init({dsn:'https://public@o0.ingest.invalid/0',defaultIntegrations:false,
  beforeSend:event=>{captured.push(event);return null;}});
 process.env.SENTRY_ENABLED='true';
 const errors=vi.spyOn(log,'error').mockImplementation(()=>{});
 try{
  await f.pool.query(`CREATE OR REPLACE FUNCTION public.synthetic_change_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN IF NEW.company_id='${f.f.companyA}'::uuid AND NEW.entity_type='payment_release_outbox' THEN RAISE EXCEPTION 'Synthetic change event failure'; END IF; RETURN NEW; END $$`);
  await f.pool.query('DROP TRIGGER IF EXISTS synthetic_change_event_failure ON control_change_events');
  await f.pool.query('CREATE TRIGGER synthetic_change_event_failure BEFORE INSERT ON control_change_events FOR EACH ROW EXECUTE FUNCTION public.synthetic_change_event_failure()');
  await f.actor(ctx=>schedulePaymentReleaseDispatch(ctx,p.intentId));
  await Sentry.flush(2000);
 }finally{
  errors.mockRestore();
  if(priorGate===undefined)delete process.env.SENTRY_ENABLED;else process.env.SENTRY_ENABLED=priorGate;
  await Sentry.close(2000);
  await f.pool.query('DROP TRIGGER IF EXISTS synthetic_change_event_failure ON control_change_events');
  await f.pool.query('DROP FUNCTION IF EXISTS public.synthetic_change_event_failure()');
 }
 expect(captured.map(event=>({level:event.level,tags:event.tags,message:event.exception?.values?.[0]?.value}))).toEqual([{
  level:'fatal',tags:{company_id:f.f.companyA,payment_release_intent_id:p.intentId,payment_release_action:'payment_release.dispatch_failed'},
  message:'Synthetic change event failure'}]);
});

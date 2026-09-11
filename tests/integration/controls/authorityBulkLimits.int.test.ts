import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {authorityLockFixture,type Timed} from './authorityLockFixture';
import {heldWhile,refused,seedBulkPaths,toolText} from './authorityBulkSeed';
import {MAX_BANK_LINES_PER_REQUEST,MAX_BATCH_PAYMENTS_PER_BATCH,MAX_FINALIZED_INVOICES_PER_REQUEST,MAX_POSTED_DOCUMENTS_PER_REQUEST,MAX_RECURRING_INVOICES_PER_RUN} from '@/lib/limits/authorityHoldLimits';
import {seedReleaseSupplier} from './paymentReleaseFixture';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
// Object storage is not reachable from the fixture; the PDF is still rendered and sealed.
vi.mock('@/lib/supabaseStorage',async importOriginal=>({...await importOriginal<typeof import('@/lib/supabaseStorage')>(),
 uploadCustomerInvoicePdf:async(companyId:string,documentId:string)=>({bucket:'customer-invoices',path:`${companyId}/${documentId}.pdf`})}));
/**
 * Every bulk path that holds the company authority key across many elements is capped so the hold stays under half
 * the key's 5 s bound: an oversized batch is refused up front with the maximum named, and a maximum-size batch
 * completes while another person's ordinary read in the same company is served, not queued into a 503.
 */
let x:Awaited<ReturnType<typeof authorityLockFixture>>,sampler:PoolClient,seed:Awaited<ReturnType<typeof seedBulkPaths>>;
beforeAll(async()=>{x=await authorityLockFixture();sampler=await x.pool.connect();seed=await seedBulkPaths(x);},120000);
afterAll(async()=>{sampler?.release();if(x)await x.close();});
const key=()=>randomUUID();
const actor=<T,>(person:'u1'|'u2',action:(ctx:ControlTx)=>Promise<T>)=>withAuditWorkerTransaction(x.pool,{companyId:x.f.companyA,personId:x.f[person].id,jobId:randomUUID()},'read committed',Date.now()+20000,undefined,
 store=>withControlRequest(store,{companyId:x.f.companyA,personId:x.f[person].id,authMethod:'cookie'},()=>action(requireControlTx())));
async function dueTemplates(n:number){
 await x.pool.query("UPDATE recurring_invoices SET status='completed' WHERE company_id=$1",[x.f.companyA]);
 for(let i=0;i<n;i++)await x.pool.query(`INSERT INTO recurring_invoices(company_id,template_name,client_id,frequency,next_run_date,status,line_items,subtotal,tax_rate,tax_amount,total_amount,created_by,currency_code)
  VALUES($1,$2,$3,'monthly',CURRENT_DATE-1,'active',$4::jsonb,100,15,15,115,$5,'ZAR')`,[x.f.companyA,`Synthetic ${i}`,seed.seeded.customer,JSON.stringify([{description:'Synthetic recurring',quantity:1,unitPrice:100}]),x.f.u1.id]);
}
async function payableBatch(n:number){
 const payments:Array<{supplierId:string;invoiceAllocations:Array<{invoiceId:string;amount:number}>}>=[];
 for(let i=0;i<n;i++){
  const {supplier}=await seedReleaseSupplier(x.pool,x.f,actor),invoice=randomUUID();
  await x.pool.query("INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,subtotal,tax_amount,total_amount,amount_paid,status,created_by) VALUES($1,$2,$3,$4,'2026-09-15',100,0,100,0,'approved',$5)",[invoice,x.f.companyA,supplier,invoice.slice(0,20),x.f.u1.id]);
  await x.pool.query("INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,line_total,tax_amount) VALUES($1,'Synthetic batch line',1,100,100,0)",[invoice]);
  const posted=await x.rest('POST','/api/accounting/supplier-invoices-bulk-action',{action:'post_gl',invoiceIds:[invoice]});
  expect(posted.status,JSON.stringify(posted.body).slice(0,300)).toBe(200);
  payments.push({supplierId:supplier,invoiceAllocations:[{invoiceId:invoice,amount:100}]});
 }
 return payments;
}

it.each([
 ['bulk_finalize_invoices',MAX_FINALIZED_INVOICES_PER_REQUEST,()=>seed.customerInvoices(MAX_FINALIZED_INVOICES_PER_REQUEST+1),(ids:string[])=>({invoice_ids:ids})],
 ['bulk_approve_supplier_invoices',MAX_POSTED_DOCUMENTS_PER_REQUEST,()=>seed.supplierInvoices(MAX_POSTED_DOCUMENTS_PER_REQUEST+1),(ids:string[])=>({invoice_ids:ids})],
 ['bulk_approve_credit_notes',MAX_POSTED_DOCUMENTS_PER_REQUEST,()=>seed.creditNotes(MAX_POSTED_DOCUMENTS_PER_REQUEST+1),(ids:string[])=>({credit_note_ids:ids})],
 ['bulk_allocate_bank_transactions',MAX_BANK_LINES_PER_REQUEST,()=>seed.bankLines(MAX_BANK_LINES_PER_REQUEST+1),(ids:string[])=>({allocations:seed.allocations(ids)})],
] as const)('%s refuses one element over its maximum of %i, naming it, and writes nothing',async(tool,max,make,args)=>{
 const ids=await make();
 const row=await x.mcp(tool,{...args(ids),idempotency_key:key()});
 expect(refused(row)).toBe(true);
 expect(toolText(row)).toContain(`maximum ${max}`);expect(toolText(row)).toMatch(/split/i);
 const touched=await x.pool.query(`SELECT count(*)::int AS n FROM (
  SELECT id FROM customer_invoices WHERE id=ANY($1::uuid[]) AND status<>'draft' UNION ALL
  SELECT id FROM supplier_invoices WHERE id=ANY($1::uuid[]) AND status<>'pending_approval' UNION ALL
  SELECT id FROM credit_notes WHERE id=ANY($1::uuid[]) AND status<>'draft' UNION ALL
  SELECT id FROM bank_transactions WHERE id=ANY($1::uuid[]) AND status<>'imported') t`,[ids]);
 expect(touched.rows[0].n).toBe(0);
},120000);

it('refuses a reversal range over the maximum and a supplier-invoice bulk action over the maximum, naming each',async()=>{
 await x.pool.query("UPDATE bank_transactions SET transaction_date='2026-09-14' WHERE company_id=$1 AND transaction_date='2026-09-15'",[x.f.companyA]);
 const lines=await seed.bankLines(MAX_BANK_LINES_PER_REQUEST+1);
 for(let i=0;i<lines.length;i+=MAX_BANK_LINES_PER_REQUEST){
  const made=await x.mcp('bulk_allocate_bank_transactions',{allocations:seed.allocations(lines.slice(i,i+MAX_BANK_LINES_PER_REQUEST)),idempotency_key:key()});
  expect(refused(made),toolText(made)).toBe(false);
 }
 const range=await x.mcp('reverse_allocations',{bank_account_id:seed.seeded.bank,from_date:'2026-09-15',to_date:'2026-09-15',idempotency_key:key()});
 expect(refused(range)).toBe(true);expect(toolText(range)).toContain(`exceeds the ${MAX_BANK_LINES_PER_REQUEST} limit`);
 const bills=await seed.supplierInvoices(MAX_POSTED_DOCUMENTS_PER_REQUEST+1);
 const rest=await x.rest('POST','/api/accounting/supplier-invoices-bulk-action',{action:'approve',invoiceIds:bills});
 expect(rest.status).toBe(400);
 expect(JSON.stringify(rest.body)).toContain(`At most ${MAX_POSTED_DOCUMENTS_PER_REQUEST} invoices per request`);
 expect((await x.pool.query("SELECT count(*)::int AS n FROM supplier_invoices WHERE id=ANY($1::uuid[]) AND status<>'pending_approval'",[bills])).rows[0].n).toBe(0);
},120000);

it('answers ONE 503 in about 5 s, not one 5 s failure per item, when the bulk action route finds the key held',async()=>{
 const bills=await seed.supplierInvoices(MAX_POSTED_DOCUMENTS_PER_REQUEST);
 const holder=await x.pool.connect();
 try{
  await holder.query('BEGIN');
  await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('control-authority:'||$1::text,0))",[x.f.companyA]);
  const row=await x.rest('POST','/api/accounting/supplier-invoices-bulk-action',{action:'approve',invoiceIds:bills});
  expect(row.status,JSON.stringify(row.body)).toBe(503);
  expect(row.retryAfter).toMatch(/^\d+$/);
  expect(row.ms).toBeGreaterThanOrEqual(4500);expect(row.ms).toBeLessThan(9000);
 }finally{await holder.query('ROLLBACK');holder.release();}
 expect((await x.pool.query("SELECT count(*)::int AS n FROM supplier_invoices WHERE id=ANY($1::uuid[]) AND status<>'pending_approval'",[bills])).rows[0].n).toBe(0);
},30000);

it('refuses a payment batch over the maximum at creation, naming it, and creates nothing',async()=>{
 const payments=await payableBatch(MAX_BATCH_PAYMENTS_PER_BATCH+1);
 const before=(await x.pool.query('SELECT count(*)::int AS n FROM supplier_payment_batches WHERE company_id=$1',[x.f.companyA])).rows[0].n;
 const row=await x.rest('POST','/api/accounting/batch-payments',{payments,bankAccountId:seed.seeded.bank,paymentMethod:'eft',batchDate:'2026-09-15'});
 expect(row.status).toBe(400);
 expect(JSON.stringify(row.body)).toContain(`Batch requires 1 to ${MAX_BATCH_PAYMENTS_PER_BATCH} payments`);
 expect((await x.pool.query('SELECT count(*)::int AS n FROM supplier_payment_batches WHERE company_id=$1',[x.f.companyA])).rows[0].n).toBe(before);
},120000);

it('runs due recurring invoices in bounded rounds: each round generates at most the maximum and says whether more remain',async()=>{
 await dueTemplates(MAX_RECURRING_INVOICES_PER_RUN+1);
 const first=await x.rest('POST','/api/accounting/recurring-invoices-run',{});
 expect(first.status,JSON.stringify(first.body).slice(0,300)).toBe(200);
 expect((first.body as {data:{generated:number;remaining?:boolean;errors:string[]}}).data).toMatchObject({generated:MAX_RECURRING_INVOICES_PER_RUN,remaining:true,errors:[]});
 const second=await x.rest('POST','/api/accounting/recurring-invoices-run',{});
 expect((second.body as {data:{generated:number;remaining?:boolean}}).data).toMatchObject({generated:1});
 expect((second.body as {data:{remaining?:boolean}}).data.remaining).not.toBe(true);
},120000);

async function whileBatch(batch:()=>Promise<Timed>){
 const running=heldWhile(x,sampler,batch);
 await new Promise(resolve=>setTimeout(resolve,200));
 const read=await x.rest('GET','/api/accounting/control-approvals',{},'u2');
 return{read,...await running};
}
it.each([
 ['bulk_finalize_invoices',async()=>{const ids=await seed.customerInvoices(MAX_FINALIZED_INVOICES_PER_REQUEST);return()=>x.mcp('bulk_finalize_invoices',{invoice_ids:ids,idempotency_key:key()});}],
 ['bulk_approve_supplier_invoices',async()=>{const ids=await seed.supplierInvoices(MAX_POSTED_DOCUMENTS_PER_REQUEST);return()=>x.mcp('bulk_approve_supplier_invoices',{invoice_ids:ids,idempotency_key:key()});}],
 ['bulk_approve_credit_notes',async()=>{const ids=await seed.creditNotes(MAX_POSTED_DOCUMENTS_PER_REQUEST);return()=>x.mcp('bulk_approve_credit_notes',{credit_note_ids:ids,idempotency_key:key()});}],
 ['bulk_allocate_bank_transactions',async()=>{const ids=await seed.bankLines(MAX_BANK_LINES_PER_REQUEST);return()=>x.mcp('bulk_allocate_bank_transactions',{allocations:seed.allocations(ids),idempotency_key:key()});}],
 ['reverse_bank_allocation_batch',async()=>{
  const made=await x.mcp('bulk_allocate_bank_transactions',{allocations:seed.allocations(await seed.bankLines(MAX_BANK_LINES_PER_REQUEST)),idempotency_key:key()});
  expect(refused(made),toolText(made)).toBe(false);
  const batch=/"batch_id":\s*"([0-9a-f-]{36})"/.exec(toolText(made))?.[1]??'';
  return()=>x.mcp('reverse_bank_allocation_batch',{batch_id:batch,idempotency_key:key()});}],
 ['reverse_allocations',async()=>{
  await x.pool.query("UPDATE bank_transactions SET transaction_date='2026-09-14' WHERE company_id=$1 AND transaction_date='2026-09-15'",[x.f.companyA]);
  const made=await x.mcp('bulk_allocate_bank_transactions',{allocations:seed.allocations(await seed.bankLines(MAX_BANK_LINES_PER_REQUEST)),idempotency_key:key()});
  expect(refused(made),toolText(made)).toBe(false);
  return()=>x.mcp('reverse_allocations',{bank_account_id:seed.seeded.bank,from_date:'2026-09-15',to_date:'2026-09-15',idempotency_key:key()});}],
 ['REST supplier-invoices-bulk-action approve',async()=>{const ids=await seed.supplierInvoices(MAX_POSTED_DOCUMENTS_PER_REQUEST);
  return()=>x.rest('POST','/api/accounting/supplier-invoices-bulk-action',{action:'approve',invoiceIds:ids});}],
 ['REST recurring-invoices-run round',async()=>{await dueTemplates(MAX_RECURRING_INVOICES_PER_RUN);return()=>x.rest('POST','/api/accounting/recurring-invoices-run',{});}],
 ['REST batch-payments process',async()=>{
  const payments=await payableBatch(MAX_BATCH_PAYMENTS_PER_BATCH);
  const created=await x.rest('POST','/api/accounting/batch-payments',{payments,bankAccountId:seed.seeded.bank,paymentMethod:'eft',batchDate:'2026-09-15'});
  expect(created.status,JSON.stringify(created.body).slice(0,300)).toBe(200);const id=(created.body as {data:{id:string}}).data.id;
  const approved=await x.rest('POST','/api/accounting/batch-payments-action',{action:'approve',id},'u2');expect(approved.status,JSON.stringify(approved.body).slice(0,300)).toBe(200);
  return()=>x.rest('POST','/api/accounting/batch-payments-action',{action:'process',id});}],
] as const)('a maximum-size %s batch completes while another person is served',async(label,prepare)=>{
 const count=label==='bulk_finalize_invoices'?MAX_FINALIZED_INVOICES_PER_REQUEST:/recurring/.test(label)?MAX_RECURRING_INVOICES_PER_RUN:/batch-payments/.test(label)?null
  :/bank|allocations/.test(label)?MAX_BANK_LINES_PER_REQUEST:MAX_POSTED_DOCUMENTS_PER_REQUEST;
 const {read,holdMs,row}=await whileBatch(await prepare());
 expect(refused(row),JSON.stringify(row.body).slice(0,400)).toBe(false);
 // Every element was really processed: the posted/reversed/approved count is the full batch.
 const text=toolText(row)||JSON.stringify(row.body);
 if(count!==null)expect(text).toMatch(new RegExp(`"(posted|reversed|succeeded|generated)":${count}[,}]`));
 expect(read.status,`another person's read waited ${read.ms} ms behind a ${holdMs} ms hold`).toBe(200);
 expect(read.ms).toBeLessThan(5000);
 expect(holdMs,'the batch held the company authority key past half its bound').toBeLessThan(2500);
},120000);

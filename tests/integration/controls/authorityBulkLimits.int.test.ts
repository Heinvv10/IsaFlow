import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {authorityLockFixture,type Timed} from './authorityLockFixture';
import {heldWhile,refused,seedBulkPaths,toolText} from './authorityBulkSeed';
import {MAX_BANK_LINES_PER_REQUEST,MAX_FINALIZED_INVOICES_PER_REQUEST,MAX_POSTED_DOCUMENTS_PER_REQUEST} from '@/lib/limits/authorityHoldLimits';
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
},60000);

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
},60000);

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
] as const)('a maximum-size %s batch completes while another person is served',async(label,prepare)=>{
 const count=label==='bulk_finalize_invoices'?MAX_FINALIZED_INVOICES_PER_REQUEST:/bank|allocations/.test(label)?MAX_BANK_LINES_PER_REQUEST:MAX_POSTED_DOCUMENTS_PER_REQUEST;
 const {read,holdMs,row}=await whileBatch(await prepare());
 expect(refused(row),JSON.stringify(row.body).slice(0,400)).toBe(false);
 // Every element was really processed: the posted/reversed/approved count is the full batch.
 const text=toolText(row)||JSON.stringify(row.body);
 expect(text).toMatch(new RegExp(`"(posted|reversed|succeeded)":${count}[,}]`));
 expect(read.status,`another person's read waited ${read.ms} ms behind a ${holdMs} ms hold`).toBe(200);
 expect(read.ms).toBeLessThan(5000);
 expect(holdMs,'the batch held the company authority key past half its bound').toBeLessThan(2500);
},60000);

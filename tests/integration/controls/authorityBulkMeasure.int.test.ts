import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import type {PoolClient} from 'pg';
import {authorityLockFixture,type Timed} from './authorityLockFixture';
import {heldWhile,refused,seedBulkPaths,toolText} from './authorityBulkSeed';
// The invoice PDF is really rendered and its evidence row really written; only the object-storage upload (a network
// call in production, not reachable from the fixture) is replaced, so finalize holds are a lower bound by that call.
vi.mock('@/lib/supabaseStorage',async importOriginal=>({...await importOriginal<typeof import('@/lib/supabaseStorage')>(),
 uploadCustomerInvoicePdf:async(companyId:string,documentId:string)=>({bucket:'customer-invoices',path:`${companyId}/${documentId}.pdf`})}));
/**
 * Opt-in measurement, not a gate: the company authority key hold of every bulk path that runs many elements in one
 * request transaction, at 1 and at 10 elements, so a per-element cost and a fixed cost can be read off. Set
 * ISAFLOW_MEASURE_AUTHORITY_BULK to a JSON output path to run it (ISAFLOW_MEASURE_AUTHORITY_BULK_ONLY=<labels> for a
 * subset). src/lib/limits/authorityHoldLimits.ts is set from its output.
 */
const out=process.env.ISAFLOW_MEASURE_AUTHORITY_BULK;
let x:Awaited<ReturnType<typeof authorityLockFixture>>,sampler:PoolClient,seed:Awaited<ReturnType<typeof seedBulkPaths>>;
beforeAll(async()=>{if(!out)return;x=await authorityLockFixture();sampler=await x.pool.connect();seed=await seedBulkPaths(x);},120000);
afterAll(async()=>{if(!out)return;sampler?.release();if(x)await x.close();});
const key=()=>randomUUID();
/** Each path: prepare n fresh elements, then one request over them. */
const paths:Record<string,(n:number)=>Promise<()=>Promise<Timed>>>={
 bulk_finalize_invoices:async n=>{const ids=await seed.customerInvoices(n);return()=>x.mcp('bulk_finalize_invoices',{invoice_ids:ids,idempotency_key:key()});},
 bulk_approve_supplier_invoices:async n=>{const ids=await seed.supplierInvoices(n);return()=>x.mcp('bulk_approve_supplier_invoices',{invoice_ids:ids,idempotency_key:key()});},
 bulk_approve_credit_notes:async n=>{const ids=await seed.creditNotes(n);return()=>x.mcp('bulk_approve_credit_notes',{credit_note_ids:ids,idempotency_key:key()});},
 bulk_allocate_bank_transactions:async n=>{const ids=await seed.bankLines(n);return()=>x.mcp('bulk_allocate_bank_transactions',{allocations:seed.allocations(ids),idempotency_key:key()});},
 reverse_bank_allocation_batch:async n=>{
  const made=await x.mcp('bulk_allocate_bank_transactions',{allocations:seed.allocations(await seed.bankLines(n)),idempotency_key:key()});
  const batch=/"batch_id":\s*"([0-9a-f-]{36})"/.exec(toolText(made))?.[1]??'';
  return()=>x.mcp('reverse_bank_allocation_batch',{batch_id:batch,idempotency_key:key()});},
 reverse_allocations:async n=>{
  // The range holds exactly this run's n freshly allocated lines: earlier lines on the day move off it first.
  await x.pool.query("UPDATE bank_transactions SET transaction_date='2026-09-14' WHERE company_id=$1 AND transaction_date='2026-09-15'",[x.f.companyA]);
  const made=await x.mcp('bulk_allocate_bank_transactions',{allocations:seed.allocations(await seed.bankLines(n)),idempotency_key:key()});
  if(refused(made))throw new Error(`Allocation for the reversal range failed: ${toolText(made).slice(0,300)}`);
  return()=>x.mcp('reverse_allocations',{bank_account_id:seed.seeded.bank,from_date:'2026-09-15',to_date:'2026-09-15',idempotency_key:key()});},
 bulk_create_customer_invoices:async n=>()=>x.mcp('bulk_create_customer_invoices',{invoices:Array.from({length:n},()=>({customer_id:seed.seeded.customer,invoice_date:'2026-09-15',items:[{description:'Synthetic',unit_price:100,quantity:1}]})),idempotency_key:key()}),
 bulk_create_supplier_invoices:async n=>()=>x.mcp('bulk_create_supplier_invoices',{invoices:Array.from({length:n},()=>({supplier_id:seed.seeded.supplier,invoice_number:randomUUID().slice(0,20),invoice_date:'2026-09-15',lines:[{description:'Synthetic',quantity:1,unit_price:100,gl_account_id:seed.seeded.expense}]})),idempotency_key:key()}),
 'bulk_create_customer_invoices (200 lines each)':async n=>()=>x.mcp('bulk_create_customer_invoices',{invoices:Array.from({length:n},()=>({customer_id:seed.seeded.customer,invoice_date:'2026-09-15',items:Array.from({length:200},(_,i)=>({description:`Synthetic ${i}`,unit_price:1,quantity:1}))})),idempotency_key:key()}),
 'bulk_create_supplier_invoices (200 lines each)':async n=>()=>x.mcp('bulk_create_supplier_invoices',{invoices:Array.from({length:n},()=>({supplier_id:seed.seeded.supplier,invoice_number:randomUUID().slice(0,20),invoice_date:'2026-09-15',lines:Array.from({length:200},(_,i)=>({description:`Synthetic ${i}`,quantity:1,unit_price:1,gl_account_id:seed.seeded.expense}))})),idempotency_key:key()}),
 'REST supplier-invoices-bulk-action approve':async n=>{const ids=await seed.supplierInvoices(n);return()=>x.rest('POST','/api/accounting/supplier-invoices-bulk-action',{action:'approve',invoiceIds:ids});},
};

it.skipIf(!out)('measures the authority key hold of every bulk path at 1 and 10 elements',async()=>{
 const result:Record<string,unknown>={},only=process.env.ISAFLOW_MEASURE_AUTHORITY_BULK_ONLY?.split(',');
 for(const [label,prepare] of Object.entries(paths).filter(([label])=>!only||only.includes(label))){
  const rows:Array<{n:number;holdMs:number;requestMs:number;refused:boolean;body:string}>=[];
  for(const n of [1,1,10,10,10]){
   const run=await prepare(n);const {holdMs,row}=await heldWhile(x,sampler,run);
   rows.push({n,holdMs,requestMs:row.ms,refused:refused(row),body:JSON.stringify(row.body).slice(0,240)});
  }
  const at=(n:number)=>Math.max(...rows.filter(r=>r.n===n).map(r=>r.holdMs));
  const perElement=(at(10)-at(1))/9,fixed=Math.max(0,at(1)-perElement);
  result[label]={runs:rows,perElementMs:Math.round(perElement*10)/10,fixedMs:Math.round(fixed),
   maxFor2500ms:perElement>0?Math.floor((2500-fixed)/perElement):null};
  writeFileSync(out!,JSON.stringify(result,null,1));
 }
 expect(Object.keys(result).length).toBeGreaterThan(0);
},900000);

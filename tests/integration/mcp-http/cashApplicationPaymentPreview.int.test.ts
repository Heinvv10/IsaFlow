import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {auditDeliveryFixture} from './auditDeliveryFixture';
import type {RpcReply} from './client';
/**
 * Applying an existing payment executes only against a prepared, independently
 * approved cash application intent (cashApplicationLegacyAdapter.ts), which this
 * connector cannot prepare yet. The preview must say so up front instead of
 * previewing a success the live call cannot deliver.
 */
let f:Awaited<ReturnType<typeof auditDeliveryFixture>>;
const text=(reply:RpcReply)=>reply.result?.content?.map(item=>item.text).join('\n')??'';
beforeAll(async()=>{f=await auditDeliveryFixture();},30000);afterAll(async()=>{if(f)await f.close();});
it('refuses a payment_id preview with the reason the live call gives',async()=>{
 const token=await f.scopedToken(['write:invoices','write:post','write:bank-tx']);
 for(const tool of ['apply_receipt_to_invoice','apply_payment_to_supplier_invoice']){
  const reply=await f.rpcToken(token,tool,{payment_id:randomUUID(),allocations:[{invoice_id:randomUUID(),amount:10}],dry_run:true,idempotency_key:randomUUID()});
  expect(reply.result?.isError,`${tool}: ${text(reply)}`).toBe(true);
  expect(text(reply),tool).toMatch(/prepared cash application intent and independent approval are required/i);
 }
},60000);
it('refuses the live payment_id call up front with the same reason, before any lock or plan read',async()=>{
 const token=await f.scopedToken(['write:invoices','write:post','write:bank-tx']);
 for(const tool of ['apply_receipt_to_invoice','apply_payment_to_supplier_invoice']){
  const reply=await f.rpcToken(token,tool,{payment_id:randomUUID(),allocations:[{invoice_id:randomUUID(),amount:10}],idempotency_key:randomUUID()});
  expect(reply.result?.isError,`${tool}: ${text(reply)}`).toBe(true);
  expect(text(reply),tool).toMatch(/prepared cash application intent and independent approval are required/i);
 }
},60000);

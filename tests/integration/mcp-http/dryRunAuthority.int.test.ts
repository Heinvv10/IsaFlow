import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {auditDeliveryFixture} from './auditDeliveryFixture';
import type {RpcReply} from './client';
/**
 * A dry run must run every authority guard the live path runs and skip only the
 * write. Each case sends identical arguments twice: once without the permission
 * the live path asserts, once with it. Without it the refusal is the registry's
 * generic text, which is what a guard rejection looks like; with it the call
 * reaches the domain and answers about the (absent) rows instead.
 */
const GENERIC='The operation failed. Please try again or contact support.';
const ID=()=>randomUUID();
let f:Awaited<ReturnType<typeof auditDeliveryFixture>>;
beforeAll(async()=>{f=await auditDeliveryFixture();},30000);afterAll(async()=>{if(f)await f.close();});
const text=(reply:RpcReply)=>reply.result?.content?.map(item=>item.text).join('\n')??'';
const cases:Array<{tool:string;args:Record<string,unknown>;granted:string[];missing:string}>=[
 {tool:'apply_payment_to_supplier_invoice',args:{bank_transaction_id:ID(),allocations:[{invoice_id:ID(),amount:100}]},
  granted:['write:invoices','write:post'],missing:'write:bank-tx'},
 {tool:'apply_receipt_to_invoice',args:{bank_transaction_id:ID(),allocations:[{invoice_id:ID(),amount:100}]},
  granted:['write:invoices','write:post'],missing:'write:bank-tx'},
 {tool:'settle_by_contra',args:{subledger:'ar',document_id:ID(),contra_account_id:ID(),amount:100,reason:'Synthetic contra'},
  granted:['write:invoices','write:post'],missing:'write:bank-tx'},
 {tool:'close_fiscal_period',args:{fiscal_period_id:ID()},granted:['write:journals','write:post','read:reports'],missing:'write:locks'},
 {tool:'reopen_fiscal_period',args:{fiscal_period_id:ID()},granted:['write:journals','write:post','read:reports'],missing:'write:locks'},
 {tool:'year_end_close',args:{fiscal_year:2031},granted:['write:journals','write:post','read:reports'],missing:'write:locks'},
];
it('refuses every dry run that lacks the authority its live path asserts',async()=>{
 const outcomes:string[]=[];
 for(const row of cases){
  const call=async(scopes:string[])=>text(await f.rpcToken(await f.scopedToken(scopes),row.tool,{...row.args,dry_run:true,idempotency_key:randomUUID()}));
  const withoutIt=await call(row.granted),withIt=await call([...row.granted,row.missing]);
  outcomes.push(`${row.tool} without ${row.missing}: ${withoutIt===GENERIC?'refused':`previewed (${withoutIt.slice(0,80)})`}`);
  outcomes.push(`${row.tool} with ${row.missing}: ${withIt===GENERIC?'refused':'reached the domain'}`);
 }
 expect(outcomes).toEqual(cases.flatMap(row=>[`${row.tool} without ${row.missing}: refused`,`${row.tool} with ${row.missing}: reached the domain`]));
},180000);

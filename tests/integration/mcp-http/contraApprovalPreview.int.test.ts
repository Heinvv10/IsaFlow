import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {auditDeliveryFixture} from './auditDeliveryFixture';
import {seedApAccounts} from '../controls/apSyntheticAccounts';
import type {RpcReply} from './client';
/**
 * Under a company payment approval policy the live contra settlement is refused
 * by customer_payment.confirm (AR) or supplier_payment.process (AP). The preview
 * must refuse too, and the live refusal must say what to do about it.
 */
let f:Awaited<ReturnType<typeof auditDeliveryFixture>>,bill:string,invoice:string,contra:string;
const text=(reply:RpcReply)=>reply.result?.content?.map(item=>item.text).join('\n')??'';
beforeAll(async()=>{
 f=await auditDeliveryFixture();
 const company=f.fixture.companyA,supplier=randomUUID(),customer=randomUUID();
 await seedApAccounts(f.pool,company);
 await f.pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,level,is_active,is_system_account) VALUES($1,$2,left($1::uuid::text,12),'Synthetic receivable','asset','receivable','debit',3,true,true)",[randomUUID(),company]);
 contra=randomUUID();bill=randomUUID();invoice=randomUUID();
 await f.pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,level,is_active) VALUES($1,$2,left($1::uuid::text,20),'Synthetic approval contra','asset','other','debit',3,true)",[contra,company]);
 await f.pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic approval supplier')",[supplier,company]);
 await f.pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'Synthetic approval customer')",[customer,company]);
 await f.pool.query("INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,total_amount,amount_paid,status,created_by) VALUES($1,$2,$3,'SI-CONTRA-APPROVAL',CURRENT_DATE,100,0,'approved',$4)",[bill,company,supplier,f.fixture.u1.id]);
 await f.pool.query("INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,subtotal,total_amount,amount_paid,status,created_by) VALUES($1,$2,'CI-CONTRA-APPROVAL',$3,100,100,0,'approved',$4)",[invoice,company,customer,f.fixture.u1.id]);
 await f.pool.query("INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role) VALUES($1,$2,'Synthetic contra payment policy','payment','amount','any',0,'admin')",[randomUUID(),company]);
},60000);
afterAll(async()=>{if(f)await f.close();});
it('refuses both contra previews under a payment approval policy, naming what to request',async()=>{
 const token=await f.scopedToken(['write:invoices','write:post','write:bank-tx']);
 const outcomes:string[]=[];
 for(const [subledger,document] of [['ap',bill],['ar',invoice]] as const){
  const reply=await f.rpcToken(token,'settle_by_contra',{subledger,document_id:document,contra_account_id:contra,amount:40,reason:'Synthetic approval contra',dry_run:true,idempotency_key:randomUUID()});
  outcomes.push(`${subledger}: ${reply.result?.isError?(/request_operation_approval/.test(text(reply))?'refused, names the request':`refused (${text(reply).slice(0,60)})`):'previewed'}`);
 }
 expect(outcomes).toEqual(['ap: refused, names the request','ar: refused, names the request']);
},90000);
it('answers the live approval refusal with what to request instead of "the operation failed"',async()=>{
 const reply=await f.rpcToken(await f.scopedToken(['write:invoices','write:post','write:bank-tx']),'settle_by_contra',
  {subledger:'ap',document_id:bill,contra_account_id:contra,amount:40,reason:'Synthetic approval contra',idempotency_key:randomUUID()});
 expect(reply.result?.isError,text(reply)).toBe(true);
 expect(text(reply)).toMatch(/request_operation_approval/);
},60000);

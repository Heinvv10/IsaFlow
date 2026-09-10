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
 await f.pool.query("INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role) VALUES($1,$2,'Synthetic contra payment policy','payment','amount','greater_than',50,'admin')",[randomUUID(),company]);
},60000);
afterAll(async()=>{if(f)await f.close();});
const settle=(subledger:'ap'|'ar',amount:number,dry:boolean)=>({subledger,document_id:subledger==='ap'?bill:invoice,contra_account_id:contra,amount,
 reason:'Synthetic approval contra',...(dry?{dry_run:true}:{}),idempotency_key:randomUUID()});
it('asks the policy question with the amount the settlement will carry: above the threshold refuses, below previews',async()=>{
 const token=await f.scopedToken(['write:invoices','write:post','write:bank-tx']);
 const outcomes:string[]=[];
 for(const [subledger,amount] of [['ap',60],['ap',40],['ar',60]] as const){
  const reply=await f.rpcToken(token,'settle_by_contra',settle(subledger,amount,true));
  outcomes.push(`${subledger} ${amount}: ${reply.result?.isError?(/cannot carry/i.test(text(reply))?'refused, says it cannot carry an approval':`refused (${text(reply).slice(0,60)})`):'previewed'}`);
 }
 expect(outcomes).toEqual(['ap 60: refused, says it cannot carry an approval','ap 40: previewed','ar 60: refused, says it cannot carry an approval']);
},90000);
it('answers the live approval refusal plainly and rolls back the draft payment it wrote',async()=>{
 const payments=async()=>Number((await f.pool.query<{n:number}>('SELECT count(*)::int AS n FROM supplier_payments WHERE company_id=$1',[f.fixture.companyA])).rows[0]!.n);
 const before=await payments();
 const reply=await f.rpcToken(await f.scopedToken(['write:invoices','write:post','write:bank-tx']),'settle_by_contra',settle('ap',60,false));
 expect(reply.result?.isError,text(reply)).toBe(true);
 expect(text(reply)).toMatch(/cannot carry/i);
 expect(text(reply)).not.toMatch(/then retry/i);
 expect(await payments(),'the draft supplier payment was rolled back').toBe(before);
},60000);

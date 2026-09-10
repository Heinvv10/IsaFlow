import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {auditDeliveryFixture} from './auditDeliveryFixture';
import {seedApAccounts} from '../controls/apSyntheticAccounts';
import type {RpcReply} from './client';
/** An AP contra settles a supplier invoice against a balance-sheet account. Its authority is write:bank-tx. */
const GENERIC='The operation failed. Please try again or contact support.';
let f:Awaited<ReturnType<typeof auditDeliveryFixture>>,invoice:string,contra:string;
const text=(reply:RpcReply)=>reply.result?.content?.map(item=>item.text).join('\n')??'';
const count=async(query:string,params:unknown[])=>Number((await f.pool.query<{n:number}>(query,params)).rows[0]!.n);
const settlement=()=>({subledger:'ap',document_id:invoice,contra_account_id:contra,amount:40,reason:'Synthetic contra settlement'});
beforeAll(async()=>{
 f=await auditDeliveryFixture();
 const company=f.fixture.companyA,supplier=randomUUID();
 await seedApAccounts(f.pool,company);
 contra=randomUUID();
 await f.pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,level,is_active) VALUES($1,$2,left($1::uuid::text,20),'Synthetic contra clearing','asset','other','debit',3,true)",[contra,company]);
 await f.pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic contra supplier')",[supplier,company]);
 invoice=randomUUID();
 await f.pool.query("INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,total_amount,amount_paid,status,created_by) VALUES($1,$2,$3,'SI-CONTRA-1',CURRENT_DATE,100,0,'approved',$4)",[invoice,company,supplier,f.fixture.u1.id]);
},60000);
afterAll(async()=>{if(f)await f.close();});
it('refuses a live AP contra settlement without write:bank-tx and leaves the ledger untouched',async()=>{
 const company=f.fixture.companyA;
 const journals=()=>count('SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1',[company]);
 const before={journals:await journals(),
  payments:await count('SELECT count(*)::int AS n FROM supplier_payments WHERE company_id=$1',[company]),
  paid:await count('SELECT COALESCE(amount_paid,0)::int AS n FROM supplier_invoices WHERE company_id=$1 AND id=$2',[company,invoice])};
 const reply=await f.rpcToken(await f.scopedToken(['write:invoices','write:post']),'settle_by_contra',{...settlement(),idempotency_key:randomUUID()});
 expect(reply.result?.isError,text(reply)).toBe(true);
 expect(await journals()).toBe(before.journals);
 expect(await count('SELECT count(*)::int AS n FROM supplier_payments WHERE company_id=$1',[company])).toBe(before.payments);
 expect(await count(`SELECT count(*)::int AS n FROM payment_allocations pa
  JOIN supplier_payments sp ON sp.id=pa.payment_id WHERE sp.company_id=$1`,[company])).toBe(0);
 expect(await count('SELECT COALESCE(amount_paid,0)::int AS n FROM supplier_invoices WHERE company_id=$1 AND id=$2',[company,invoice])).toBe(before.paid);
},60000);
it('runs that same authority on the AP preview',async()=>{
 const preview=await f.rpcToken(await f.scopedToken(['write:invoices','write:post']),'settle_by_contra',{...settlement(),dry_run:true,idempotency_key:randomUUID()});
 expect(text(preview),'preview without write:bank-tx').toContain('write:bank-tx');
 const allowed=await f.rpcToken(await f.scopedToken(['write:invoices','write:post','write:bank-tx']),'settle_by_contra',{...settlement(),dry_run:true,idempotency_key:randomUUID()});
 expect(text(allowed)).not.toBe(GENERIC);
 expect(text(allowed)).not.toContain('Insufficient scope');
 expect(await count('SELECT count(*)::int AS n FROM supplier_payments WHERE company_id=$1',[f.fixture.companyA])).toBe(0);
},60000);
it('rolls back the payment rows a live AP contra wrote before the kernel refused it',async()=>{
 // Fully authorised caller; the refusal comes AFTER createSupplierPayment and
 // approveSupplierPayment have written, from the payment approval policy on
 // supplier_payment.process. The registry savepoint must unwind both writes.
 const company=f.fixture.companyA;
 await f.pool.query("INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role) VALUES($1,$2,'Synthetic contra payment policy','payment','amount','any',0,'admin')",[randomUUID(),company]);
 const payments=()=>count('SELECT count(*)::int AS n FROM supplier_payments WHERE company_id=$1',[company]);
 const journals=()=>count('SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1',[company]);
 const before={payments:await payments(),journals:await journals()};
 const reply=await f.rpcToken(await f.scopedToken(['write:invoices','write:post','write:bank-tx']),'settle_by_contra',{...settlement(),idempotency_key:randomUUID()});
 expect(reply.result?.isError,text(reply)).toBe(true);
 expect({payments:await payments(),journals:await journals()}).toEqual(before);
 expect(await count('SELECT COALESCE(amount_paid,0)::int AS n FROM supplier_invoices WHERE company_id=$1 AND id=$2',[company,invoice])).toBe(0);
},60000);

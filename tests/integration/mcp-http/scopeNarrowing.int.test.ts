import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {auditDeliveryFixture} from './auditDeliveryFixture';
import {seedApAccounts} from '../controls/apSyntheticAccounts';
import type {RpcReply} from './client';
/**
 * A tool's declared scope must still require every permission its live path
 * needs: no combination of held scopes may preview what the live call refuses,
 * and a refusal that is not about the token's scopes must not say "re-authorise".
 */
let f:Awaited<ReturnType<typeof auditDeliveryFixture>>,invoice:string,contra:string;
const text=(reply:RpcReply)=>reply.result?.content?.map(item=>item.text).join('\n')??'';
beforeAll(async()=>{
 f=await auditDeliveryFixture();
 const company=f.fixture.companyA,supplier=randomUUID();
 await seedApAccounts(f.pool,company);
 contra=randomUUID();invoice=randomUUID();
 await f.pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,level,is_active) VALUES($1,$2,left($1::uuid::text,20),'Synthetic narrowing contra','asset','other','debit',3,true)",[contra,company]);
 await f.pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic narrowing supplier')",[supplier,company]);
 await f.pool.query("INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,total_amount,amount_paid,status,created_by) VALUES($1,$2,$3,'SI-NARROW-1',CURRENT_DATE,100,0,'approved',$4)",[invoice,company,supplier,f.fixture.u1.id]);
},60000);
afterAll(async()=>{if(f)await f.close();});
it('an AP contra preview without write:invoices is refused naming it',async()=>{
 const reply=await f.rpcToken(await f.scopedToken(['write:bank-tx','write:post']),'settle_by_contra',
  {subledger:'ap',document_id:invoice,contra_account_id:contra,amount:40,reason:'Synthetic narrowing',dry_run:true,idempotency_key:randomUUID()});
 expect(reply.result?.isError,text(reply)).toBe(true);
 expect(text(reply)).toContain('write:invoices');
},60000);
it('a year-end preview without write:journals is refused naming it',async()=>{
 const reply=await f.rpcToken(await f.scopedToken(['write:locks','write:post','read:reports']),'year_end_close',
  {fiscal_year:2031,dry_run:true,idempotency_key:randomUUID()});
 expect(reply.result?.isError,text(reply)).toBe(true);
 expect(text(reply)).toContain('write:journals');
},60000);
it('a module override refusal names the owner or admin, not re-authorisation',async()=>{
 const company=f.fixture.companyA,person=f.fixture.u1.id;
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_write) VALUES($1,$2,'banking',false)",[company,person]);
 try{
  const reply=await f.rpcToken(await f.scopedToken(['write:invoices','write:post','write:bank-tx']),'apply_receipt_to_invoice',
   {bank_transaction_id:randomUUID(),allocations:[{invoice_id:randomUUID(),amount:10}],dry_run:true,idempotency_key:randomUUID()});
  expect(reply.result?.isError,text(reply)).toBe(true);
  expect(text(reply)).toContain('write:bank-tx');
  expect(text(reply)).not.toMatch(/re-?authoris/i);
  expect(text(reply)).toMatch(/owner or admin/i);
 }finally{await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='banking'",[company,person]);}
},60000);

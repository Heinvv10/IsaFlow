import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {auditDeliveryFixture} from './auditDeliveryFixture';
import type {RpcReply} from './client';
/**
 * A bank allocation is bound to a company payment policy the same way a bill
 * is. Its control intent only exists after the write, so the preview asks the
 * kernel's policy question with the amount it already holds.
 */
let f:Awaited<ReturnType<typeof auditDeliveryFixture>>;
const bankAccount=randomUUID(),contra=randomUUID(),imported=randomUUID(),allocated=randomUUID();
const text=(reply:RpcReply)=>reply.result?.content?.map(item=>item.text).join('\n')??'';
beforeAll(async()=>{
 f=await auditDeliveryFixture();
 const company=f.fixture.companyA;
 await f.pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,level,is_active) VALUES($1,$2,left($1::uuid::text,20),'Synthetic policy bank','asset','bank','debit',3,true)",[bankAccount,company]);
 await f.pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,level,is_active) VALUES($1,$2,left($1::uuid::text,20),'Synthetic policy expense','expense','other','debit',3,true)",[contra,company]);
 await f.pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',-100,'Synthetic policy line','imported')",[imported,company,bankAccount]);
 await f.pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',-100,'Synthetic allocated line','reconciled')",[allocated,company,bankAccount]);
 await f.pool.query("INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role) VALUES($1,$2,'Synthetic payment policy','payment','amount','any',0,'admin')",[randomUUID(),company]);
},60000);
afterAll(async()=>{if(f)await f.close();});
it('does not preview an allocation or a reversal the payment policy would refuse',async()=>{
 const token=await f.scopedToken(['write:bank-tx','write:post']);
 const allocation={transaction_id:imported,contra_account_id:contra};
 const preview=await f.rpcToken(token,'bulk_allocate_bank_transactions',{allocations:[allocation],dry_run:true,idempotency_key:randomUUID()});
 const previewed=JSON.parse(text(preview)) as {would_post:number;skipped:Array<{reason:string}>};
 const live=await f.rpcToken(token,'bulk_allocate_bank_transactions',{allocations:[allocation],idempotency_key:randomUUID()});
 expect({wouldPost:previewed.would_post,reasons:previewed.skipped.map(row=>/approval/i.test(row.reason))},text(preview))
  .toEqual({wouldPost:0,reasons:[true]});
 expect(live.result?.isError,text(live)).toBe(true);
 expect(Number((await f.pool.query<{n:number}>("SELECT count(*)::int AS n FROM bank_transactions WHERE company_id=$1 AND id=$2 AND status='imported'",[f.fixture.companyA,imported])).rows[0]!.n)).toBe(1);
 const reversal=await f.rpcToken(token,'reverse_allocations',{bank_account_id:bankAccount,from_date:'2026-09-01',to_date:'2026-09-30',dry_run:true,idempotency_key:randomUUID()});
 expect(reversal.result?.isError,text(reversal)).toBe(true);
 expect(text(reversal)).toMatch(/approval/i);
},180000);

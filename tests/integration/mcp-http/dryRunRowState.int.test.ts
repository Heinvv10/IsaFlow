import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {auditDeliveryFixture} from './auditDeliveryFixture';
import {seedApAccounts} from '../controls/apSyntheticAccounts';
import type {RpcReply} from './client';
/**
 * A dry run must run every row-state guard the live path runs. An operation
 * whose company policy demands an independent approval is refused live, so the
 * preview must not report it as one that would post.
 */
let f:Awaited<ReturnType<typeof auditDeliveryFixture>>,invoice:string,token:string;
const text=(reply:RpcReply)=>reply.result?.content?.map(item=>item.text).join('\n')??'';
beforeAll(async()=>{
 f=await auditDeliveryFixture();
 const company=f.fixture.companyA,supplier=randomUUID();
 await seedApAccounts(f.pool,company);
 await f.pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic approval supplier')",[supplier,company]);
 await f.pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic approval period',1,2026,'2026-01-01','2026-12-31','open')",[randomUUID(),company]);
 invoice=randomUUID();
 await f.pool.query("INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,total_amount,amount_paid,status,created_by) VALUES($1,$2,$3,'SI-APPROVAL-1',CURRENT_DATE,100,0,'pending_approval',$4)",[invoice,company,supplier,f.fixture.u1.id]);
 await f.pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role)
  VALUES($1,$2,'Synthetic approval policy','supplier_invoice','amount','any',0,'admin')`,[randomUUID(),company]);
 token=await f.scopedToken(['write:invoices','write:post']);
},60000);
afterAll(async()=>{if(f)await f.close();});
it('does not preview an approval-bound bill as one that would post',async()=>{
 const preview=await f.rpcToken(token,'bulk_approve_supplier_invoices',{invoice_ids:[invoice],dry_run:true,idempotency_key:randomUUID()});
 const previewed=JSON.parse(text(preview)) as {would_post:number;would_post_ids:string[];skipped:Array<{document_id:string;reason:string}>};
 const live=await f.rpcToken(token,'bulk_approve_supplier_invoices',{invoice_ids:[invoice],idempotency_key:randomUUID()});
 const status=(await f.pool.query<{status:string}>('SELECT status FROM supplier_invoices WHERE company_id=$1 AND id=$2',[f.fixture.companyA,invoice])).rows[0]!.status;
 expect({live:live.result?.isError===true,status},text(live)).toEqual({live:true,status:'pending_approval'});
 expect({wouldPost:previewed.would_post,ids:previewed.would_post_ids}).toEqual({wouldPost:0,ids:[]});
 expect(previewed.skipped.map(row=>row.document_id)).toEqual([invoice]);
 expect(previewed.skipped[0]!.reason).toMatch(/approval/i);
},120000);

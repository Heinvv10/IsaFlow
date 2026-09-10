import {beforeAll,afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {arCiFixture} from './arCiFixture';
import {postCustomerInvoiceToGL} from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import {approveCustomerInvoice} from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
let f:Awaited<ReturnType<typeof arCiFixture>>;
beforeAll(async()=>{f=await arCiFixture();},30000);afterAll(async()=>{if(f)await f.close();});
async function withInvoicePolicy(fn:()=>Promise<void>){const id=randomUUID();await f.pool.query("INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,approver_role) VALUES($1,$2,'AR CI independent invoice','customer_invoice','amount','any','admin')",[id,f.f.companyA]);try{await fn();}finally{await f.pool.query('DELETE FROM approval_rules WHERE company_id=$1 AND id=$2',[f.f.companyA,id]);}}
const ref=(entityId:string)=>({entityType:'customer_invoice',entityId,operation:'customer_invoice.post' as const});
it('legacy wrapper posts one parent-controlled journal on actual invoice date and links/retries exactly once',async()=>{
 const id=await f.invoice(),journal=await f.actor(()=>postCustomerInvoiceToGL(f.f.companyA,id,f.f.u1.id));
 expect(await f.actor(()=>postCustomerInvoiceToGL(f.f.companyA,id,f.f.u1.id))).toBe(journal);
 const row=(await f.pool.query('SELECT status,entry_date::text,posting_agent,fiscal_period_id FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[f.f.companyA,journal])).rows[0];
 expect(row).toMatchObject({status:'posted',entry_date:'2026-07-05',posting_agent:`human:${f.f.u1.id}`});
 expect((await f.pool.query('SELECT gl_journal_entry_id,status FROM customer_invoices WHERE company_id=$1 AND id=$2',[f.f.companyA,id])).rows[0]).toMatchObject({gl_journal_entry_id:journal,status:'approved'});
 const lines=(await f.pool.query('SELECT sum(debit)::text AS debit,sum(credit)::text AS credit FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2',[f.f.companyA,journal])).rows[0];expect(lines).toEqual({debit:'115.00',credit:'115.00'});
 expect((await f.pool.query("SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2 AND operation='customer_invoice.post'",[f.f.companyA,id])).rows).toHaveLength(1);
});
it('closed period and cancelled unlinked invoice refuse with no partial document/journal effects',async()=>{
 const id=await f.invoice();await f.pool.query("UPDATE fiscal_periods SET status='closed' WHERE company_id=$1 AND period_number=7",[f.f.companyA]);
 try{const before=await f.state();await expect(f.actor(()=>postCustomerInvoiceToGL(f.f.companyA,id,f.f.u1.id))).rejects.toThrow(/closed/);expect(await f.state()).toEqual(before);}
 finally{await f.pool.query("UPDATE fiscal_periods SET status='open' WHERE company_id=$1 AND period_number=7",[f.f.companyA]);}
 const cancelled=await f.invoice(100,'cancelled'),before=await f.state();await expect(f.actor(()=>postCustomerInvoiceToGL(f.f.companyA,cancelled,f.f.u1.id))).rejects.toThrow(/cancelled/);expect(await f.state()).toEqual(before);
});
it.each([false,true])('parent approval and wrapper preserve current person provenance (PAT=%s)',async pat=>{
 await withInvoicePolicy(async()=>{const id=await f.invoice(),approvalId=await f.approval(ref(id),pat);
 const opts=pat?{approvalId,postingAgent:'mcp:approve_customer_invoice:v1',actorType:'agent' as const,actorTokenJti:f.f.u1.tokens[0]!.id}:{approvalId};
 const result=await f.actor(()=>approveCustomerInvoice(f.f.companyA,id,f.f.u1.id,opts),'u1',pat);
 const row=(await f.pool.query('SELECT posting_agent,actor_type,actor_token_jti FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[f.f.companyA,result.glJournalEntryId])).rows[0];
 expect(row.posting_agent).toBe(pat?'mcp:approve_customer_invoice:v1':`human:${f.f.u1.id}`);expect(row.actor_token_jti).toBe(pat?f.f.u1.tokens[0]!.id:null);});
});
it('empty wrapper options retain human attribution and actual cookie REST approves with saved approval',async()=>{
 const id=await f.invoice(),journal=await f.actor(()=>postCustomerInvoiceToGL(f.f.companyA,id,f.f.u1.id,{}));expect((await f.pool.query('SELECT posting_agent FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[f.f.companyA,journal])).rows[0].posting_agent).toBe(`human:${f.f.u1.id}`);
 await withInvoicePolicy(async()=>{const restId=await f.invoice(),approvalId=await f.approval(ref(restId));const response=await f.rest({id:restId,action:'approve',approval_id:approvalId});expect(response.status).toBe(200);
 const rows=(await f.pool.query('SELECT j.posting_agent FROM customer_invoices i JOIN gl_journal_entries j ON j.company_id=i.company_id AND j.id=i.gl_journal_entry_id WHERE i.company_id=$1 AND i.id=$2',[f.f.companyA,restId])).rows;
 expect(rows).toEqual([{posting_agent:`human:${f.f.u1.id}`}]);});
});
it('historical boolean remains a refusal and is not mistaken for repaired Sage admin ingress',async()=>{
 const id=await f.invoice(),before=await f.state();await expect(f.actor(()=>postCustomerInvoiceToGL(f.f.companyA,id,f.f.u1.id,{historicalImport:true}))).rejects.toThrow('explicit persisted import authorization');expect(await f.state()).toEqual(before);
});
it('current denied invoice authority and foreign ownership refuse before effects',async()=>{
 const id=await f.invoice(),before=await f.state();await expect(f.actor(()=>postCustomerInvoiceToGL(f.f.companyB,id,f.f.u3.id),'u3')).rejects.toThrow();
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_write) VALUES($1,$2,'invoices',false)",[f.f.companyA,f.f.u1.id]);
 try{await expect(f.actor(()=>postCustomerInvoiceToGL(f.f.companyA,id,f.f.u1.id))).rejects.toThrow('Current permissions');expect(await f.state()).toEqual(before);}
 finally{await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='invoices'",[f.f.companyA,f.f.u1.id]);}
});

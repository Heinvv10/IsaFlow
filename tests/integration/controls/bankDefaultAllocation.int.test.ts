const preparePartyBankAllocation:typeof import('@/modules/accounting/services/bank/bankAllocationDefaultPreparation').preparePartyBankAllocation=async(...args)=>(await import('@/modules/accounting/services/bank/bankAllocationDefaultPreparation')).preparePartyBankAllocation(...args);
import {approveCustomerInvoice} from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import {approveSupplierInvoice} from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import {seedBankAllocationSupplier} from './bankAllocationSupplierFixture';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {prepareBankAllocationReversal,executeBankAllocationReversal} from '@/modules/accounting/services/bank/bankAllocationReversal';
import {prepareBankAllocation,executeBankAllocation} from '@/modules/accounting/services/bank/bankAllocationControl';
import {allocateTransaction} from '@/modules/accounting/services/bank/bankAllocationService';
import {requireControlTx,withControlRequest} from '@/modules/accounting/services/controls/context';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService',()=>({snapshotInvoicePdf:async()=>({documentId:null,wasExisting:false})}));
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
let fixture:ForensicFixture;
const customer=randomUUID(),supplier=randomUUID(),bank=randomUUID(),ar=randomUUID(),ap=randomUUID(),period=randomUUID(),expense=randomUUID();
type Kind='customer'|'supplier';
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);
 await pool.query("INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role) VALUES($1,$2,'Synthetic refund approval','payment','amount','any',0,'admin')",[randomUUID(),fixture.companyA]);
 await pool.query("INSERT INTO customers(id,company_id,name,auto_allocate_strategy) VALUES($1,$2,'Synthetic refund customer','oldest')",[customer,fixture.companyA]);
 await pool.query("INSERT INTO suppliers(id,company_id,name,auto_allocate_strategy) VALUES($1,$2,'Synthetic refund supplier without outbound beneficiary','oldest')",[supplier,fixture.companyA]);
 await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic refund period',9,2026,'2026-09-01','2026-09-30','open')",[period,fixture.companyA]);
 for(const [id,role,type] of [[bank,'bank','asset'],[ar,'receivable','asset'],[ap,'payable','liability'],[expense,'default_expense','expense'],[randomUUID(),'default_revenue','revenue'],[randomUUID(),'vat_input','asset'],[randomUUID(),'vat_output','liability']])await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level) VALUES($1,$2,$3,$4,$5,$4,$6,true,true,3)",[id,fixture.companyA,id!.slice(0,12),role,type,type==='asset'?'debit':'credit']);
 await pool.query("INSERT INTO bank_accounts(company_id,account_name,gl_account_id,currency) VALUES($1,'Synthetic refund bank',$2,'ZAR')",[fixture.companyA,bank]);
});
afterAll(()=>pool.end());
async function actor<T>(fn:()=>Promise<T>,person:'u1'|'u2'|'u3'='u1',token=-1){
 const client=await pool.connect(),user=fixture[person];
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  const claims={sub:user.id,role:'authenticated',company_id:user.companyId};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
  const pat=token>=0?user.tokens[token]!:null;
  const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:pat?'pat':'cookie',...(pat?{connectionId:pat.id,grantId:pat.id,grantedScopes:['write:bank-tx','write:post','write:approvals']}: {})},fn);
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

async function invoice(kind:Kind,party:string,date:string,total='100'){
 const id=randomUUID();
 if(kind==='customer'){
  await pool.query("INSERT INTO customer_invoices(id,company_id,customer_id,invoice_number,invoice_date,subtotal,total_amount,currency_code,exchange_rate,functional_total,created_by) VALUES($1,$2,$3,$1::uuid::text,$4,$5,$5,'ZAR',1,$5,$6)",[id,fixture.companyA,party,date,total,fixture.u1.id]);
  await pool.query("INSERT INTO customer_invoice_items(invoice_id,description,quantity,unit_price,amount,tax_rate) VALUES($1,'Synthetic default allocation',1,$2,$2,0)",[id,total]);
  await actor(()=>approveCustomerInvoice(fixture.companyA,id,fixture.u1.id));
 }else{
  await pool.query("INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,subtotal,total_amount,currency,created_by) VALUES($1,$2,$3,$1::uuid::text,$4,$5,$5,'ZAR',$6)",[id,fixture.companyA,party,date,total,fixture.u1.id]);
  await pool.query("INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,line_total,tax_rate,tax_amount,gl_account_id) VALUES($1,'Synthetic default allocation',1,$2,$2,0,0,$3)",[id,total,expense]);
  await actor(()=>approveSupplierInvoice(fixture.companyA,id,fixture.u1.id));
 }
 return id;
}
async function source(kind:Kind,amount='150.23'){
 const tx=randomUUID();
 const party=kind==='customer'?randomUUID():(await seedBankAllocationSupplier(pool,fixture,(person,fn)=>actor(()=>fn(requireControlTx()),person))).supplier;
 if(kind==='customer')await pool.query("INSERT INTO customers(id,company_id,name,auto_allocate_strategy) VALUES($1,$2,'Synthetic default allocation party','oldest')",[party,fixture.companyA]);
 else await pool.query("UPDATE suppliers SET auto_allocate_strategy='oldest' WHERE company_id=$1 AND id=$2",[fixture.companyA,party]);
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,status) VALUES($1,$2,$3,'2026-09-09',$4,'imported')",[tx,fixture.companyA,bank,kind==='customer'?amount:'-'+amount]);
 return{kind,bankTransactionId:tx,partyId:party};
}
async function payload(intentId:string){return(await pool.query('SELECT payload FROM control_bank_allocation_intents WHERE company_id=$1 AND id=$2',[fixture.companyA,intentId])).rows[0].payload;}
async function approve(operation:Parameters<typeof requestOperationApproval>[1]){
 const row=await actor(()=>requestOperationApproval(requireControlTx(),operation));await actor(()=>decideOperationApproval(requireControlTx(),row.id,'approved'),'u2');return row.id;
}
for(const kind of ['customer','supplier'] as const)it(`${kind}: prepares default oldest applications before approval and executes exact shared adapter`,async()=>{
 const input=await source(kind),old=await invoice(kind,input.partyId,'2026-09-01'),recent=await invoice(kind,input.partyId,'2026-09-08');
 const prepared=await actor(()=>preparePartyBankAllocation(requireControlTx(),input));
 expect((await payload(prepared.intentId)).applications).toEqual([{invoiceId:old,amount:'100'},{invoiceId:recent,amount:'50.23'}]);
 const approvalId=await approve(prepared.operation);
 const results=await Promise.all([1,2].map(()=>actor(()=>allocateTransaction(fixture.companyA,input.bankTransactionId,null,fixture.u1.id,undefined,kind,input.partyId,undefined,undefined,undefined,undefined,undefined,{intentId:prepared.intentId,approvalId}))));
 expect(results[0].journalEntryId).toBe(results[1].journalEntryId);
});

it('newest preserves future invoice eligibility and deterministic created/id tie order',async()=>{
 const input=await source('customer','120'),first=await invoice('customer',input.partyId,'2026-09-12'),second=await invoice('customer',input.partyId,'2026-09-12');
 await pool.query("UPDATE customers SET auto_allocate_strategy='newest' WHERE company_id=$1 AND id=$2",[fixture.companyA,input.partyId]);
 await pool.query("UPDATE customer_invoices SET created_at='2026-09-01T12:00:00Z' WHERE company_id=$1 AND id=ANY($2::uuid[])",[fixture.companyA,[first,second]]);
 const prepared=await actor(()=>preparePartyBankAllocation(requireControlTx(),input)),ids=[first,second].sort().reverse();
 expect((await payload(prepared.intentId)).applications).toEqual([{invoiceId:ids[0],amount:'100'},{invoiceId:ids[1],amount:'20'}]);
});
it('explicit empty applications, autoApply false, off and refunds never auto-select',async()=>{
 for(const mode of ['explicit','disabled','off','refund']){
  const input=await source('customer');await invoice('customer',input.partyId,'2026-09-01');
  if(mode==='off')await pool.query("UPDATE customers SET auto_allocate_strategy='off' WHERE company_id=$1 AND id=$2",[fixture.companyA,input.partyId]);
  if(mode==='refund')await pool.query('UPDATE bank_transactions SET amount=-amount WHERE company_id=$1 AND id=$2',[fixture.companyA,input.bankTransactionId]);
  const p=await actor(()=>preparePartyBankAllocation(requireControlTx(),{...input,...(mode==='explicit'?{applications:[]}:mode==='disabled'?{autoApply:false}:{})}));
  expect((await payload(p.intentId)).applications).toEqual([]);
 }
});
it('new older invoices and changed default strategy do not reselect an approved intent',async()=>{
 const input=await source('customer','100'),chosen=await invoice('customer',input.partyId,'2026-09-05');
 const p=await actor(()=>preparePartyBankAllocation(requireControlTx(),input)),approvalId=await approve(p.operation);
 const later=await invoice('customer',input.partyId,'2026-09-01');
 await pool.query("UPDATE customers SET auto_allocate_strategy='newest' WHERE company_id=$1 AND id=$2",[fixture.companyA,input.partyId]);
 await actor(()=>allocateTransaction(fixture.companyA,input.bankTransactionId,null,fixture.u1.id,undefined,'customer',input.partyId,undefined,undefined,undefined,undefined,undefined,{intentId:p.intentId,approvalId}));
 expect((await pool.query('SELECT id,amount_paid::text FROM customer_invoices WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[fixture.companyA,[chosen,later]])).rows).toEqual([{id:chosen,amount_paid:'100.00'},{id:later,amount_paid:'0.00'}].sort((a,b)=>a.id.localeCompare(b.id)));
});
for(const field of ['balance','date'])it(`changed chosen invoice ${field} invalidates approval`,async()=>{
 const input=await source('customer','100'),chosen=await invoice('customer',input.partyId,'2026-09-05');
 const p=await actor(()=>preparePartyBankAllocation(requireControlTx(),input)),approvalId=await approve(p.operation);
 if(field==='balance')await pool.query('UPDATE customer_invoices SET amount_paid=1 WHERE company_id=$1 AND id=$2',[fixture.companyA,chosen]);
 else await pool.query("UPDATE customer_invoices SET invoice_date='2026-09-06' WHERE company_id=$1 AND id=$2",[fixture.companyA,chosen]);
 await expect(actor(()=>executeBankAllocation(requireControlTx(),p.intentId,{approvalId}))).rejects.toThrow(/source changed/i);
});
it('rejects foreign tenant and revoked current preparation authority',async()=>{
 const input=await source('customer');
 await expect(actor(()=>preparePartyBankAllocation(requireControlTx(),input),'u3')).rejects.toThrow(/owned|not found/i);
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_write) VALUES($1,$2,'banking',false)",[fixture.companyA,fixture.u1.id]);
 try{await expect(actor(()=>preparePartyBankAllocation(requireControlTx(),input))).rejects.toThrow(/permission/i);}
 finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='banking'",[fixture.companyA,fixture.u1.id]);}
});
it('ignores unused candidate overflow but refuses more than100 required applications',async()=>{
 const input=await source('customer','1'),first=await invoice('customer',input.partyId,'2026-09-01','1');
 // Actual owned candidate rows; only first source needs full posted journal proof when cash is exhausted.
 await pool.query("INSERT INTO customer_invoices(id,company_id,customer_id,invoice_number,invoice_date,total_amount,status,created_by) SELECT gen_random_uuid(),$1,$2,'Synthetic overflow '||n,'2026-09-02',1,'approved',$3 FROM generate_series(1,101) n",[fixture.companyA,input.partyId,fixture.u1.id]);
 const p=await actor(()=>preparePartyBankAllocation(requireControlTx(),input));
 expect((await payload(p.intentId)).applications).toEqual([{invoiceId:first,amount:'1'}]);
 await pool.query('UPDATE bank_transactions SET amount=101 WHERE company_id=$1 AND id=$2',[fixture.companyA,input.bankTransactionId]);
 await expect(actor(()=>preparePartyBankAllocation(requireControlTx(),input))).rejects.toThrow(/100.*applications/i);
});

it('existing adapter executes an explicitly prepared approved intent when contact default is enabled',async()=>{
 const input=await source('customer','100'),id=await invoice('customer',input.partyId,'2026-09-01');
 const p=await actor(()=>prepareBankAllocation(requireControlTx(),{version:1,...input,applications:[{invoiceId:id,amount:'100'}]})),approvalId=await approve(p.operation);
 await actor(()=>allocateTransaction(fixture.companyA,input.bankTransactionId,null,fixture.u1.id,undefined,'customer',input.partyId,undefined,undefined,undefined,undefined,undefined,{intentId:p.intentId,approvalId}));
 expect((await pool.query('SELECT amount_paid::text FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,id])).rows[0].amount_paid).toBe('100.00');
});

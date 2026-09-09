import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {prepareBankAllocationReversal,executeBankAllocationReversal} from '@/modules/accounting/services/bank/bankAllocationReversal';
import {prepareBankAllocation,executeBankAllocation} from '@/modules/accounting/services/bank/bankAllocationControl';
import {requireControlTx,withControlRequest} from '@/modules/accounting/services/controls/context';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import {approveCustomerInvoice} from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import {seedApAccounts} from './apSyntheticAccounts';
import {seedBankAllocationSupplier} from './bankAllocationSupplierFixture';
import {approveSupplierInvoice} from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService',()=>({snapshotInvoicePdf:async()=>({documentId:null,wasExisting:false})}));
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});
let fixture:ForensicFixture;let apAccounts:Awaited<ReturnType<typeof seedApAccounts>>;
const customer=randomUUID(),bank=randomUUID(),rule=randomUUID();
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);apAccounts=await seedApAccounts(pool,fixture.companyA);
 await pool.query("INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role) VALUES($1,$2,'Synthetic receipt approval','payment','amount','any',0,'admin')",[rule,fixture.companyA]);

 await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)',[customer,fixture.companyA,'Synthetic allocation customer']);
 await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic allocation September',9,2026,'2026-09-01','2026-09-30','open')",[randomUUID(),fixture.companyA]);
 for(const [id,role] of [[bank,'bank'],[randomUUID(),'receivable']])await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level) VALUES($1,$2,$3,$4,'asset',$4,'debit',true,true,3)",[id,fixture.companyA,id!.slice(0,12),role]);
 for(const [role,type] of [['default_revenue','revenue'],['vat_output','liability']]){const id=randomUUID();await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level) VALUES($1,$2,$3,$4,$5,$4,'credit',true,true,3)",[id,fixture.companyA,id.slice(0,12),role,type]);}
 await pool.query("INSERT INTO bank_accounts(company_id,account_name,gl_account_id,currency) VALUES($1,'Synthetic allocation bank',$2,'ZAR')",[fixture.companyA,bank]);
});
afterAll(async()=>{await pool.end();});
async function actor<T>(fn:()=>Promise<T>,person:'u1'|'u2'='u1',bearer=false){
 const client=await pool.connect(),user=fixture[person];
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  const claims={sub:user.id,role:'authenticated',company_id:fixture.companyA};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),fixture.companyA]);
  const result=await withControlRequest({client,userId:user.id,companyId:fixture.companyA,claims},{personId:user.id,companyId:fixture.companyA,authMethod:bearer?'pat':'cookie',...(bearer?{connectionId:user.tokens[0]!.id,grantId:user.tokens[0]!.id,grantedScopes:['write:bank-tx','write:post','write:approvals']}: {})},fn);
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

type Kind='customer'|'supplier';
async function seed(kind:Kind,amount='115'){
 let invoice:string,party:string;
 if(kind==='customer'){
  invoice=randomUUID();party=customer;
  await pool.query(`INSERT INTO customer_invoices(id,company_id,customer_id,client_id,invoice_number,invoice_date,subtotal,tax_amount,total_amount,currency_code,exchange_rate,functional_total,created_by)
   VALUES($1,$2,$3,$3,$4,'2026-09-09',100,15,115,'ZAR',1,115,$5)`,[invoice,fixture.companyA,customer,invoice,fixture.u1.id]);
  await pool.query("INSERT INTO customer_invoice_items(invoice_id,description,quantity,unit_price,amount,tax_rate) VALUES($1,'Synthetic settlement service',1,100,100,15)",[invoice]);
  await actor(()=>approveCustomerInvoice(fixture.companyA,invoice,fixture.u1.id));
 }else{
  const supplier=await seedBankAllocationSupplier(pool,fixture,(person,fn)=>actor(()=>fn(requireControlTx()),person));invoice=supplier.invoice;party=supplier.supplier;
  await pool.query("UPDATE supplier_invoices SET subtotal=100,tax_rate=15,tax_amount=15,total_amount=115,currency='ZAR' WHERE company_id=$1 AND id=$2",[fixture.companyA,invoice]);
  await pool.query("INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,line_total,tax_rate,tax_amount,gl_account_id) VALUES($1,'Synthetic settlement expense',1,100,100,15,15,$2)",[invoice,apAccounts.default_expense]);
  await actor(()=>approveSupplierInvoice(fixture.companyA,invoice,fixture.u1.id));
 }
 const tx=randomUUID();
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',$4,'Synthetic metadata settlement','imported')",[tx,fixture.companyA,bank,kind==='customer'?amount:`-${amount}`]);
 const prepared=await actor(()=>prepareBankAllocation(requireControlTx(),{version:1,kind,bankTransactionId:tx,partyId:party,applications:[{invoiceId:invoice,amount}]}));
 const approval=await actor(()=>requestOperationApproval(requireControlTx(),prepared.operation));
 await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
 return{invoice,tx,...prepared,approvalId:approval.id};
}
async function metadata(kind:Kind,id:string){
 return(kind==='customer'?await pool.query('SELECT status,amount_paid,paid_at FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,id])
  :await pool.query('SELECT status,amount_paid,paid_at,payment_matched,payment_matched_at FROM supplier_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,id])).rows[0];
}
for(const kind of ['customer','supplier'] as const){
 it(`${kind}: full approved bank settlement derives timestamps and preserves them on retry`,async()=>{
  const prepared=await seed(kind);
  const posted=await actor(()=>executeBankAllocation(requireControlTx(),prepared.intentId,{approvalId:prepared.approvalId}));
  const row=await metadata(kind,prepared.invoice);
  expect(row).toMatchObject({status:'paid',amount_paid:'115.00'});
  expect(row.paid_at).toBeInstanceOf(Date);
  if(kind==='supplier'){expect(row.payment_matched).toBe(true);expect(row.payment_matched_at).toBeInstanceOf(Date);}
  expect(await actor(()=>executeBankAllocation(requireControlTx(),prepared.intentId))).toEqual(posted);
  expect(await metadata(kind,prepared.invoice)).toEqual(row);
 });
 it(`${kind}: approved inverse clears prior settlement metadata and rolls back atomically`,async()=>{
  const prepared=await seed(kind);
  const posted=await actor(()=>executeBankAllocation(requireControlTx(),prepared.intentId,{approvalId:prepared.approvalId}));
  // Model the legitimate pre-existing fully-settled metadata independently of the application regression.
  if(kind==='customer')await pool.query("UPDATE customer_invoices SET paid_at='2026-09-09T12:00:00Z' WHERE company_id=$1 AND id=$2",[fixture.companyA,prepared.invoice]);
  else await pool.query("UPDATE supplier_invoices SET paid_at='2026-09-09T12:00:00Z',payment_matched=true,payment_matched_at='2026-09-09T12:00:00Z' WHERE company_id=$1 AND id=$2",[fixture.companyA,prepared.invoice]);
  const before=await metadata(kind,prepared.invoice);
  const reverse=await actor(()=>prepareBankAllocationReversal(requireControlTx(),{originalIntentId:prepared.intentId,reversalDate:'2026-09-10',reason:'Synthetic metadata inverse'}));
  const approval=await actor(()=>requestOperationApproval(requireControlTx(),reverse.operation));
  await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
  await expect(actor(async()=>{await executeBankAllocationReversal(requireControlTx(),reverse.intentId,{approvalId:approval.id});throw new Error('Synthetic metadata rollback');})).rejects.toThrow('Synthetic metadata rollback');
  expect(await metadata(kind,prepared.invoice)).toEqual(before);
  expect((await pool.query('SELECT status FROM control_operation_approvals WHERE company_id=$1 AND id=$2',[fixture.companyA,approval.id])).rows[0].status).toBe('approved');
  const result=await actor(()=>executeBankAllocationReversal(requireControlTx(),reverse.intentId,{approvalId:approval.id}));
  expect(await metadata(kind,prepared.invoice)).toEqual({status:'approved',amount_paid:'0.00',paid_at:null,...(kind==='supplier'?{payment_matched:false,payment_matched_at:null}:{})});
  expect(await actor(()=>executeBankAllocationReversal(requireControlTx(),reverse.intentId))).toEqual(result);
  const allocations=kind==='customer'?await pool.query('SELECT a.amount_allocated FROM customer_payment_allocations a JOIN customer_payments p ON p.id=a.payment_id WHERE p.company_id=$1 AND p.id=$2',[fixture.companyA,posted.paymentId])
   :await pool.query('SELECT a.amount_allocated FROM payment_allocations a JOIN supplier_payments p ON p.id=a.payment_id WHERE p.company_id=$1 AND p.id=$2',[fixture.companyA,posted.paymentId]);
  expect(allocations.rows).toEqual([{amount_allocated:'115.00'}]);
 });
 it(`${kind}: partial application stays undated and outer rollback restores all invoice metadata`,async()=>{
  const prepared=await seed(kind,'50'),before=await metadata(kind,prepared.invoice);
  await expect(actor(async()=>{await executeBankAllocation(requireControlTx(),prepared.intentId,{approvalId:prepared.approvalId});throw new Error('Synthetic application rollback');})).rejects.toThrow('Synthetic application rollback');
  expect(await metadata(kind,prepared.invoice)).toEqual(before);
  expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[fixture.companyA,prepared.tx])).rows).toHaveLength(0);
  await actor(()=>executeBankAllocation(requireControlTx(),prepared.intentId,{approvalId:prepared.approvalId}));
  expect(await metadata(kind,prepared.invoice)).toEqual({status:'partially_paid',amount_paid:'50.00',paid_at:null,...(kind==='supplier'?{payment_matched:false,payment_matched_at:null}:{})});
 });
}

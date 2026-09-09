import {planReceiptApplication,applyReceiptPlan} from '@/modules/accounting/services/ar/receiptApplicationService';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {prepareBankAllocation,executeBankAllocation} from '@/modules/accounting/services/bank/bankAllocationControl';
import {requireControlTx,withControlRequest} from '@/modules/accounting/services/controls/context';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import {approveCustomerInvoice} from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService',()=>({snapshotInvoicePdf:async()=>({documentId:null,wasExisting:false})}));
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});
let fixture:ForensicFixture;
const customer=randomUUID(),bank=randomUUID(),rule=randomUUID();
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);
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

it('refuses a later cash application without a fresh approval despite original receipt approval',async()=>{
 const invoice=randomUUID(),tx=randomUUID();
 await pool.query(`INSERT INTO customer_invoices(id,company_id,customer_id,client_id,invoice_number,invoice_date,subtotal,tax_amount,total_amount,currency_code,exchange_rate,functional_total,created_by)
 VALUES($1,$2,$3,$3,$4,'2026-09-09',100,15,115,'ZAR',1,115,$5)`,[invoice,fixture.companyA,customer,invoice,fixture.u1.id]);
 await pool.query("INSERT INTO customer_invoice_items(invoice_id,description,quantity,unit_price,amount,tax_rate) VALUES($1,'Existing receipt target',1,100,100,15)",[invoice]);
 await actor(()=>approveCustomerInvoice(fixture.companyA,invoice,fixture.u1.id));
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',115,'Originally unapplied receipt','imported')",[tx,fixture.companyA,bank]);
 const prepared=await actor(()=>prepareBankAllocation(requireControlTx(),{version:1,kind:'customer',bankTransactionId:tx,partyId:customer,applications:[]}));
 const approval=await actor(()=>requestOperationApproval(requireControlTx(),prepared.operation));await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
 const posted=await actor(()=>executeBankAllocation(requireControlTx(),prepared.intentId,{approvalId:approval.id}));
 await expect(actor(async()=>{
  const plan=await planReceiptApplication(fixture.companyA,posted.paymentId!,[{invoiceId:invoice,amount:115}]);
  return applyReceiptPlan(fixture.companyA,plan,fixture.u1.id);
 })).rejects.toThrow(/approval|intent|controlled/i);
 expect((await pool.query('SELECT amount_paid FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,invoice])).rows[0].amount_paid).toBe('0.00');
});

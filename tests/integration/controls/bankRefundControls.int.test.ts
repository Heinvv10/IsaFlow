import {afterAll,beforeAll,expect,it} from 'vitest';
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
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
let fixture:ForensicFixture;
const customer=randomUUID(),supplier=randomUUID(),bank=randomUUID(),ar=randomUUID(),ap=randomUUID(),period=randomUUID();
type Kind='customer'|'supplier';
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);
 await pool.query("INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role) VALUES($1,$2,'Synthetic refund approval','payment','amount','any',0,'admin')",[randomUUID(),fixture.companyA]);
 await pool.query("INSERT INTO customers(id,company_id,name,auto_allocate_strategy) VALUES($1,$2,'Synthetic refund customer','oldest')",[customer,fixture.companyA]);
 await pool.query("INSERT INTO suppliers(id,company_id,name,auto_allocate_strategy) VALUES($1,$2,'Synthetic refund supplier without outbound beneficiary','oldest')",[supplier,fixture.companyA]);
 await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic refund period',9,2026,'2026-09-01','2026-09-30','open')",[period,fixture.companyA]);
 for(const [id,role,type] of [[bank,'bank','asset'],[ar,'receivable','asset'],[ap,'payable','liability']])await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level) VALUES($1,$2,$3,$4,$5,$4,$6,true,true,3)",[id,fixture.companyA,id!.slice(0,12),role,type,type==='asset'?'debit':'credit']);
 await pool.query("INSERT INTO bank_accounts(company_id,account_name,gl_account_id,currency) VALUES($1,'Synthetic refund bank',$2,'ZAR')",[fixture.companyA,bank]);
});
afterAll(()=>pool.end());
async function actor<T>(fn:()=>Promise<T>,person:'u1'|'u2'|'u3'='u1',token=0){
 const client=await pool.connect(),user=fixture[person];
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  const claims={sub:user.id,role:'authenticated',company_id:user.companyId};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
  const pat=user.tokens[token]!;
  const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:'pat',connectionId:pat.id,grantId:pat.id,grantedScopes:['write:bank-tx','write:post','write:approvals']},fn);
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function source(kind:Kind){
 const tx=randomUUID();
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',$4,'Synthetic refund','imported')",[tx,fixture.companyA,bank,kind==='supplier'?'115.23':'-115.23']);
 return{version:1 as const,kind,bankTransactionId:tx,partyId:kind==='supplier'?supplier:customer,applications:[]};
}
async function prepared(kind:Kind){
 const plan=await source(kind),intent=await actor(()=>prepareBankAllocation(requireControlTx(),plan));
 const approval=await actor(()=>requestOperationApproval(requireControlTx(),intent.operation));
 await expect(actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u1',1)).rejects.toThrow(/requester|same|self|maker/i);
 await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
 return{plan,...intent,approvalId:approval.id};
}
async function noChildren(tx:string){
 for(const table of ['customer_payments','supplier_payments'])expect((await pool.query(`SELECT p.id FROM ${table} p JOIN gl_journal_entries j ON j.company_id=p.company_id AND j.id=p.gl_journal_entry_id WHERE p.company_id=$1 AND j.source_record_id=$2`,[fixture.companyA,tx])).rows).toEqual([]);
}
for(const kind of ['supplier','customer'] as const){
 it(`${kind}: posts gross refund once without VAT or child cash despite enabled default strategy`,async()=>{
  const p=await prepared(kind);
  const results=await Promise.all([1,2].map(()=>actor(()=>executeBankAllocation(requireControlTx(),p.intentId,{approvalId:p.approvalId}))));
  expect(results[0]).toEqual(results[1]);expect(results[0]!.paymentId).toBeNull();
  const lines=(await pool.query('SELECT gl_account_id,debit::text,credit::text,vat_type FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2',[fixture.companyA,results[0]!.journalEntryId])).rows;
  expect(lines).toHaveLength(2);
  expect(lines).toContainEqual({gl_account_id:bank,debit:kind==='supplier'?'115.23':'0.00',credit:kind==='supplier'?'0.00':'115.23',vat_type:null});
  expect(lines).toContainEqual({gl_account_id:kind==='supplier'?ap:ar,debit:kind==='supplier'?'0.00':'115.23',credit:kind==='supplier'?'115.23':'0.00',vat_type:null});
  await noChildren(p.plan.bankTransactionId);
  const adapter=await actor(()=>allocateTransaction(fixture.companyA,p.plan.bankTransactionId,null,fixture.u1.id,undefined,kind,p.plan.partyId,'standard',undefined,undefined,undefined,undefined,{intentId:p.intentId}));
  expect(adapter.journalEntryId).toBe(results[0]!.journalEntryId);
  expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[fixture.companyA,p.plan.bankTransactionId])).rows).toHaveLength(1);
 });
 it(`${kind}: refuses invoice-targeted refunds in preparation and legacy adapter`,async()=>{
  const plan=await source(kind),invoice=randomUUID();
  await expect(actor(()=>prepareBankAllocation(requireControlTx(),{...plan,applications:[{invoiceId:invoice,amount:'115.23'}]}))).rejects.toThrow(/refund.*applications/i);
  await expect(actor(()=>allocateTransaction(fixture.companyA,plan.bankTransactionId,null,fixture.u1.id,undefined,kind,plan.partyId,undefined,undefined,undefined,undefined,invoice))).rejects.toThrow(/refund.*applications/i);
  await noChildren(plan.bankTransactionId);
 });
 it(`${kind}: approved inverse preserves provenance, retries and rollback with no fictional children`,async()=>{
  const p=await prepared(kind),posted=await actor(()=>executeBankAllocation(requireControlTx(),p.intentId,{approvalId:p.approvalId}));
  const reverse=await actor(()=>prepareBankAllocationReversal(requireControlTx(),{originalIntentId:p.intentId,reversalDate:'2026-09-10',reason:'Synthetic refund correction'}));
  const approval=await actor(()=>requestOperationApproval(requireControlTx(),reverse.operation));
  await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
  await expect(actor(async()=>{await executeBankAllocationReversal(requireControlTx(),reverse.intentId,{approvalId:approval.id});throw new Error('Synthetic inverse rollback');})).rejects.toThrow('Synthetic inverse rollback');
  expect((await pool.query('SELECT reversed_at FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[fixture.companyA,posted.journalEntryId])).rows[0].reversed_at).toBeNull();
  const inverse=await actor(()=>executeBankAllocationReversal(requireControlTx(),reverse.intentId,{approvalId:approval.id}));
  expect(inverse).toMatchObject({paymentsCancelled:0,invoicesReopened:0,amountUnapplied:0});
  expect(await actor(()=>executeBankAllocationReversal(requireControlTx(),reverse.intentId))).toEqual(inverse);
  await noChildren(p.plan.bankTransactionId);
  expect((await pool.query('SELECT status,matched_journal_line_id FROM bank_transactions WHERE company_id=$1 AND id=$2',[fixture.companyA,p.plan.bankTransactionId])).rows[0]).toEqual({status:'imported',matched_journal_line_id:null});
  expect((await pool.query("SELECT action FROM control_change_events WHERE company_id=$1 AND entity_id=$2 AND action='bank_allocation.reversed'",[fixture.companyA,p.plan.bankTransactionId])).rows).toHaveLength(1);
 });
 it(`${kind}: stale signed amount, foreign tenant and revoked current authority refuse writes`,async()=>{
  const p=await prepared(kind);
  await expect(actor(()=>executeBankAllocation(requireControlTx(),p.intentId,{approvalId:p.approvalId}),'u3')).rejects.toThrow(/not found|permission/i);
  await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_write) VALUES($1,$2,'bank',false)",[fixture.companyA,fixture.u1.id]);
  try{await expect(actor(()=>executeBankAllocation(requireControlTx(),p.intentId,{approvalId:p.approvalId}))).rejects.toThrow(/permissions/i);}
  finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='bank'",[fixture.companyA,fixture.u1.id]);}
  await pool.query('UPDATE bank_transactions SET amount=amount*2 WHERE company_id=$1 AND id=$2',[fixture.companyA,p.plan.bankTransactionId]);
  await expect(actor(()=>executeBankAllocation(requireControlTx(),p.intentId,{approvalId:p.approvalId}))).rejects.toThrow(/source changed/i);
  expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[fixture.companyA,p.plan.bankTransactionId])).rows).toEqual([]);
 });
 it(`${kind}: closed accounting period and execution rollback leave approval and cash unchanged`,async()=>{
  const p=await prepared(kind);
  await expect(actor(async()=>{await executeBankAllocation(requireControlTx(),p.intentId,{approvalId:p.approvalId});throw new Error('Synthetic refund rollback');})).rejects.toThrow('Synthetic refund rollback');
  expect((await pool.query('SELECT status FROM control_operation_approvals WHERE company_id=$1 AND id=$2',[fixture.companyA,p.approvalId])).rows[0].status).toBe('approved');
  await pool.query("UPDATE fiscal_periods SET status='closed' WHERE company_id=$1 AND id=$2",[fixture.companyA,period]);
  try{await expect(actor(()=>executeBankAllocation(requireControlTx(),p.intentId,{approvalId:p.approvalId}))).rejects.toThrow(/source changed|period|closed/i);}
  finally{await pool.query("UPDATE fiscal_periods SET status='open' WHERE company_id=$1 AND id=$2",[fixture.companyA,period]);}
  await noChildren(p.plan.bankTransactionId);
  expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[fixture.companyA,p.plan.bankTransactionId])).rows).toEqual([]);
 });
}

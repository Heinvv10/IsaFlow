import {loadBankAllocationSources} from '@/modules/accounting/services/bank/bankAllocationSources';
import {parseBankAllocationPlan} from '@/modules/accounting/services/bank/bankAllocationPlan';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {requireControlTx,withControlRequest} from '@/modules/accounting/services/controls/context';
import {prepareBankAllocation,executeBankAllocation} from '@/modules/accounting/services/bank/bankAllocationControl';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
let fixture:ForensicFixture;
const bank=randomUUID(),contra=randomUUID(),inputVat=randomUUID(),outputVat=randomUUID(),period=randomUUID();
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);
 await pool.query("INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role) VALUES($1,$2,'Synthetic VAT approval','payment','amount','any',0,'admin')",[randomUUID(),fixture.companyA]);
 await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic VAT period',9,2026,'2026-09-01','2026-09-30','open')",[period,fixture.companyA]);
 for(const [id,code,type,subtype] of [[bank,'SYN-BANK','asset','bank'],[contra,'SYN-EXP','expense','default_expense'],[inputVat,'1140','asset','other_current_asset'],[outputVat,'2120','liability','tax']])await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account) VALUES($1,$2,$3,'Synthetic VAT account',$4,$5,$6,true,true)",[id,fixture.companyA,code,type,subtype,type==='liability'?'credit':'debit']);
 await pool.query("INSERT INTO bank_accounts(company_id,account_name,gl_account_id,currency) VALUES($1,'Synthetic VAT bank',$2,'ZAR')",[fixture.companyA,bank]);
});
afterAll(()=>pool.end());
async function actor<T>(fn:()=>Promise<T>,person:'u1'|'u2'|'u3'='u1'){
 const client=await pool.connect(),user=fixture[person];
 try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  const claims={sub:user.id,role:'authenticated',company_id:user.companyId};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
  const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},fn);
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function source(spent=true,vatCode='standard'){
 const id=randomUUID();await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,status) VALUES($1,$2,$3,'2026-09-09',$4,'imported')",[id,fixture.companyA,bank,spent?'-115.23':'115.23']);
 return{version:1 as const,kind:'account' as const,bankTransactionId:id,lines:[{accountId:contra,amount:'115.23',vatCode}]};
}
async function approval(operation:Parameters<typeof requestOperationApproval>[1]){
 const a=await actor(()=>requestOperationApproval(requireControlTx(),operation));await actor(()=>decideOperationApproval(requireControlTx(),a.id,'approved'),'u2');return a.id;
}
for(const spent of [true,false])it(`binds legacy ${spent?'1140 input':'2120 output'} VAT account and posts exact gross direction`,async()=>{
 const plan=await source(spent),prepared=await actor(()=>prepareBankAllocation(requireControlTx(),plan));
 const stored=(await pool.query('SELECT payload FROM control_bank_allocation_intents WHERE company_id=$1 AND id=$2',[fixture.companyA,prepared.intentId])).rows[0].payload;
 expect(stored.vatAccountId).toBe(spent?inputVat:outputVat);
 const approvalId=await approval(prepared.operation),result=await actor(()=>executeBankAllocation(requireControlTx(),prepared.intentId,{approvalId}));
 const rows=(await pool.query('SELECT gl_account_id,debit::text,credit::text FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2',[fixture.companyA,result.journalEntryId])).rows;
 expect(rows).toHaveLength(3);
 expect(rows).toContainEqual({gl_account_id:spent?inputVat:outputVat,debit:spent?'15.03':'0.00',credit:spent?'0.00':'15.03'});
 expect(rows).toContainEqual({gl_account_id:contra,debit:spent?'100.20':'0.00',credit:spent?'0.00':'100.20'});
 expect(rows).toContainEqual({gl_account_id:bank,debit:spent?'0.00':'115.23',credit:spent?'115.23':'0.00'});
});
it('explicit fallback ID is preserved and unrelated or foreign VAT accounts are refused',async()=>{
 const plan=await source(),foreignVat=randomUUID();
 await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account) VALUES($1,$2,'SYN-FOREIGN','Synthetic foreign VAT','asset','vat_input','debit',true,true)",[foreignVat,fixture.companyB]);
 const prepared=await actor(()=>prepareBankAllocation(requireControlTx(),{...plan,vatAccountId:inputVat}));expect(prepared.intentId).toBeTruthy();
 for(const vatAccountId of [contra,bank,outputVat,foreignVat,randomUUID()])await expect(actor(()=>prepareBankAllocation(requireControlTx(),{...plan,vatAccountId}))).rejects.toThrow(/VAT|account/i);
 await expect(actor(()=>prepareBankAllocation(requireControlTx(),{...plan,vatAccountId:inputVat}),'u3')).rejects.toThrow(/owned|not found/i);
});
it('zero rated, exempt and none do not choose a VAT account',async()=>{
 for(const code of ['zero_rated','exempt','none']){
  const plan=await source(true,code),p=await actor(()=>prepareBankAllocation(requireControlTx(),plan));
  expect((await pool.query('SELECT payload FROM control_bank_allocation_intents WHERE company_id=$1 AND id=$2',[fixture.companyA,p.intentId])).rows[0].payload).not.toHaveProperty('vatAccountId');
  const approvalId=await approval(p.operation),posted=await actor(()=>executeBankAllocation(requireControlTx(),p.intentId,{approvalId}));
  const lines=(await pool.query('SELECT gl_account_id FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2',[fixture.companyA,posted.journalEntryId])).rows;
  expect(lines).toHaveLength(2);expect(lines.map(row=>row.gl_account_id).sort()).toEqual([bank,contra].sort());
 }
});
it('changed selected VAT classification invalidates approved source without fallback reselection',async()=>{
 const plan=await source(),p=await actor(()=>prepareBankAllocation(requireControlTx(),plan)),approvalId=await approval(p.operation);
 await pool.query("UPDATE gl_accounts SET account_subtype='tax' WHERE company_id=$1 AND id=$2",[fixture.companyA,inputVat]);
 try{await expect(actor(()=>executeBankAllocation(requireControlTx(),p.intentId,{approvalId}))).rejects.toThrow(/source changed/i);}
 finally{await pool.query("UPDATE gl_accounts SET account_subtype='other_current_asset' WHERE company_id=$1 AND id=$2",[fixture.companyA,inputVat]);}
});
it('inactive, wrong-type or unrelated-classification fallback is refused',async()=>{
 for(const [field,value] of [['is_active',false],['account_type','expense'],['account_subtype','bank']] as const){
  const plan=await source();
  await pool.query(`UPDATE gl_accounts SET ${field}=$3 WHERE company_id=$1 AND id=$2`,[fixture.companyA,inputVat,value]);
  try{await expect(actor(()=>prepareBankAllocation(requireControlTx(),plan))).rejects.toThrow(/VAT|account/i);}
  finally{await pool.query("UPDATE gl_accounts SET is_active=true,account_type='asset',account_subtype='other_current_asset' WHERE company_id=$1 AND id=$2",[fixture.companyA,inputVat]);}
 }
});
it('bank date and accounting period changes invalidate approval; execution rollback is atomic',async()=>{
 const plan=await source(),p=await actor(()=>prepareBankAllocation(requireControlTx(),plan)),approvalId=await approval(p.operation);
 await expect(actor(async()=>{await executeBankAllocation(requireControlTx(),p.intentId,{approvalId});throw new Error('Synthetic VAT rollback');})).rejects.toThrow('Synthetic VAT rollback');
 expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[fixture.companyA,plan.bankTransactionId])).rows).toEqual([]);
 await pool.query("UPDATE bank_transactions SET transaction_date='2026-09-08' WHERE company_id=$1 AND id=$2",[fixture.companyA,plan.bankTransactionId]);
 await expect(actor(()=>executeBankAllocation(requireControlTx(),p.intentId,{approvalId}))).rejects.toThrow(/source changed/i);
 await pool.query("UPDATE bank_transactions SET transaction_date='2026-09-09' WHERE company_id=$1 AND id=$2",[fixture.companyA,plan.bankTransactionId]);
 await pool.query("UPDATE fiscal_periods SET status='closed' WHERE company_id=$1 AND id=$2",[fixture.companyA,period]);
 try{await expect(actor(()=>executeBankAllocation(requireControlTx(),p.intentId,{approvalId}))).rejects.toThrow(/source changed|period|closed/i);}
 finally{await pool.query("UPDATE fiscal_periods SET status='open' WHERE company_id=$1 AND id=$2",[fixture.companyA,period]);}
});
it('ambiguous canonical VAT role refuses instead of picking fallback; explicit validated ID is unambiguous',async()=>{
 const ids=[randomUUID(),randomUUID()];
 for(const id of ids)await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account) VALUES($1,$2,left($1::uuid::text,20),'Synthetic duplicate VAT','asset','vat_input','debit',true,true)",[id,fixture.companyA]);
 try{
  const plan=await source();await expect(actor(()=>prepareBankAllocation(requireControlTx(),plan))).rejects.toThrow(/ambiguous/i);
  expect((await actor(()=>prepareBankAllocation(requireControlTx(),{...plan,vatAccountId:ids[0]}))).intentId).toBeTruthy();
 }finally{await pool.query('DELETE FROM gl_accounts WHERE company_id=$1 AND id=ANY($2::uuid[])',[fixture.companyA,ids]);}
});
it('revoked current authority cannot prepare VAT fallback material',async()=>{
 const plan=await source();await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_write) VALUES($1,$2,'banking',false)",[fixture.companyA,fixture.u1.id]);
 try{await expect(actor(()=>prepareBankAllocation(requireControlTx(),plan))).rejects.toThrow(/permission/i);}
 finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='banking'",[fixture.companyA,fixture.u1.id]);}
});

it('canonical subtype outranks legacy code and retains old-plan source fingerprint interpretation',async()=>{
 const id=randomUUID();
 await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account) VALUES($1,$2,'SYN-CANON','Synthetic canonical VAT','asset','vat_input','debit',true,true)",[id,fixture.companyA]);
 try{
  const plan=await source();
  const before=await actor(()=>loadBankAllocationSources(requireControlTx(),parseBankAllocationPlan(plan)));
  const prepared=await actor(()=>prepareBankAllocation(requireControlTx(),plan));
  const saved=(await pool.query('SELECT payload,source_fingerprint FROM control_bank_allocation_intents WHERE company_id=$1 AND id=$2',[fixture.companyA,prepared.intentId])).rows[0];
  expect(saved.payload.vatAccountId).toBe(id);expect(saved.source_fingerprint).toBe(before.fingerprint);
 }finally{await pool.query('DELETE FROM gl_accounts WHERE company_id=$1 AND id=$2',[fixture.companyA,id]);}
});

it('split taxable and exempt lines bind one exact VAT account and preserve line rounding',async()=>{
 const sourcePlan=await source();
 const plan={...sourcePlan,kind:'split',lines:[{accountId:contra,amount:'60',vatCode:'standard'},{accountId:contra,amount:'55.23',vatCode:'exempt'}]};
 const p=await actor(()=>prepareBankAllocation(requireControlTx(),plan)),approvalId=await approval(p.operation);
 const posted=await actor(()=>executeBankAllocation(requireControlTx(),p.intentId,{approvalId}));
 const rows=(await pool.query('SELECT gl_account_id,debit::text,credit::text FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2',[fixture.companyA,posted.journalEntryId])).rows;
 expect(rows).toHaveLength(4);expect(rows).toContainEqual({gl_account_id:inputVat,debit:'7.83',credit:'0.00'});
 expect(rows).toContainEqual({gl_account_id:contra,debit:'52.17',credit:'0.00'});expect(rows).toContainEqual({gl_account_id:contra,debit:'55.23',credit:'0.00'});
});

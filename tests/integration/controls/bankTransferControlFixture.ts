import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import type {ControlTx,OperationRef} from '@/modules/accounting/services/controls/contracts';
import {getApprovalRequirements,requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import {prepareBankAllocation,executeBankAllocation} from '@/modules/accounting/services/bank/bankAllocationControl';
export async function transferControlFixture(){
 process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
 const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:4});
 try{
 const f=await provisionForensicFixture(config),from=randomUUID(),to=randomUUID();
 await pool.query("INSERT INTO approval_rules(company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role) VALUES($1,'Synthetic transfer approval','payment','amount','any',0,'admin')",[f.companyA]);
 await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic transfer September',9,2026,'2026-09-01','2026-09-30','open')",[randomUUID(),f.companyA]);
 for(const id of [from,to]){
  await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,level) VALUES($1,$2,left($1::uuid::text,12),'Synthetic producer bank','asset','bank','debit',true,3)",[id,f.companyA]);
  await pool.query("INSERT INTO bank_accounts(company_id,account_name,gl_account_id,currency,is_active) VALUES($1,'Synthetic producer bank',$2,'ZAR',true)",[f.companyA,id]);
 }
 async function bank(account=from,amount='-115.23',date='2026-09-09'){
  const id=randomUUID();await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,$4,$5,'Synthetic controlled transfer','imported')",[id,f.companyA,account,date,amount]);return id;
 }
 async function actor<T>(fn:(ctx:ControlTx)=>Promise<T>,person:'u1'|'u2'='u1',patIndex?:number){
  const user=f[person],client=await pool.connect(),pat=patIndex===undefined?null:user.tokens[patIndex]!;
  try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
   const claims={sub:user.id,role:'authenticated',company_id:user.companyId};await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
   const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:pat?'pat':'cookie',
    ...(pat?{connectionId:pat.id,grantId:pat.id,grantedScopes:['read:bank-tx','read:approvals','read:reports','write:bank-tx','write:post','write:approvals']}: {})},()=>fn(requireControlTx()));
   await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 const prepare=(bankTransactionId:string,counterpartyAccountId=to,person:'u1'|'u2'='u1',patIndex?:number)=>actor(ctx=>prepareBankAllocation(ctx,{version:1,kind:'transfer',bankTransactionId,counterpartyAccountId}),person,patIndex);
 async function approve(ref:OperationRef,person:'u1'|'u2'='u1'){
  const requirements=await actor(ctx=>getApprovalRequirements(ctx,ref),person);
  if(!requirements.requiresApproval)throw new Error('Synthetic mandatory transfer policy was not applied');
  const approval=await actor(ctx=>requestOperationApproval(ctx,ref),person);
  await actor(ctx=>decideOperationApproval(ctx,approval.id,'approved'),person==='u1'?'u2':'u1');return approval.id;
 }
 const execute=(intentId:string,approvalId?:string,person:'u1'|'u2'='u1')=>actor(ctx=>executeBankAllocation(ctx,intentId,{approvalId}),person);
 const saved=async(intentId:string)=>(await pool.query('SELECT payload FROM control_bank_allocation_intents WHERE company_id=$1 AND id=$2',[f.companyA,intentId])).rows[0].payload;
 return{pool,f,from,to,bank,actor,prepare,approve,execute,saved,close:()=>pool.end()};
 }catch(error){await pool.end();throw error;}
}

import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
export async function transferFixture(){
 const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:3});
 try{
 const f=await provisionForensicFixture(config);
 async function account(company=f.companyA){
  const id=randomUUID();await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,level) VALUES($1,$2,left($1::uuid::text,12),'Synthetic transfer bank','asset','bank','debit',true,3)",[id,company]);
  await pool.query("INSERT INTO bank_accounts(company_id,account_name,gl_account_id,currency,is_active) VALUES($1,'Synthetic transfer bank',$2,'ZAR',true)",[company,id]);return id;
 }
 const from=await account(),to=await account();
 async function bank(accountId=from,amount='-115.23',date='2026-09-09',company=f.companyA){
  const id=randomUUID();await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,$4,$5,'Synthetic transfer source','imported')",[id,company,accountId,date,amount]);return id;
 }
 async function intent(bankId:string,counterparty=to,payloadOverride?:unknown){
  const id=randomUUID(),payload=payloadOverride??{version:1,kind:'transfer',bankTransactionId:bankId,counterpartyAccountId:counterparty,transfer:{mode:'post',oppositeBankTransactionId:null}};
  await pool.query("INSERT INTO control_bank_allocation_intents(company_id,id,requester_person_id,bank_transaction_id,accounting_date,amount,currency,payload,source_fingerprint) SELECT company_id,$2,$3,id,transaction_date,abs(amount),'ZAR',$4,$5 FROM bank_transactions WHERE company_id=$1 AND id=$6",[f.companyA,id,f.u1.id,payload,'a'.repeat(64),bankId]);return id;
 }
 async function actor<T>(fn:(ctx:ControlTx)=>Promise<T>,person:'u1'|'u3'='u1'){
  const user=f[person],client=await pool.connect();
  try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
   const claims={sub:user.id,role:'authenticated',company_id:user.companyId};
   await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
   const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>fn(requireControlTx()));
   await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 return{pool,f,from,to,account,bank,intent,actor,close:()=>pool.end()};
 }catch(error){await pool.end();throw error;}
}

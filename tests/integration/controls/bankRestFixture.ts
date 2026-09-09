import {randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {Pool} from 'pg';
import {SignJWT} from 'jose';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import route from '../../../pages/api/accounting/bank-transactions-action';
import {getAuthPool} from '@/lib/auth/authPool';
import {requireControlTx,withControlRequest} from '@/modules/accounting/services/controls/context';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import type {OperationRef} from '@/modules/accounting/services/controls/contracts';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';
export async function bankRestFixture(){
 const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
 process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
 const jwtKey=randomBytes(32).toString('hex');
 process.env.JWT_SECRET=jwtKey;
 process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
 process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
 const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2}),fixture=await provisionForensicFixture(config);
 const bank=randomUUID(),contra=randomUUID(),customer=randomUUID();
 await pool.query("INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role) VALUES($1,$2,'Synthetic REST approval','payment','amount','any',0,'admin')",[randomUUID(),fixture.companyA]);
 await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic REST period',9,2026,'2026-09-01','2026-09-30','open')",[randomUUID(),fixture.companyA]);
 for(const [id,type,subtype] of [[bank,'asset','bank'],[contra,'expense','default_expense'],[randomUUID(),'asset','receivable']])await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account) VALUES($1,$2,left($1::uuid::text,20),'Synthetic REST GL',$3,$4,'debit',true,true)",[id,fixture.companyA,type,subtype]);
 await pool.query("INSERT INTO bank_accounts(company_id,account_name,gl_account_id,currency) VALUES($1,'Synthetic REST bank',$2,'ZAR')",[fixture.companyA,bank]);
 await pool.query("INSERT INTO customers(id,company_id,name,auto_allocate_strategy) VALUES($1,$2,'Synthetic REST customer','oldest')",[customer,fixture.companyA]);
 const server=createServer((req,res)=>{void apiResolver(req,res,{}, {default:route},{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,'/api/accounting/bank-transactions-action').catch(()=>{res.statusCode=500;res.end('Synthetic route failure');});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('Loopback fixture unavailable');
 const url=`http://127.0.0.1:${address.port}/api/accounting/bank-transactions-action`,csrf=randomBytes(32).toString('hex');
 async function request(body:unknown,person:'u1'|'u2'|'u3'='u1',validCsrf=true){
  const user=fixture[person],token=await new SignJWT({role:'authenticated',aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setSubject(user.id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const response=await fetch(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json',cookie:`sb-access-token=${token}; active_company_id=${user.companyId}; isaflow_csrf=${csrf}`,'x-csrf-token':validCsrf?csrf:'wrong'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  return{status:response.status,body:await response.json()};
 }
 async function actor<T>(fn:()=>Promise<T>,person:'u1'|'u2'='u1'){
  const client=await pool.connect(),user=fixture[person];
  try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
   await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
   const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},fn);await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 async function approve(operation:OperationRef){const a=await actor(()=>requestOperationApproval(requireControlTx(),operation));await actor(()=>decideOperationApproval(requireControlTx(),a.id,'approved'),'u2');return a.id;}
 async function source(amount='-115.23'){const id=randomUUID();await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,status) VALUES($1,$2,$3,'2026-09-09',$4,'imported')",[id,fixture.companyA,bank,amount]);return id;}
 async function close(){await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await getAuthPool().end();await pool.end();}
 return{pool,fixture,bank,contra,customer,request,approve,source,close};
}

import {randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {Pool} from 'pg';
import {SignJWT} from 'jose';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import route from '../../../pages/api/accounting/bank-transactions-bulk-commit';
import {getAuthPool} from '@/lib/auth/authPool';
import {withControlRequest} from '@/modules/accounting/services/controls/context';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
export type Person='u1'|'u2'|'u3';
/**
 * The bank-rule sweep over real HTTP: a one-line generic CSV committed through
 * `bank-transactions-bulk-commit` with `applyBankRules:true`. Company A carries
 * no approval policy; company B (u3) binds every payment to an approval, so the
 * same rule shape exercises both the posting and the refusing arm of the sweep.
 */
export async function bankRuleAutoPostHttpFixture(){
 const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
 process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
 process.env.JWT_SECRET=randomBytes(32).toString('hex');
 process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
 process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
 const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2}),fixture=await provisionForensicFixture(config);
 const companies={A:fixture.companyA,B:fixture.companyB} as const;
 const bank={A:randomUUID(),B:randomUUID()},contra={A:randomUUID(),B:randomUUID()};
 await pool.query("INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role) VALUES($1,$2,'Synthetic sweep approval','payment','amount','any',0,'admin')",[randomUUID(),companies.B]);
 for(const key of ['A','B'] as const){
  const company=companies[key];
  await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic sweep open',9,2026,'2026-09-01','2026-09-30','open')",[randomUUID(),company]);
  await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic sweep closed',8,2026,'2026-08-01','2026-08-31','closed')",[randomUUID(),company]);
  for(const [id,type,subtype] of [[bank[key],'asset','bank'],[contra[key],'expense','default_expense'],[randomUUID(),'asset','vat_input'],[randomUUID(),'liability','vat_output']])await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account) VALUES($1,$2,left($1::uuid::text,20),'Synthetic sweep GL',$3,$4,'debit',true,true)",[id,company,type,subtype]);
  await pool.query("INSERT INTO bank_accounts(company_id,account_name,gl_account_id,currency) VALUES($1,'Synthetic sweep bank',$2,'ZAR')",[company,bank[key]]);
 }
 const server=createServer((req,res)=>{void apiResolver(req,res,{}, {default:route},{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,'/api/accounting/bank-transactions-bulk-commit').catch(()=>{res.statusCode=500;res.end('Synthetic route failure');});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('Loopback fixture unavailable');
 const url=`http://127.0.0.1:${address.port}/api/accounting/bank-transactions-bulk-commit`,csrf=randomBytes(32).toString('hex');
 async function request(body:unknown,person:Person='u1'){
  const user=fixture[person],token=await new SignJWT({role:'authenticated',aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setSubject(user.id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const response=await fetch(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json',cookie:`sb-access-token=${token}; active_company_id=${user.companyId}; isaflow_csrf=${csrf}`,'x-csrf-token':csrf},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  return{status:response.status,body:await response.json()};
 }
 /** An auto-post rule for the company; `contra` gives an account rule, `supplierId` a supplier rule. */
 async function rule(key:'A'|'B',pattern:string,options:{vatCode?:string;supplierId?:string}={}){
  const id=randomUUID();
  await pool.query("INSERT INTO bank_categorisation_rules(id,company_id,rule_name,match_field,match_type,match_pattern,gl_account_id,supplier_id,vat_code,auto_create_entry,is_active,priority) VALUES($1,$2,$3,'description','contains',$4,$5,$6,$7,true,true,1)",
   [id,companies[key],`Synthetic sweep rule ${pattern}`,pattern,options.supplierId?null:contra[key],options.supplierId??null,options.vatCode??'none']);
  return id;
 }
 /** Commits one statement line through the real route and returns the response plus the row it inserted. */
 async function commit(key:'A'|'B',person:Person,line:{date:string;description:string;amount:string}){
  const csv=`Date,Description,Amount\n${line.date},${line.description},${line.amount}\n`;
  const response=await request({bankAccountId:bank[key],bulkImportId:randomUUID(),bulkSequence:1,filename:`${randomUUID()}.csv`,fileType:'csv',bankFormat:'generic',statementDate:line.date,csvContent:csv,applyBankRules:true},person);
  const {rows}=await pool.query('SELECT * FROM bank_transactions WHERE company_id=$1 AND bank_account_id=$2 AND description=$3',[companies[key],bank[key],line.description]);
  return{response,tx:rows[0] as Record<string,unknown>|undefined};
 }
 async function actor<T>(fn:()=>Promise<T>,person:Person='u1'){
  const client=await pool.connect(),user=fixture[person];
  try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
   await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
   const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},fn);await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 async function close(){await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await getAuthPool().end();await pool.end();}
 return{pool,fixture:fixture as ForensicFixture,companies,bank,contra,request,rule,commit,actor,close};
}

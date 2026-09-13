import {randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {Pool} from 'pg';
import {SignJWT} from 'jose';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import reconRoute from '../../../pages/api/accounting/bank-reconciliations-action';
import directiveRoute from '../../../pages/api/accounting/tax-directives/[id]/apply';
import uifRoute from '../../../pages/api/payroll/uif/[id]';
import {getAuthPool} from '@/lib/auth/authPool';
import {requireControlTx,withControlRequest} from '@/modules/accounting/services/controls/context';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
export type Person='u1'|'u2'|'u3';
type Row=Record<string,unknown>;
/**
 * The three attended routes that post a journal whose `source` the control kernel treats as generated, over real
 * HTTP: a bank-reconciliation adjustment, a SARS tax-directive application and a UIF declaration payment. Company A
 * carries no approval policy; company B (u3) binds every journal to one, so the same request shape exercises both
 * the posting and the refusing arm. September 2026 is open in both; August is closed.
 */
export async function generatedSourceRoutesFixture(){
 const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
 process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
 process.env.JWT_SECRET=randomBytes(32).toString('hex');
 process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
 process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
 const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2}),fixture=await provisionForensicFixture(config);
 const companies={A:fixture.companyA,B:fixture.companyB} as const;
 const gl:Record<'A'|'B',Record<string,string>>={A:{},B:{}};
 await pool.query("INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role) VALUES($1,$2,'Synthetic journal approval','journal_entry','amount','any',0,'admin')",[randomUUID(),companies.B]);
 for(const key of ['A','B'] as const){
  const company=companies[key];
  await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic generated open',9,2026,'2026-09-01','2026-09-30','open')",[randomUUID(),company]);
  await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic generated closed',8,2026,'2026-08-01','2026-08-31','closed')",[randomUUID(),company]);
  // The codes the two statutory services resolve by account_code, plus the recon pair.
  for(const [code,type,subtype] of [['1110','asset','bank'],['2140','liability','payable'],['2150','liability','payable'],
   ['5200','expense','default_expense'],['6900','expense','default_expense']] as const){
   const id=randomUUID();gl[key][code]=id;
   await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account) VALUES($1,$2,$3,'Synthetic generated GL',$4,$5,'debit',true,true)",[id,company,code,type,subtype]);
  }
  await pool.query("INSERT INTO bank_accounts(company_id,account_name,gl_account_id,currency) VALUES($1,'Synthetic generated bank',$2,'ZAR')",[company,gl[key]['1110']]);
 }
 const routes={'/api/accounting/bank-reconciliations-action':reconRoute,'/api/accounting/tax-directives/apply':directiveRoute,'/api/payroll/uif':uifRoute};
 const server=createServer((req,res)=>{
  const url=new URL(req.url??'/','http://127.0.0.1');
  const id=url.searchParams.get('id');
  const route=routes[url.pathname as keyof typeof routes];
  if(!route){res.statusCode=404;res.end('Synthetic route unmounted');return;}
  void apiResolver(req,res,id===null?{}:{id},{default:route},{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,url.pathname)
   .catch(()=>{res.statusCode=500;res.end('Synthetic route failure');});
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('Loopback fixture unavailable');
 const origin=`http://127.0.0.1:${address.port}`,csrf=randomBytes(32).toString('hex');
 async function request(path:string,method:'POST'|'PATCH',body:unknown,person:Person='u1'){
  const user=fixture[person],token=await new SignJWT({role:'authenticated',aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setSubject(user.id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const response=await fetch(`${origin}${path}`,{method,redirect:'error',headers:{'content-type':'application/json',cookie:`sb-access-token=${token}; active_company_id=${user.companyId}; isaflow_csrf=${csrf}`,'x-csrf-token':csrf},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  return{status:response.status,body:await response.json() as {success?:boolean;error?:unknown;data?:Record<string,unknown>}};
 }
 /** An in-progress reconciliation on the company's bank GL account, dated inside `date`'s period. */
 async function reconciliation(key:'A'|'B',date='2026-09-15'){
  const id=randomUUID();
  await pool.query("INSERT INTO bank_reconciliations(id,company_id,bank_account_id,statement_date,statement_balance,gl_balance,status,started_by) VALUES($1,$2,$3,$4::date,0,0,'in_progress',$5)",
   [id,companies[key],gl[key]['1110'],date,fixture[key==='A'?'u1':'u3'].id]);
  return id;
 }
 async function approvedDirective(key:'A'|'B'){
  const id=randomUUID();
  await pool.query("INSERT INTO tax_directives(id,company_id,employee_name,directive_number,directive_type,amount,tax_rate,effective_date,status) VALUES($1,$2,'Synthetic Employee','SD-0001','fixed_amount',1000,0.18,'2026-09-01','approved')",[id,companies[key]]);
  return id;
 }
 async function submittedUifDeclaration(key:'A'|'B'){
  const id=randomUUID();
  await pool.query("INSERT INTO uif_declarations(id,company_id,period_year,period_month,total_employees,total_leviable_salary,total_employee_contribution,total_employer_contribution,status) VALUES($1,$2,2026,9,1,10000,100,100,'submitted')",[id,companies[key]]);
  return id;
 }
 async function journals(key:'A'|'B',sourceRecordId:string){
  return (await pool.query('SELECT id,status,source,source_record_id,entry_date::text AS entry_date FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[companies[key],sourceRecordId])).rows as Row[];
 }
 async function journalById(key:'A'|'B',id:string){
  return (await pool.query('SELECT id,status,source,reversed_at FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[companies[key],id])).rows[0] as Row|undefined;
 }
 async function actor<T>(fn:()=>Promise<T>,person:Person='u1'){
  const client=await pool.connect(),user=fixture[person];
  try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
   await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
   const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},fn);await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 async function close(){await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await getAuthPool().end();await pool.end();}
 return{pool,fixture:fixture as ForensicFixture,companies,gl,request,requireControlTx,reconciliation,approvedDirective,submittedUifDeclaration,journals,journalById,actor,close};
}

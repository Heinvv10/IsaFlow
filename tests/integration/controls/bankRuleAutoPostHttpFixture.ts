import {randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {Pool} from 'pg';
import {SignJWT} from 'jose';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import route from '../../../pages/api/accounting/bank-transactions-bulk-commit';
import {getAuthPool} from '@/lib/auth/authPool';
import {requireControlTx,withControlRequest} from '@/modules/accounting/services/controls/context';
import {seedBankAllocationSupplier} from './bankAllocationSupplierFixture';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
export type Person='u1'|'u2'|'u3';
/**
 * The bank-rule sweep over real HTTP: a generic CSV committed through
 * `bank-transactions-bulk-commit` with `applyBankRules:true`. Company A carries
 * no approval policy; company B (u3) binds every payment to an approval, so the
 * same rule shape exercises both the posting and the refusing arm of the sweep.
 * Company A also carries, for the per-line refusals: a closed August, an open
 * July on or before its lockdown date (2026-07-31), and an open October whose
 * VAT return is filed (`vat_period_locks`). September is the plain open month.
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
  await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic sweep locked down',7,2026,'2026-07-01','2026-07-31','open')",[randomUUID(),company]);
  await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic sweep VAT filed',10,2026,'2026-10-01','2026-10-31','open')",[randomUUID(),company]);
  await pool.query("INSERT INTO vat_period_locks(company_id,period_start,period_end,output_tax,input_tax,net_vat,posted_through,locked_by,actor_type) VALUES($1,'2026-10-01','2026-10-31',0,0,0,clock_timestamp(),$2,'human')",[company,fixture.u1.id]);
  await pool.query("UPDATE companies SET lockdown_enabled=true,lockdown_date='2026-07-31' WHERE id=$1",[company]);
  for(const [id,type,subtype] of [[bank[key],'asset','bank'],[contra[key],'expense','default_expense'],[randomUUID(),'asset','vat_input'],[randomUUID(),'liability','vat_output'],[randomUUID(),'liability','payable'],[randomUUID(),'asset','receivable']])await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account) VALUES($1,$2,left($1::uuid::text,20),'Synthetic sweep GL',$3,$4,'debit',true,true)",[id,company,type,subtype]);
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
 async function rule(key:'A'|'B',pattern:string,options:{vatCode?:string;supplierId?:string;clientId?:string}={}){
  const id=randomUUID(),party=Boolean(options.supplierId||options.clientId);
  await pool.query("INSERT INTO bank_categorisation_rules(id,company_id,rule_name,match_field,match_type,match_pattern,gl_account_id,supplier_id,client_id,vat_code,auto_create_entry,is_active,priority) VALUES($1,$2,$3,'description','contains',$4,$5,$6,$7,$8,true,true,1)",
   [id,companies[key],`Synthetic sweep rule ${pattern}`,pattern,party?null:contra[key],options.supplierId??null,options.clientId??null,options.vatCode??'none']);
  return id;
 }
 type Line={date:string;description:string;amount:string};
 /** Commits statement lines through the real route; returns the response and each inserted row keyed by description. */
 async function commit(key:'A'|'B',person:Person,lines:Line[]){
  const csv=`Date,Description,Amount\n${lines.map(line=>`${line.date},${line.description},${line.amount}`).join('\n')}\n`;
  const response=await request({bankAccountId:bank[key],bulkImportId:randomUUID(),bulkSequence:1,filename:`${randomUUID()}.csv`,fileType:'csv',bankFormat:'generic',statementDate:lines[0]!.date,csvContent:csv,applyBankRules:true},person);
  const {rows}=await pool.query('SELECT * FROM bank_transactions WHERE company_id=$1 AND bank_account_id=$2 AND description=ANY($3::text[])',[companies[key],bank[key],lines.map(line=>line.description)]);
  const tx=new Map((rows as Record<string,unknown>[]).map(row=>[String(row.description),row]));
  return{response,tx:(description:string)=>{const row=tx.get(description);if(!row)throw new Error(`Line not imported: ${description}`);return row;}};
 }
 /** A supplier whose beneficiary was independently verified (u1 proposes, u2 verifies), the shape a supplier rule needs. */
 async function verifiedSupplier(){return (await seedBankAllocationSupplier(pool,fixture,(person,fn)=>actor(()=>fn(requireControlTx()),person))).supplier;}
 async function unverifiedSupplier(){const id=randomUUID();await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic legacy supplier')",[id,companies.A]);return id;}
 async function customer(){const id=randomUUID();await pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'Synthetic sweep customer')",[id,companies.A]);return id;}
 async function actor<T>(fn:()=>Promise<T>,person:Person='u1'){
  const client=await pool.connect(),user=fixture[person];
  try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
   await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
   const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},fn);await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 async function close(){await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await getAuthPool().end();await pool.end();}
 return{pool,fixture:fixture as ForensicFixture,companies,bank,contra,request,rule,commit,actor,verifiedSupplier,unverifiedSupplier,customer,close};
}

import {randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {Pool} from 'pg';
import {SignJWT} from 'jose';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import commitRoute from '../../../pages/api/accounting/bank-transactions-bulk-commit';
import outstandingRoute from '../../../pages/api/accounting/provisional/outstanding';
import dismissRoute from '../../../pages/api/accounting/provisional/[jeId]/dismiss';
import autoPostRoute from '../../../pages/api/accounting/bank-auto-post';
import {getAuthPool} from '@/lib/auth/authPool';
import {requireControlTx,withControlRequest} from '@/modules/accounting/services/controls/context';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
export type Person='u1'|'u2'|'u3';
type Row=Record<string,unknown>;
/**
 * The unattended provisional-posting lifecycle over real HTTP: a statement committed through
 * `bank-transactions-bulk-commit` with auto-post enabled (the import sweep's predictor path), the
 * `provisional/outstanding` batch trigger, `provisional/[jeId]/dismiss` and the `bank-auto-post` run undo.
 * Company A has no approval policy; company B (u3) binds every payment to one. September 2026 is open in both.
 */
export async function provisionalControlFixture(){
 const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
 process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
 process.env.JWT_SECRET=randomBytes(32).toString('hex');
 process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
 process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
 const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2}),fixture=await provisionForensicFixture(config);
 const companies={A:fixture.companyA,B:fixture.companyB} as const;
 const bank={A:randomUUID(),B:randomUUID()},expense={A:randomUUID(),B:randomUUID()};
 await pool.query("INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role) VALUES($1,$2,'Synthetic provisional approval','payment','amount','any',0,'admin')",[randomUUID(),companies.B]);
 for(const key of ['A','B'] as const){
  const company=companies[key],user=fixture[key==='A'?'u1':'u3'];
  await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic provisional open',9,2026,'2026-09-01','2026-09-30','open')",[randomUUID(),company]);
  for(const [id,type,subtype] of [[bank[key],'asset','bank'],[expense[key],'expense','default_expense'],[randomUUID(),'asset','vat_input'],
   [randomUUID(),'liability','vat_output'],[randomUUID(),'liability','payable'],[randomUUID(),'asset','receivable']] as const){
   await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account) VALUES($1,$2,left($1::uuid::text,20),'Synthetic provisional GL',$3,$4,'debit',true,true)",[id,company,type,subtype]);
  }
  await pool.query("INSERT INTO bank_accounts(company_id,account_name,gl_account_id,currency) VALUES($1,'Synthetic provisional bank',$2,'ZAR')",[company,bank[key]]);
  await pool.query("INSERT INTO bank_auto_post_settings(company_id,enabled,min_confidence,amount_cap,updated_by) VALUES($1,true,0.9,100000,$2)",[company,user.id]);
 }
 const routes={'/api/accounting/bank-transactions-bulk-commit':commitRoute,'/api/accounting/provisional/outstanding':outstandingRoute,
  '/api/accounting/provisional/dismiss':dismissRoute,'/api/accounting/bank-auto-post':autoPostRoute};
 const server=createServer((req,res)=>{
  const url=new URL(req.url??'/','http://127.0.0.1'),jeId=url.searchParams.get('jeId');
  const route=routes[url.pathname as keyof typeof routes];
  if(!route){res.statusCode=404;res.end('Synthetic route unmounted');return;}
  void apiResolver(req,res,jeId===null?{}:{jeId},{default:route},{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,url.pathname)
   .catch(()=>{res.statusCode=500;res.end('Synthetic route failure');});
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('Loopback fixture unavailable');
 const origin=`http://127.0.0.1:${address.port}`,csrf=randomBytes(32).toString('hex');
 async function request(path:string,method:'GET'|'POST',body:unknown,person:Person='u1'){
  const user=fixture[person],token=await new SignJWT({role:'authenticated',aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setSubject(user.id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const response=await fetch(`${origin}${path}`,{method,redirect:'error',headers:{'content-type':'application/json',cookie:`sb-access-token=${token}; active_company_id=${user.companyId}; isaflow_csrf=${csrf}`,'x-csrf-token':csrf},
   ...(method==='GET'?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
  return{status:response.status,body:await response.json() as {success?:boolean;error?:unknown;data?:Record<string,unknown>}};
 }
 /** A supplier the predictor will match on description, with enough coding history for a 0.9 confidence. */
 async function predictableSupplier(key:'A'|'B',name:string){
  const id=randomUUID();
  await pool.query('INSERT INTO suppliers(id,company_id,name,is_active) VALUES($1,$2,$3,true)',[id,companies[key],name]);
  for(let row=0;row<3;row+=1)await pool.query("INSERT INTO supplier_coding_history(id,company_id,supplier_id,gl_account_id,vat_code,posted_at,posted_by) VALUES($1,$2,$3,$4,'none',NOW(),'synthetic')",
   [randomUUID(),companies[key],id,expense[key]]);
  return id;
 }
 /** Commits statement lines through the real import route, which runs the auto-post sweep. */
 async function commit(key:'A'|'B',person:Person,lines:{date:string;description:string;amount:string}[]){
  const csv=`Date,Description,Amount\n${lines.map(line=>`${line.date},${line.description},${line.amount}`).join('\n')}\n`;
  const response=await request('/api/accounting/bank-transactions-bulk-commit','POST',{bankAccountId:bank[key],bulkImportId:randomUUID(),bulkSequence:1,
   filename:`${randomUUID()}.csv`,fileType:'csv',bankFormat:'generic',statementDate:lines[0]!.date,csvContent:csv},person);
  const {rows}=await pool.query('SELECT * FROM bank_transactions WHERE company_id=$1 AND bank_account_id=$2 AND description=ANY($3::text[])',[companies[key],bank[key],lines.map(line=>line.description)]);
  const tx=new Map((rows as Row[]).map(row=>[String(row.description),row]));
  return{response,tx:(description:string)=>{const row=tx.get(description);if(!row)throw new Error(`Line not imported: ${description}`);return row;}};
 }
 /** An imported statement line written directly, for the routes that post one on demand. */
 async function imported(key:'A'|'B',description:string,amount:string,date='2026-09-15'){
  const id=randomUUID();
  await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,$4::date,$5::numeric,$6,'imported')",
   [id,companies[key],bank[key],date,amount,description]);
  return id;
 }
 async function bankTx(key:'A'|'B',id:string){
  return (await pool.query('SELECT * FROM bank_transactions WHERE company_id=$1 AND id=$2',[companies[key],id])).rows[0] as Row|undefined;
 }
 async function journal(key:'A'|'B',id:string){
  return (await pool.query('SELECT id,status,source,source_record_id,posting_agent,needs_evidence,extraction_confidence,reversed_at,entry_date::text AS entry_date FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[companies[key],id])).rows[0] as Row|undefined;
 }
 async function journalsFor(key:'A'|'B',bankTxId:string){
  return (await pool.query('SELECT id,status,source,reversal_of_id,entry_date::text AS entry_date FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2 ORDER BY created_at',[companies[key],bankTxId])).rows as Row[];
 }
 /** The controlled allocation's intent and receipt for a bank line, and the reversal receipts against it. */
 async function receipts(key:'A'|'B',bankTxId:string){
  const intents=(await pool.query('SELECT id FROM control_bank_allocation_intents WHERE company_id=$1 AND bank_transaction_id=$2',[companies[key],bankTxId])).rows as {id:string}[];
  const reversals=(await pool.query('SELECT * FROM control_bank_allocation_reversal_intents WHERE company_id=$1 AND bank_transaction_id=$2',[companies[key],bankTxId])).rows as Row[];
  const effects=(await pool.query("SELECT operation,entity_id,result FROM control_operation_effects WHERE company_id=$1 AND entity_type IN ('bank_allocation_intent','bank_allocation_reversal_intent') AND entity_id_canonical=ANY($2::text[])",
   [companies[key],[...intents.map(i=>i.id),...reversals.map(r=>String(r.id))]])).rows as Row[];
  return{intents,reversals,effects};
 }
 async function actor<T>(fn:()=>Promise<T>,person:Person='u1'){
  const client=await pool.connect(),user=fixture[person];
  try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
   await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
   const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},fn);await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 async function close(){await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await getAuthPool().end();await pool.end();}
 return{pool,fixture:fixture as ForensicFixture,companies,bank,expense,request,requireControlTx,predictableSupplier,commit,imported,bankTx,journal,journalsFor,receipts,actor,close};
}

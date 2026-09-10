import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';
import {withPlatformImportRequest,withPlatformImportTarget,type PlatformImportTarget} from '@/lib/auth/platformImportAuthority';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {historicalHash,storeHistoricalImportSource} from '@/modules/accounting/services/controls/historicalImportSourceService';
import {prepareHistoricalImport} from '@/modules/accounting/services/controls/historicalImportPreparation';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import {executeHistoricalImport} from '@/modules/accounting/services/controls/historicalImportExecution';
import type {ControlTx,OperationRef} from '@/modules/accounting/services/controls/contracts';
type Selection<T=PlatformImportTarget>=T extends PlatformImportTarget?Omit<T,'companyId'>:never;
export async function platformImportApprovalFixture(){
 process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
 const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
 const pool=new Pool({connectionString:target.connectionString,ssl:false,max:4,statement_timeout:10000});
 const f=await provisionForensicFixture(config),admin=randomUUID(),customer=randomUUID(),supplier=randomUUID(),revenue=randomUUID();
 await pool.query("INSERT INTO users(id,email,role,is_active,status) VALUES($1,$2,'super_admin',true,'active')",[admin,`${admin}@forensic.invalid`]);
 await pool.query("UPDATE companies SET default_currency='ZAR',lockdown_enabled=false WHERE id=$1",[f.companyA]);
 await pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'Platform synthetic customer')",[customer,f.companyA]);
 await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Platform synthetic supplier')",[supplier,f.companyA]);
 for(const [id,code,type,subtype] of [[randomUUID(),'PI-C','asset','receivable'],[revenue,'PI-R','revenue','default_revenue'],[randomUUID(),'PI-V','liability','vat_output'],[randomUUID(),'PI-P','liability','payable'],[randomUUID(),'PI-E','expense','default_expense'],[randomUUID(),'PI-I','asset','vat_input']])
  await pool.query('INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,level,is_system_account) VALUES($1,$2,$3,$3,$4,$5,$6,true,3,true)',[id,f.companyA,code,type,subtype,['liability','revenue'].includes(type)?'credit':'debit']);
 await pool.query("INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,'Platform synthetic historical February',2,2023,'2023-02-01','2023-02-28','closed')",[f.companyA]);
 async function maker<T>(selection:Selection,fn:(ctx:ControlTx)=>Promise<T>){
  const client=await pool.connect();const claims={sub:admin,role:'authenticated'};
  const store={client,userId:admin,claims};
  try{
   await client.query('BEGIN');await client.query('SET LOCAL ROLE platform_admin');
   const role=(await client.query('SELECT current_user AS name,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
   if(role.name!=='platform_admin'||role.rolbypassrls!==true)throw new Error('Actual platform_admin role required');
   await client.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify(claims)]);
   const result=await withPlatformImportRequest(store,cap=>withPlatformImportTarget(cap,{...selection,companyId:f.companyA},fn));
   if((await client.query('COMMIT')).command!=='COMMIT')throw new Error('Synthetic maker transaction failed');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 async function member<T>(person:string,fn:(ctx:ControlTx)=>Promise<T>,bearer=false){
  const client=await pool.connect(),claims={sub:person,company_id:f.companyA,role:'authenticated'};
  try{
   await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
   await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),f.companyA]);
   const token=f.u1.tokens[1]!;
   const result=await withControlRequest({client,userId:person,companyId:f.companyA,claims},{personId:person,companyId:f.companyA,authMethod:bearer?'pat':'cookie',
    ...(bearer?{grantId:token.id,connectionId:token.id,grantedScopes:['write:approvals','read:imports','write:imports','write:post','read:invoices','write:invoices','write:journals','read:reports']}:{})},()=>fn(requireControlTx()));
   if((await client.query('COMMIT')).command!=='COMMIT')throw new Error('Synthetic reviewer transaction failed');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 function body(kind:'customer_invoice'|'supplier_invoice'='customer_invoice'){
  const key=randomUUID(),ar=kind==='customer_invoice';return{version:1,sourceSystem:'csv' as const,sourceKey:key,kind,mode:'post_journal' as const,accountingDate:'2023-02-28',currency:'ZAR',records:[
   {recordId:'1',accountCode:ar?'PI-C':'PI-P',debit:ar?'1150':'0',credit:ar?'0':'1150',description:'Historical control'},
   {recordId:'2',accountCode:ar?'PI-R':'PI-E',debit:ar?'0':'1000',credit:ar?'1000':'0',description:'Historical net'},
   {recordId:'3',accountCode:ar?'PI-V':'PI-I',debit:ar?'0':'150',credit:ar?'150':'0',description:'Historical VAT'}],
   document:{partyId:ar?customer:supplier,invoiceNumber:key,dueDate:'2023-03-31',subtotal:'1000',taxAmount:'150',totalAmount:'1150',amountPaid:'0',settlements:[]}};
 }
 async function prepared(kind:'customer_invoice'|'supplier_invoice'='customer_invoice'){
  const source=body(kind),bytes=Buffer.from(JSON.stringify(source));
  const retained=await maker({action:'retain',sourceHash:historicalHash(bytes)},ctx=>storeHistoricalImportSource(ctx,{bytes,mimeType:'application/json'}));
  const result=await maker({action:'prepare',sourceId:retained.sourceId},ctx=>prepareHistoricalImport(ctx,{sourceSystem:'csv',sourceKey:source.sourceKey,kind,mode:'post_journal',accountingDate:'2023-02-28',evidenceId:retained.sourceId,sourceRecordIds:['1','2','3']}));
  const ref:OperationRef={entityType:'historical_import',entityId:result.importId,operation:'historical_import.post'};
  return{ref,retained,bytes};
 }
 const request=(ref:OperationRef)=>maker({action:'request',importId:ref.entityId},ctx=>requestOperationApproval(ctx,ref));
 const review=(id:string)=>member(f.u2.id,ctx=>decideOperationApproval(ctx,id,'approved'));
 const execute=(ref:OperationRef,id?:string)=>maker({action:'execute',importId:ref.entityId},ctx=>executeHistoricalImport(ctx,ref,id));
 async function noEffects(ref:OperationRef){
  return{journals:(await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[f.companyA,ref.entityId])).rowCount,
   effects:(await pool.query('SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2',[f.companyA,ref.entityId])).rowCount};
 }
 return{pool,f,admin,revenue,supplier,maker,member,body,prepared,request,review,execute,noEffects,close:()=>pool.end()};
}

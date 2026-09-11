import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import type {PoolClient} from 'pg';
import {authorityLockFixture,type Timed} from './authorityLockFixture';
import {heldWhile,refused,seedBulkPaths,toolText} from './authorityBulkSeed';
import {seedReleaseSupplier} from './paymentReleaseFixture';
import {ensureOpenPeriod} from '../forensic-fixture';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
/**
 * Opt-in measurement, not a gate: the company authority key hold of every path whose work per request is bounded by
 * the company's DATA (or a cap far above the bulk tools') rather than by an argument the caller sizes — a recurring run,
 * a depreciation run, a statement import with auto-posting rules, a payroll calculation and posting, a payment batch.
 * Set ISAFLOW_MEASURE_AUTHORITY_LONG_HOLD to a JSON output path (ISAFLOW_MEASURE_AUTHORITY_BULK_ONLY=<labels> for a subset).
 */
const out=process.env.ISAFLOW_MEASURE_AUTHORITY_LONG_HOLD;
let x:Awaited<ReturnType<typeof authorityLockFixture>>,sampler:PoolClient,seed:Awaited<ReturnType<typeof seedBulkPaths>>;
const dep={expense:randomUUID(),accumulated:randomUUID(),category:randomUUID()},pay={component:randomUUID()};
beforeAll(async()=>{
 if(!out)return;
 x=await authorityLockFixture();sampler=await x.pool.connect();seed=await seedBulkPaths(x);const company=x.f.companyA;
 await x.pool.query("UPDATE companies SET default_currency='ZAR',lockdown_enabled=false WHERE id=$1",[company]);
 for(const [id,code,type,subtype,side] of [[dep.expense,'5001','expense','depreciation_expense','debit'],[dep.accumulated,'1501','asset','accumulated_depreciation','credit']] as const)
  await x.pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level) VALUES($1,$2,$3,$4,$5,$4,$6,true,true,3)",[id,company,code,subtype,type,side]);
 await x.pool.query("INSERT INTO asset_categories(id,name,code,sars_rate,sars_years,useful_life_years,tax_life_years,capitalization_threshold) VALUES($1,$2,$2,20,5,5,5,0)",[dep.category,`SYNTHETIC-${dep.category}`]);
 for(const code of ['5200','2140','2150','2160','1110','2175'])await x.pool.query(
  "INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,is_active,level) VALUES($1,$2,$3,'Synthetic payroll account',$4,$5,true,3)",
  [randomUUID(),company,code,code==='5200'?'expense':'liability',code==='5200'?'debit':'credit']);
 await x.pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,'Synthetic basic','3601','earning')",[pay.component,company]);
},120000);
afterAll(async()=>{if(!out)return;sampler?.release();if(x)await x.close();});
const key=()=>randomUUID();
const actor=<T,>(person:'u1'|'u2',action:(ctx:ControlTx)=>Promise<T>)=>withAuditWorkerTransaction(x.pool,{companyId:x.f.companyA,personId:x.f[person].id,jobId:randomUUID()},'read committed',Date.now()+20000,undefined,
 store=>withControlRequest(store,{companyId:x.f.companyA,personId:x.f[person].id,authMethod:'cookie'},()=>action(requireControlTx())));
const csv=(lines:readonly string[])=>['date,description,amount',...lines].join('\n');
async function employees(n:number){const ids:string[]=[];for(let i=0;i<n;i++){const id=randomUUID();ids.push(id);
 await x.pool.query("INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status) VALUES($1,$2,$3,'Synthetic','Employee','2025-01-01','active')",[id,x.f.companyA,id.slice(0,12)]);
 await x.pool.query("INSERT INTO payroll_employee_components(id,employee_id,component_id,amount,effective_from) VALUES($1,$2,$3,10000,'2025-01-01')",[randomUUID(),id,pay.component]);}return ids;}
let payrollMonth=1,depMonth=1;
const paths:Record<string,(n:number)=>Promise<()=>Promise<Timed>>>={
 'REST recurring-invoices-run (all due)':async n=>{
  await x.pool.query("UPDATE recurring_invoices SET status='completed' WHERE company_id=$1",[x.f.companyA]);
  for(let i=0;i<n;i++)await x.pool.query(`INSERT INTO recurring_invoices(company_id,template_name,client_id,frequency,next_run_date,status,line_items,subtotal,tax_rate,tax_amount,total_amount,created_by,currency_code)
   VALUES($1,$2,$3,'monthly',CURRENT_DATE-1,'active',$4::jsonb,100,15,15,115,$5,'ZAR')`,[x.f.companyA,`Synthetic ${i}`,seed.seeded.customer,JSON.stringify([{description:'Synthetic recurring',quantity:1,unitPrice:100}]),x.f.u1.id]);
  return()=>x.rest('POST','/api/accounting/recurring-invoices-run',{});},
 'REST run-depreciation (all assets)':async n=>{
  await x.pool.query("UPDATE assets SET status='disposed',disposal_date='2026-01-15' WHERE company_id=$1",[x.f.companyA]);
  for(let i=0;i<n;i++)await x.pool.query(`INSERT INTO assets(id,company_id,category_id,asset_number,name,purchase_date,purchase_price,useful_life_years,tax_useful_life_years,gl_asset_account_id,gl_depreciation_account_id,gl_expense_account_id,status)
   VALUES($1,$2,$3,$4,'Synthetic asset','2026-01-01',12000,5,5,$5,$6,$7,'available')`,[randomUUID(),x.f.companyA,dep.category,`SYN-${randomUUID().slice(0,8)}`,seed.seeded.contra,dep.accumulated,dep.expense]);
  const month=String(depMonth++).padStart(2,'0');await ensureOpenPeriod(x.pool,x.f.companyA,`2026-${month}-28`,`Synthetic depreciation ${month}`);
  return()=>x.rest('POST','/api/accounting/run-depreciation',{periodDate:`2026-${month}-28`});},
 'REST bank-transactions-bulk-commit with an auto-posting rule':async n=>{
  const rule=`SYNRULE${randomUUID().slice(0,8)}`;
  await x.pool.query("INSERT INTO bank_categorisation_rules(company_id,rule_name,match_field,match_type,match_pattern,gl_account_id,auto_create_entry,is_active) VALUES($1,$2::text,'description','contains',$2::text,$3,true,true)",[x.f.companyA,rule,seed.seeded.contra]);
  const lines=Array.from({length:n},(_,i)=>`2026-09-15,${rule} line ${randomUUID().slice(0,8)},-${(100+i).toFixed(2)}`);
  return()=>x.rest('POST','/api/accounting/bank-transactions-bulk-commit',{bankAccountId:seed.seeded.bank,bulkImportId:randomUUID(),bulkSequence:1,filename:'synthetic.csv',fileType:'csv',
   statementDate:'2026-09-30',csvContent:csv(lines),bankFormat:'generic',applyBankRules:true});},
 'REST bank-transactions-bulk-commit without rules':async n=>{
  const lines=Array.from({length:n},(_,i)=>`2026-09-15,Plain line ${randomUUID().slice(0,8)},-${(100+i).toFixed(2)}`);
  return()=>x.rest('POST','/api/accounting/bank-transactions-bulk-commit',{bankAccountId:seed.seeded.bank,bulkImportId:randomUUID(),bulkSequence:1,filename:'synthetic.csv',fileType:'csv',
   statementDate:'2026-09-30',csvContent:csv(lines),bankFormat:'generic',applyBankRules:false});},
 'MCP import_bank_statement':async n=>{
  const lines=Array.from({length:n},(_,i)=>`2026-09-15,MCP line ${randomUUID().slice(0,8)},-${(100+i).toFixed(2)}`);
  return()=>x.mcp('import_bank_statement',{bank_account_id:seed.seeded.bank,file_type:'csv',content:csv(lines),statement_date:'2026-09-30',bank_format:'generic',idempotency_key:key()});},
 'MCP calculate_pay_run (all employees)':async n=>{
  await x.pool.query("UPDATE payroll_employees SET status='terminated',end_date='2026-01-31' WHERE company_id=$1",[x.f.companyA]);
  await employees(n);const run=randomUUID(),month=payrollMonth++;
  await x.pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status,total_gross,total_paye,total_uif,total_sdl,total_eti,total_net,employee_count) VALUES($1,$2,$3,2026,'draft',0,0,0,0,0,0,0)",[run,x.f.companyA,month]);
  return()=>x.mcp('calculate_pay_run',{run_id:run,idempotency_key:key()});},
 'MCP post_payroll_journal (one run)':async n=>{
  // A real run: calculated by u1 and approved by u2 through the tools, so the posting sees a current calculation.
  await x.pool.query("UPDATE payroll_employees SET status='terminated',end_date='2026-01-31' WHERE company_id=$1",[x.f.companyA]);
  await employees(n);const run=randomUUID(),month=payrollMonth++;
  // The posting dates the journal on the month's last day and needs exactly one open period covering it.
  await x.pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,$3,$4+20,2026,make_date(2026,$4,1),(make_date(2026,$4,1)+interval '1 month'-interval '1 day')::date,'open')",[randomUUID(),x.f.companyA,`Synthetic payroll ${month}`,month]);
  await x.pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status,total_gross,total_paye,total_uif,total_sdl,total_eti,total_net,employee_count) VALUES($1,$2,$3,2026,'draft',0,0,0,0,0,0,0)",[run,x.f.companyA,month]);
  const calculated=await x.mcp('calculate_pay_run',{run_id:run,idempotency_key:key()});if(refused(calculated))throw new Error(`calculate_pay_run: ${toolText(calculated).slice(0,300)}`);
  await x.pool.query("UPDATE payroll_run_headers SET status='approved' WHERE company_id=$1 AND id=$2",[x.f.companyA,run]);
  const preview=await x.mcp('post_payroll_journal',{run_id:run,dry_run:true,idempotency_key:key()});if(refused(preview))throw new Error(`payroll preview: ${toolText(preview).slice(0,300)}`);
  return()=>x.mcp('post_payroll_journal',{run_id:run,idempotency_key:key()});},
 'REST batch-payments process (one batch)':async n=>{
  const payments:Array<{supplierId:string;invoiceAllocations:Array<{invoiceId:string;amount:number}>}>=[];
  for(let i=0;i<n;i++){
   // A payment needs an independently verified beneficiary: the real proposal and verification, per supplier.
   const {supplier}=await seedReleaseSupplier(x.pool,x.f,actor);
   const invoice=randomUUID();
   await x.pool.query("INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,subtotal,tax_amount,total_amount,amount_paid,status,created_by) VALUES($1,$2,$3,$4,'2026-09-15',100,0,100,0,'approved',$5)",[invoice,x.f.companyA,supplier,invoice.slice(0,20),x.f.u1.id]);
   await x.pool.query("INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,line_total,tax_amount) VALUES($1,'Synthetic batch line',1,100,100,0)",[invoice]);
   const posted=await x.rest('POST','/api/accounting/supplier-invoices-bulk-action',{action:'post_gl',invoiceIds:[invoice]});
   if(posted.status!==200)throw new Error(`post_gl: ${JSON.stringify(posted.body).slice(0,300)}`);
   payments.push({supplierId:supplier,invoiceAllocations:[{invoiceId:invoice,amount:100}]});}
  const created=await x.rest('POST','/api/accounting/batch-payments',{payments,bankAccountId:seed.seeded.bank,paymentMethod:'eft',batchDate:'2026-09-15'});
  if(created.status!==200)throw new Error(`batch create: ${JSON.stringify(created.body).slice(0,300)}`);
  const id=(created.body as {data:{id:string}}).data.id;
  const approved=await x.rest('POST','/api/accounting/batch-payments-action',{action:'approve',id},'u2');
  if(approved.status!==200)throw new Error(`batch approve: ${JSON.stringify(approved.body).slice(0,300)}`);
  return()=>x.rest('POST','/api/accounting/batch-payments-action',{action:'process',id});},
};

it.skipIf(!out)('measures the authority key hold of every data-bounded long path at 1 and 10 elements',async()=>{
 const result:Record<string,unknown>={},only=process.env.ISAFLOW_MEASURE_AUTHORITY_BULK_ONLY?.split(',');
 for(const [label,prepare] of Object.entries(paths).filter(([label])=>!only||only.includes(label))){
  const rows:Array<{n:number;holdMs:number;requestMs:number;refused:boolean;body:string}>=[];
  for(const n of [1,1,10,10,10]){
   let run:()=>Promise<Timed>;
   try{run=await prepare(n);}catch(error){rows.push({n,holdMs:-1,requestMs:-1,refused:true,body:`prepare: ${String(error).slice(0,300)}`});continue;}
   const {holdMs,row}=await heldWhile(x,sampler,run);
   rows.push({n,holdMs,requestMs:row.ms,refused:refused(row),body:(toolText(row)||JSON.stringify(row.body)).slice(0,240)});
  }
  const at=(n:number)=>Math.max(...rows.filter(r=>r.n===n).map(r=>r.holdMs));
  const perElement=(at(10)-at(1))/9,fixed=Math.max(0,at(1)-perElement);
  result[label]={runs:rows,perElementMs:Math.round(perElement*10)/10,fixedMs:Math.round(fixed),maxFor2500ms:perElement>0?Math.floor((2500-fixed)/perElement):null};
  writeFileSync(out!,JSON.stringify(result,null,1));
 }
 expect(Object.keys(result).length).toBeGreaterThan(0);
},1200000);

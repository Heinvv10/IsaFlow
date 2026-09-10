import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';
import {seedApAccounts} from './apSyntheticAccounts';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import type {ControlTx,OperationRef} from '@/modules/accounting/services/controls/contracts';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import {approveSupplierInvoice,cancelSupplierInvoice} from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import {processSupplierPayment,voidSupplierPayment} from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
export async function apCiWorkflowFixture(){
 const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
 process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
 process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
 const pool=new Pool({connectionString:target.connectionString,ssl:false,max:4,statement_timeout:10000});
 try{
 const f=await provisionForensicFixture(config),accounts=await seedApAccounts(pool,f.companyA),supplier=randomUUID();
 await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic AP CI supplier')",[supplier,f.companyA]);
 await pool.query("INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,'AP CI September',9,2026,'2026-09-01','2026-09-30','open')",[f.companyA]);
 for(const type of ['supplier_invoice','payment'])await pool.query("INSERT INTO approval_rules(company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role) VALUES($1,'AP CI independent policy',$2,'amount','any',0,'admin')",[f.companyA,type]);
 async function actor<T>(fn:(ctx:ControlTx)=>Promise<T>,person:'u1'|'u2'|'u3'='u1'){
  const client=await pool.connect(),u=f[person];
  try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');const claims={sub:u.id,company_id:u.companyId,role:'authenticated'};
   await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),u.companyId]);
   const value=await withControlRequest({client,userId:u.id,companyId:u.companyId,claims},{personId:u.id,companyId:u.companyId,authMethod:'cookie'},()=>fn(requireControlTx()));
   if((await client.query('COMMIT')).command!=='COMMIT')throw new Error('Synthetic AP transaction failed to commit');return value;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 async function approve(ref:OperationRef){const row=await actor(ctx=>requestOperationApproval(ctx,ref));await actor(ctx=>decideOperationApproval(ctx,row.id,'approved'),'u2');return row.id;}
 async function invoice(){const id=randomUUID();
  await pool.query("INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,subtotal,tax_rate,tax_amount,total_amount,currency,status,created_by) VALUES($1,$2,$3,left($1::uuid::text,28),'2026-09-09',100,15,15,115,'ZAR','draft',$4)",[id,f.companyA,supplier,f.u1.id]);
  await pool.query("INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,line_total,tax_rate,tax_amount,gl_account_id) VALUES($1,'Actual AP CI expense',1,100,100,15,15,$2)",[id,accounts.default_expense]);return id;
 }
 const ref=(operation:OperationRef['operation'],id:string):OperationRef=>({operation,entityId:id,entityType:operation.startsWith('supplier_invoice.')?'supplier_invoice':operation.startsWith('supplier_payment_batch.')?'supplier_payment_batch':'supplier_payment'});
 async function post(id:string){const approvalId=await approve(ref('supplier_invoice.post',id));return actor(()=>approveSupplierInvoice(f.companyA,id,f.u1.id,{approvalId}));}
 async function cancel(id:string,approvalId?:string){return actor(()=>cancelSupplierInvoice(f.companyA,id,f.u1.id,{approvalId}));}
 async function payment(invoiceId:string,bank=accounts.bank){const id=randomUUID();
  await pool.query("INSERT INTO supplier_payments(id,company_id,supplier_id,payment_number,payment_date,total_amount,status,bank_account_id,created_by) VALUES($1,$2,$3,left($1::uuid::text,28),'2026-09-09',115,'approved',$4,$5)",[id,f.companyA,supplier,bank,f.u1.id]);
  await pool.query('INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,115)',[id,invoiceId]);return id;
 }
 async function process(id:string){const approvalId=await approve(ref('supplier_payment.process',id));return actor(()=>processSupplierPayment(f.companyA,id,f.u1.id,{approvalId}));}
 const voidPayment=(id:string,approvalId?:string)=>actor(()=>voidSupplierPayment(f.companyA,id,f.u1.id,{approvalId}));
 async function state(){const result:Record<string,unknown>={};
  for(const table of ['supplier_invoices','supplier_payments','gl_journal_entries','gl_journal_lines','control_change_events','control_operation_effects','control_entity_versions','control_protected_evidence']){
   result[table]=(await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE company_id=$1 ORDER BY to_jsonb(t)::text`,[f.companyA])).rows;
  }
  result.allocations=(await pool.query('SELECT to_jsonb(a) AS row FROM payment_allocations a JOIN supplier_payments p ON p.id=a.payment_id WHERE p.company_id=$1 ORDER BY a.id',[f.companyA])).rows;return result;
 }
 return{pool,f,accounts,supplier,actor,approve,invoice,post,cancel,payment,process,voidPayment,ref,state,close:()=>pool.end()};
 }catch(error){await pool.end();throw error;}
}

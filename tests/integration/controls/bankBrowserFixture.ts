import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';
/** Synthetic-only browser seed; all decisions and financial operations belong to the actual browser. */
export async function bankBrowserFixture(){
 const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
 if(!process.env.DATABASE_URL||new URL(process.env.DATABASE_URL).toString()!==target.connectionString)throw new Error('Browser app must use the exact validated synthetic fixture database');
 const fixture=await provisionForensicFixture(config),pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});
 const bank=randomUUID(),expense=randomUUID(),vat=randomUUID(),customer=randomUUID(),supplier=randomUUID();
 try{
  await pool.query('UPDATE users SET onboarding_completed=true WHERE id=ANY($1::text[])',[[fixture.u1.id,fixture.u2.id,fixture.u3.id]]);
  await pool.query("INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role) VALUES($1,$2,'Synthetic browser independent approval','payment','amount','any',0,'admin')",[randomUUID(),fixture.companyA]);
  await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic browser September',9,2026,'2026-09-01','2026-09-30','open')",[randomUUID(),fixture.companyA]);
  for(const [id,code,name,type,subtype] of [[bank,'1000','Browser bank','asset','bank'],[expense,'4000','Browser office costs','expense','default_expense'],[vat,'1140','Browser input VAT','asset','vat_input'],[randomUUID(),'1100','Browser receivables','asset','receivable'],[randomUUID(),'2100','Browser payables','liability','payable'],[randomUUID(),'5000','Browser revenue','revenue','default_revenue'],[randomUUID(),'2120','Browser output VAT','liability','vat_output']])
   await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account) VALUES($1,$2,$3,$4,$5,$6,'debit',true,true)",[id,fixture.companyA,code,name,type,subtype]);
  await pool.query("INSERT INTO bank_accounts(company_id,account_name,gl_account_id,currency) VALUES($1,'Browser bank',$2,'ZAR')",[fixture.companyA,bank]);
  await pool.query("INSERT INTO customers(id,company_id,name,auto_allocate_strategy) VALUES($1,$2,'Browser customer','oldest')",[customer,fixture.companyA]);
  await pool.query("INSERT INTO suppliers(id,company_id,name,auto_allocate_strategy) VALUES($1,$2,'Browser supplier','oldest')",[supplier,fixture.companyA]);
  async function source(description:string,amount:string,kind:'account'|'customer'|'supplier'='account'){
   const id=randomUUID();await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,status,description,suggested_gl_account_id,suggested_client_id,suggested_supplier_id,suggested_vat_code) VALUES($1,$2,$3,'2026-09-09',$4,'imported',$5,$6,$7,$8,$9)",
    [id,fixture.companyA,bank,amount,description,kind==='account'?expense:null,kind==='customer'?customer:null,kind==='supplier'?supplier:null,kind==='account'?'standard':'none']);return id;
  }
  async function draftCustomerInvoice(date:string){
   const id=randomUUID();
   await pool.query("INSERT INTO customer_invoices(id,company_id,customer_id,invoice_number,invoice_date,subtotal,total_amount,currency_code,exchange_rate,functional_total,created_by) VALUES($1,$2,$3,$1::uuid::text,$4,100,100,'ZAR',1,100,$5)",[id,fixture.companyA,customer,date,fixture.u1.id]);
   await pool.query("INSERT INTO customer_invoice_items(invoice_id,description,quantity,unit_price,amount,tax_rate) VALUES($1,'Synthetic browser default source',1,100,100,0)",[id]);return id;
  }
  async function draftSupplierInvoice(date:string){
   const id=randomUUID();
   await pool.query("INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,subtotal,total_amount,currency,created_by) VALUES($1,$2,$3,$1::uuid::text,$4,100,100,'ZAR',$5)",[id,fixture.companyA,supplier,date,fixture.u1.id]);
   await pool.query("INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,line_total,tax_rate,tax_amount,gl_account_id) VALUES($1,'Synthetic browser supplier source',1,100,100,0,0,$2)",[id,expense]);return id;
  }
  return{fixture,pool,bank,expense,vat,customer,supplier,source,draftCustomerInvoice,draftSupplierInvoice,close:()=>pool.end()};
 }catch(error){await pool.end();throw error;}
}

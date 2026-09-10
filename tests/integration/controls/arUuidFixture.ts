import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
/** Plain source rows shared by the current-code suite and the fad0f57f7 legacy runner; no control state is preverified. */
export async function seedArCompany(pool:Pool,company:string):Promise<string>{
 const customer=randomUUID();
 await pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'Synthetic UUID AR customer')",[customer,company]);
 await pool.query(`INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
  VALUES($1,'Synthetic UUID AR July',7,2026,'2026-07-01','2026-07-31','open')`,[company]);
 const roles={receivable:'asset',default_revenue:'revenue',vat_output:'liability',bank:'asset',payable:'liability',default_expense:'expense',vat_input:'asset'};
 for(const [role,type] of Object.entries(roles)){
  await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
   VALUES($1,$2,left($1::uuid::text,12),$3,$4,$5,$6,true,true)`,[randomUUID(),company,`UUID AR ${role}`,type,role,['liability','revenue'].includes(type)?'credit':'debit']);
 }
 return customer;
}
export async function seedArInvoice(pool:Pool,company:string,customer:string,userId:string):Promise<string>{
 const id=randomUUID();
 await pool.query(`INSERT INTO customer_invoices(id,company_id,client_id,customer_id,invoice_number,invoice_date,subtotal,tax_amount,total_amount,
  currency_code,exchange_rate,functional_total,created_by,status) VALUES($1,$2,$3,$3,$1::uuid::text,'2026-07-05',100,15,115,'ZAR',1,115,$4,'draft')`,[id,company,customer,userId]);
 await pool.query("INSERT INTO customer_invoice_items(invoice_id,description,quantity,unit_price,amount,tax_rate) VALUES($1,'Synthetic UUID AR service',1,100,100,15)",[id]);
 if(id.toUpperCase()===id)throw new Error('Synthetic UUID lacks case distinction');
 return id;
}

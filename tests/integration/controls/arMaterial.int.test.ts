import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {materializeArOperation} from '@/modules/accounting/services/controls/arOperationMaterializer';
import type {OperationRef} from '@/modules/accounting/services/controls/contracts';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});
let fixture:ForensicFixture;const customer=randomUUID();
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);
 await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)',[customer,fixture.companyA,'Synthetic AR material customer']);
 await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
 VALUES($1,$2,'Synthetic AR September',9,2026,'2026-09-01','2026-09-30','open')`,[randomUUID(),fixture.companyA]);
 for(const [role,type] of Object.entries({receivable:'asset',default_revenue:'revenue',vat_output:'liability',bank:'asset',payable:'liability',default_expense:'expense',vat_input:'asset'})){
  const id=randomUUID();await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
  VALUES($1,$2,$3,$4,$5,$6,$7,true,true)`,[id,fixture.companyA,id.slice(0,12),`Synthetic AR ${role}`,type,role,['liability','revenue'].includes(type)?'credit':'debit']);
 }
});
afterAll(async()=>{await pool.end();});
async function inspect(ref:OperationRef,person:'u1'|'u3'='u1'){
 const user=fixture[person],client=await pool.connect();
 try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify({sub:user.id,role:'authenticated',company_id:user.companyId}),user.companyId]);
  const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims:{}},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>materializeArOperation(requireControlTx(),ref));
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function invoice(currency='ZAR'){
 const id=randomUUID();await pool.query(`INSERT INTO customer_invoices(id,company_id,customer_id,client_id,invoice_number,invoice_date,subtotal,tax_amount,total_amount,currency_code,exchange_rate,functional_total,created_by)
 VALUES($1,$2,$3,$3,$4,'2026-09-09',100,15,115,$5,1,115,$6)`,[id,fixture.companyA,customer,id,currency,fixture.u1.id]);
 await pool.query(`INSERT INTO customer_invoice_items(invoice_id,description,quantity,unit_price,amount,tax_rate) VALUES($1,'Service',1,100,100,15)`,[id]);return id;
}
async function payment(invoiceId:string,currency:string|null='ZAR'){
 const id=randomUUID();await pool.query(`INSERT INTO customer_payments(id,company_id,client_id,payment_number,payment_date,total_amount,currency_code,created_by)
 VALUES($1,$2,$3,$4,'2026-09-09',115,$5,$6)`,[id,fixture.companyA,customer,id.slice(0,28),currency,fixture.u1.id]);
 await pool.query('INSERT INTO customer_payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,115)',[id,invoiceId]);return id;
}
async function note(invoiceId:string){
 const id=randomUUID();await pool.query(`INSERT INTO credit_notes(id,company_id,type,client_id,customer_invoice_id,credit_note_number,credit_date,subtotal,tax_amount,total_amount,currency_code,created_by)
 VALUES($1,$2,'customer',$3,$4,$5,'2026-09-09',100,15,115,'ZAR',$6)`,[id,fixture.companyA,customer,invoiceId,id.slice(0,28),fixture.u1.id]);return id;
}
const invoiceRef=(id:string):OperationRef=>({entityType:'customer_invoice',entityId:id,operation:'customer_invoice.post'});
it('materializes exact owned invoice sources under app_user without recording events or effects',async()=>{
 const id=await invoice(),result=await inspect(invoiceRef(id));expect(result.binding).toMatchObject({amount:'115',currency:'ZAR',accountingDate:'2026-09-09'});
 expect(result.versionBasis).toBe('untracked_current_observation');
 for(const table of ['control_change_events','control_operation_effects']){
  const result=table==='control_change_events'?await pool.query('SELECT id FROM control_change_events WHERE company_id=$1',[fixture.companyA]):await pool.query('SELECT id FROM control_operation_effects WHERE company_id=$1',[fixture.companyA]);expect(result.rows).toHaveLength(0);
 }
});
it('refuses foreign tenant lookup and unsupported invoice/payment nominal currency',async()=>{
 const id=await invoice('USD');await expect(inspect(invoiceRef(id))).rejects.toThrow('currency');await expect(inspect(invoiceRef(id),'u3')).rejects.toThrow('not found');
 const paymentId=await payment(id,'USD');await expect(inspect({entityType:'customer_payment',entityId:paymentId,operation:'customer_payment.confirm'})).rejects.toThrow('currency');
});
it('derives unambiguous legacy payment currency and binds full allocated invoice changes',async()=>{
 const id=await invoice(),paymentId=await payment(id,null),ref:OperationRef={entityType:'customer_payment',entityId:paymentId,operation:'customer_payment.confirm'};
 const first=await inspect(ref);expect(first.binding.currency).toBe('ZAR');expect(first.observedSources.some(s=>s.entityId===id)).toBe(true);
 await pool.query("UPDATE customer_invoices SET internal_notes='Synthetic material edit' WHERE company_id=$1 AND id=$2",[fixture.companyA,id]);
 const second=await inspect(ref);expect(second.binding.sourceVersions).not.toEqual(first.binding.sourceVersions);
});
it('binds current ledger currency and refuses its change after observation',async()=>{
 const id=await invoice();await inspect(invoiceRef(id));await pool.query("UPDATE companies SET default_currency='USD' WHERE id=$1",[fixture.companyA]);
 try{await expect(inspect(invoiceRef(id))).rejects.toThrow('currency');}finally{await pool.query("UPDATE companies SET default_currency='ZAR' WHERE id=$1",[fixture.companyA]);}
});
it('resolves a credit application through immutable owned intent and exact remaining balance',async()=>{
 const id=await invoice(),credit=await note(id),application=randomUUID();await pool.query('UPDATE customer_invoices SET amount_paid=15 WHERE company_id=$1 AND id=$2',[fixture.companyA,id]);
 await pool.query('INSERT INTO control_credit_note_applications(company_id,id,credit_note_id,customer_invoice_id,requester_person_id) VALUES($1,$2,$3,$4,$5)',[fixture.companyA,application,credit,id,fixture.u1.id]);
 expect((await inspect({entityType:'credit_note',entityId:credit,operation:'credit_note.approve'})).binding.amount).toBe('115');
 const result=await inspect({entityType:'credit_note_application',entityId:application,operation:'credit_note_application.apply'});expect(result.binding.amount).toBe('100');
 await expect(inspect({entityType:'credit_note_application',entityId:application,operation:'credit_note_application.apply'},'u3')).rejects.toThrow('not found');
});
it('binds persisted prepared recurring invoice and rejects changed template lines',async()=>{
 const id=await invoice(),template=randomUUID(),run=randomUUID();
 await pool.query(`INSERT INTO recurring_invoices(id,company_id,template_name,client_id,frequency,next_run_date,line_items,subtotal,tax_rate,tax_amount,total_amount,currency_code,created_by)
 VALUES($1,$2,'Synthetic controlled run',$3,'monthly','2026-09-09',$4::jsonb,100,15,15,115,'ZAR',$5)`,[template,fixture.companyA,customer,JSON.stringify([{description:'Service',quantity:1,unitPrice:100}]),fixture.u1.id]);
 await pool.query('INSERT INTO control_recurring_invoice_runs(company_id,id,template_id,scheduled_date,invoice_id,requester_person_id) VALUES($1,$2,$3,$4,$5,$6)',[fixture.companyA,run,template,'2026-09-09',id,fixture.u1.id]);
 const ref:OperationRef={entityType:'recurring_invoice_run',entityId:run,operation:'recurring_invoice.generate'};expect((await inspect(ref)).binding.amount).toBe('115');
 await pool.query('UPDATE recurring_invoices SET line_items=$1::jsonb WHERE company_id=$2 AND id=$3',[JSON.stringify([{description:'Changed service',quantity:1,unitPrice:100}]),fixture.companyA,template]);
 await expect(inspect(ref)).rejects.toThrow('match');
});

import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:1});
let fixture:ForensicFixture;
beforeAll(async()=>{fixture=await provisionForensicFixture(config);});
afterAll(()=>pool.end());
for(const kind of ['customer','supplier'] as const)it(`${kind} preserves allocations across inverse and reapplication and refuses changed or foreign lineage`,async()=>{
 const db=await pool.connect();
 const party=randomUUID(),payment=randomUUID(),invoice=randomUUID(),intent=randomUUID(),second=randomUUID(),inverse=randomUUID(),allocation=randomUUID();
 // Table identifiers are this test's fixed two schema alternatives, never user input.
 const table=kind==='customer'?'customer_payment_allocations':'payment_allocations';
 try{
  await db.query('BEGIN');
  if(kind==='customer'){
   await db.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'Synthetic history')",[party,fixture.companyA]);
   await db.query("INSERT INTO customer_payments(id,company_id,client_id,payment_date,total_amount,created_by) VALUES($1,$2,$3,'2026-09-09',100,$4)",[payment,fixture.companyA,party,fixture.u1.id]);
   await db.query("INSERT INTO customer_invoices(id,company_id,customer_id,client_id,invoice_number,invoice_date,total_amount,created_by) VALUES($1,$2,$3,$3,$1::uuid::text,'2026-09-09',100,$4)",[invoice,fixture.companyA,party,fixture.u1.id]);
  }else{
   await db.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic history')",[party,fixture.companyA]);
   await db.query("INSERT INTO supplier_payments(id,company_id,supplier_id,payment_date,total_amount,created_by) VALUES($1,$2,$3,'2026-09-09',100,$4)",[payment,fixture.companyA,party,fixture.u1.id]);
   await db.query("INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,total_amount,created_by) VALUES($1,$2,$3,$1::uuid::text,'2026-09-09',100,$4)",[invoice,fixture.companyA,party,fixture.u1.id]);
  }
  const payload=JSON.stringify({version:1,kind,applications:[{invoiceId:invoice,amount:'20.00'}]});
  for(const id of [intent,second])await db.query("INSERT INTO control_cash_application_intents(company_id,id,requester_person_id,payment_id,kind,accounting_date,amount,currency,payload,source_fingerprint) VALUES($1,$2,$3,$4,$5,'2026-09-09',20,'ZAR',$6,repeat('a',64))",[fixture.companyA,id,fixture.u1.id,payment,kind,payload]);
  await db.query(`INSERT INTO ${table}(id,payment_id,invoice_id,amount_allocated,application_intent_id) VALUES($1,$2,$3,20,$4)`,[allocation,payment,invoice,intent]);
  async function refused(sql:string,args:unknown[],pattern:RegExp){
   await db.query('SAVEPOINT refusal');
   await expect(db.query(sql,args)).rejects.toThrow(pattern);
   await db.query('ROLLBACK TO SAVEPOINT refusal');
  }
  await refused(`UPDATE ${table} SET amount_allocated=21 WHERE id=$1`,[allocation],/immutable/);
  await refused(`DELETE FROM ${table} WHERE id=$1`,[allocation],/cannot be deleted/);
  await refused(`UPDATE ${table} SET application_intent_id=$2 WHERE id=$1`,[allocation,second],/reassigned/);
  await db.query("INSERT INTO control_cash_application_reversal_intents(company_id,id,requester_person_id,original_intent_id,reversal_date,reason) VALUES($1,$2,$3,$4,'2026-09-10','Synthetic inverse')",[fixture.companyA,inverse,fixture.u1.id,second]);
  await refused(`UPDATE ${table} SET reversed_at=clock_timestamp(),reversal_intent_id=$2 WHERE id=$1`,[allocation,inverse],/original intent/);
  const correctInverse=randomUUID();
  await db.query("INSERT INTO control_cash_application_reversal_intents(company_id,id,requester_person_id,original_intent_id,reversal_date,reason) VALUES($1,$2,$3,$4,'2026-09-10','Synthetic inverse')",[fixture.companyA,correctInverse,fixture.u1.id,intent]);
  await db.query(`UPDATE ${table} SET reversed_at=clock_timestamp(),reversal_intent_id=$2 WHERE id=$1`,[allocation,correctInverse]);
  await refused(`UPDATE ${table} SET reversed_at=NULL,reversal_intent_id=NULL WHERE id=$1`,[allocation],/immutable/);
  await db.query(`INSERT INTO ${table}(payment_id,invoice_id,amount_allocated,application_intent_id) VALUES($1,$2,20,$3)`,[payment,invoice,second]);
  expect((await db.query(`SELECT count(*)::int AS count,sum(amount_allocated)::text AS total FROM ${table} WHERE payment_id=$1`,[payment])).rows[0]).toEqual({count:2,total:'40.00'});
  expect((await db.query(`SELECT sum(amount_allocated)::text AS total FROM ${table} WHERE payment_id=$1 AND reversed_at IS NULL`,[payment])).rows[0].total).toBe('20.00');
  await refused("INSERT INTO control_cash_application_intents(company_id,requester_person_id,payment_id,kind,accounting_date,amount,currency,payload,source_fingerprint) VALUES($1,$2,$3,$4,'2026-09-09',20,'ZAR',$5,repeat('b',64))",[fixture.companyB,fixture.u3.id,payment,kind,payload],/foreign key/);
  await db.query('SET LOCAL ROLE app_user');
  await db.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify({sub:fixture.u1.id,role:'authenticated',company_id:fixture.companyA}),fixture.companyA]);
  expect((await db.query('SELECT id FROM control_cash_application_intents WHERE company_id=$1 AND payment_id=$2',[fixture.companyA,payment])).rows).toHaveLength(2);
  await refused('UPDATE control_cash_application_intents SET amount=21 WHERE company_id=$1 AND id=$2',[fixture.companyA,intent],/permission denied/);
  await db.query(`UPDATE ${table} SET reversed_at=reversed_at WHERE id=$1`,[allocation]);
  await db.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify({sub:fixture.u3.id,role:'authenticated',company_id:fixture.companyB}),fixture.companyB]);
  expect((await db.query('SELECT id FROM control_cash_application_intents WHERE company_id=$1 AND payment_id=$2',[fixture.companyA,payment])).rows).toHaveLength(0);
 }finally{await db.query('ROLLBACK');db.release();}
});

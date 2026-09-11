import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {ForensicFixture} from '../forensic-fixture';
import {asPerson} from './approvalGuardBypass';
/** Synthetic corrupt-history observation only. This bypasses no production constraint and never calls a financial writer/provider. */
export async function seedRiskAttemptHistory(pool:Pool,f:ForensicFixture,supplier:string,invoice:string){
 const batch=randomUUID(),payment=randomUUID(),preparation=randomUUID();
 await pool.query(`INSERT INTO supplier_payment_batches(id,company_id,batch_number,batch_date,total_amount,payment_count,payment_method,status,created_by)
 VALUES($1::uuid,$2,$1::text,'2026-09-09',1150,1,'eft','processed',$3)`,[batch,f.companyA,f.u1.id]);
 await pool.query(`INSERT INTO supplier_payments(id,company_id,supplier_id,payment_date,total_amount,status,batch_id,created_by)
 VALUES($1,$2,$3,'2026-09-09',1150,'processed',$4,$5)`,[payment,f.companyA,supplier,batch,f.u1.id]);
 await pool.query('INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,1150)',[payment,invoice]);
 await pool.query(`INSERT INTO control_payment_preparations(company_id,id,payment_id,supplier_id,beneficiary_version_id,beneficiary_version,
 beneficiary_fingerprint,payment_fingerprint,amount,currency,prepared_by_person_id)
 SELECT $1,$2,$3,$4,id,version,fingerprint,repeat('a',64),1150,'ZAR',$5 FROM control_beneficiary_versions
 WHERE company_id=$1 AND entity_type='supplier' AND entity_id=$4 ORDER BY version DESC LIMIT 1`,[f.companyA,preparation,payment,supplier,f.u1.id]);
 async function addAttempt(){
  const intent=randomUUID(),approval=randomUUID();
  await pool.query(`INSERT INTO control_payment_release_intents(company_id,id,batch_id,channel,bank_format,requester_person_id,requester_auth_method,
 payload_envelope,payload_hash,amount,currency,accounting_date) VALUES($1,$2,$3,'eft','fnb',$4,'cookie','{}',repeat('b',64),1150,'ZAR','2026-09-09')`,[f.companyA,intent,batch,f.u1.id]);
  await pool.query(`INSERT INTO control_payment_release_items(company_id,intent_id,payment_id,preparation_id) VALUES($1,$2,$3,$4)`,[f.companyA,intent,payment,preparation]);
  // The intent's requester asks for the approval, as themselves (688).
  await asPerson(pool,f.u1,[[`INSERT INTO control_operation_approvals(company_id,id,operation_id,operation,entity_type,entity_id,requester_person_id,binding,binding_hash,status,expires_at)
 VALUES($1,$2,$3,'payment_release.dispatch','payment_release_intent',$4,$5,'{}',repeat('c',64),'pending',clock_timestamp()+interval '1 hour')`,[f.companyA,approval,randomUUID(),intent,f.u1.id]]]);
  await pool.query(`INSERT INTO control_payment_release_outbox(company_id,intent_id,approval_id,provider_reference) VALUES($1,$2::uuid,$3,$2::text)`,[f.companyA,intent,approval]);
  await pool.query(`UPDATE control_payment_release_outbox SET state='attempting',attempt_id=$3,attempted_at=clock_timestamp()
 WHERE company_id=$1 AND intent_id=$2`,[f.companyA,intent,randomUUID()]);
  return intent;
 }
 return{payment,preparation,addAttempt};
}

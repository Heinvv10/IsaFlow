import {beforeAll,afterAll} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
const config=fixtureConfigFromEnv(process.env);
export const pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
let fixture:ForensicFixture;
beforeAll(async()=>{fixture=await provisionForensicFixture(config);});afterAll(()=>pool.end());
export const identities=()=>fixture;
/** Storage-policy fixture only: opaque envelopes never stand in for authenticated service data. */
export async function job(kind='audit_compare',person:'u1'|'u3'='u1'){
 const user=fixture[person],id=randomUUID(),lease=randomUUID();
 await pool.query("INSERT INTO control_audit_job_intents(company_id,id,requester_person_id,kind,idempotency_key,request_hash,protected_request) VALUES($1,$2,$3,$4,$2::uuid::text,$5,'{}')",[user.companyId,id,user.id,kind,'a'.repeat(64)]);
 await pool.query("INSERT INTO control_audit_jobs(company_id,job_id,state,generation,lease_id,lease_expires_at) VALUES($1,$2,'running',1,$3,now()+interval '5 minutes')",[user.companyId,id,lease]);
 return{company:user.companyId,id,lease};
}
export async function snapshot(){
 const row=await job('audit_snapshot');
 await pool.query("INSERT INTO control_audit_snapshots(company_id,id,job_id,requester_person_id,cutoff,canonical_hash,protected_snapshot) VALUES($1,$2,$2,$3,'2026-09-09',$4,'{}')",[row.company,row.id,fixture.u1.id,'b'.repeat(64)]);
 return row;
}
/** Exercise actual PostgreSQL app_user RLS, without pretending to issue a ControlTx/job principal. */
export async function actor<T>(fn:(client:PoolClient)=>Promise<T>,person:'u1'|'u2'|'u3'='u1'){
 const client=await pool.connect(),user=fixture[person];
 try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify({sub:user.id,company_id:user.companyId,role:'authenticated'}),user.companyId]);
  const result=await fn(client);await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

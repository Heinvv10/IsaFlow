import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {withControlRequest} from '@/modules/accounting/services/controls/context';
import type {RequestContext} from '@/lib/als';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {validateFixtureTarget,provisionForensicFixture,type ForensicFixture} from '../forensic-fixture';
const pool=new Pool({connectionString:validateFixtureTarget(fixtureConfigFromEnv(process.env)).connectionString,ssl:false,max:1});
afterAll(()=>pool.end());
it.each(['control_audit_export_results','control_audit_export_files','control_audit_export_chunks'])('persists bounded immutable export material in %s',async table=>{
 expect((await pool.query('SELECT to_regclass($1)::text AS name',[table])).rows[0].name).toBe(table);
 const policy=(await pool.query("SELECT has_table_privilege('app_user',$1,'SELECT') AS read,has_table_privilege('app_user',$1,'INSERT') AS create,has_table_privilege('app_user',$1,'UPDATE') AS update,has_table_privilege('app_user',$1,'DELETE') AS delete",[table])).rows[0];
 expect(policy).toEqual({read:true,create:true,update:false,delete:false});
 expect((await pool.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=to_regclass($1)',[table])).rows[0]).toEqual({relrowsecurity:true,relforcerowsecurity:true});
});

let fixture:ForensicFixture,job:string,lease:string;
beforeAll(async()=>{
 fixture=await provisionForensicFixture(fixtureConfigFromEnv(process.env));job=randomUUID();lease=randomUUID();
 // Opaque envelopes here exercise storage policy only; authenticated material and real job execution have separate tests.
 await pool.query("INSERT INTO control_audit_job_intents(company_id,id,requester_person_id,kind,idempotency_key,request_hash,protected_request) VALUES($1,$2,$3,'audit_export',$5,$4,'{}')",[fixture.companyA,job,fixture.u1.id,'a'.repeat(64),job]);
 await pool.query("INSERT INTO control_audit_jobs(company_id,job_id,state,attempts,generation,lease_id,lease_expires_at) VALUES($1,$2,'running',1,1,$3,clock_timestamp()+interval '60 seconds')",[fixture.companyA,job,lease]);
});
function actor<T>(person:'u1'|'u2'|'u3',fn:(store:RequestContext)=>Promise<T>){
 const user=fixture[person];return withAuditWorkerTransaction(pool,{companyId:user.companyId,personId:user.id,jobId:job},'read committed',Date.now()+10000,undefined,
  store=>withControlRequest(store,{companyId:user.companyId,personId:user.id,authMethod:'cookie'},()=>fn(store)));
}
it('allows only the original current tenant lease to append staged files and chunks',async()=>{
 const insert=(person:'u1'|'u2'|'u3',generation=1,leaseId=lease)=>actor(person,({client})=>client.query("INSERT INTO control_audit_export_files(company_id,job_id,generation,lease_id,file_ordinal,protected_file) VALUES($1,$2,$3,$4,0,'{}')",[fixture.companyA,job,generation,leaseId]));
 await expect(insert('u3')).rejects.toMatchObject({code:'42501'});
 await expect(insert('u2')).rejects.toMatchObject({code:'42501'});
 await expect(insert('u1',2)).rejects.toMatchObject({code:'42501'});
 await expect(insert('u1',1,randomUUID())).rejects.toMatchObject({code:'42501'});
 await insert('u1');
 await actor('u1',({client})=>client.query("INSERT INTO control_audit_export_chunks(company_id,job_id,generation,lease_id,file_ordinal,chunk_ordinal,protected_chunk) VALUES($1,$2,1,$3,0,0,'{}')",[fixture.companyA,job,lease]));
 expect((await actor('u3',({client})=>client.query('SELECT job_id FROM control_audit_export_files WHERE company_id=$1',[fixture.companyA]))).rows).toEqual([]);
 await expect(actor('u1',({client})=>client.query("INSERT INTO control_audit_export_chunks(company_id,job_id,generation,lease_id,file_ordinal,chunk_ordinal,protected_chunk) VALUES($1,$2,1,$3,1,0,'{}')",[fixture.companyA,job,lease]))).rejects.toMatchObject({code:'23503'});
 await expect(actor('u1',({client})=>client.query("INSERT INTO control_audit_export_chunks(company_id,job_id,generation,lease_id,file_ordinal,chunk_ordinal,protected_chunk) VALUES($1,$2,1,$3,0,1,$4::jsonb)",[fixture.companyA,job,lease,JSON.stringify({ciphertext:'x'.repeat(1048576)})]))).rejects.toMatchObject({code:'23514'});
});
it('requires a generation-owned result for success and refuses appending after completion',async()=>{
 const succeed=()=>actor('u1',({client})=>client.query("UPDATE control_audit_jobs SET state='succeeded',result_export_id=job_id,lease_id=NULL,lease_expires_at=NULL,completed_at=clock_timestamp() WHERE company_id=$1 AND job_id=$2",[fixture.companyA,job]));
 await expect(succeed()).rejects.toMatchObject({code:'23503'});
 await actor('u1',({client})=>client.query("INSERT INTO control_audit_export_results(company_id,job_id,generation,lease_id,protected_header) VALUES($1,$2,1,$3,'{}')",[fixture.companyA,job,lease]));
 await succeed();
 await expect(actor('u1',({client})=>client.query("INSERT INTO control_audit_export_chunks(company_id,job_id,generation,lease_id,file_ordinal,chunk_ordinal,protected_chunk) VALUES($1,$2,1,$3,0,2,'{}')",[fixture.companyA,job,lease]))).rejects.toMatchObject({code:'42501'});
 await expect(actor('u1',({client})=>client.query('UPDATE control_audit_jobs SET result_snapshot_id=$2 WHERE company_id=$1 AND job_id=$2',[fixture.companyA,job]))).rejects.toMatchObject({code:'23514'});
});

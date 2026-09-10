import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {actor,job,snapshot,pool,identities} from './auditComparisonStorageFixture';
it('allows only the current owned comparison worker to append output, with immutable tenant reads',async()=>{
 const j=await job();
 const insert=(person:'u1'|'u2'|'u3',lease=j.lease,generation=1)=>actor(c=>c.query("INSERT INTO control_audit_comparison_items(company_id,job_id,generation,lease_id,section,position,protected_item) VALUES($1,$2,$3,$4,'records',0,'{}')",[j.company,j.id,generation,lease]),person);
 for(const person of ['u2','u3'] as const)await expect(insert(person)).rejects.toMatchObject({code:'42501'});
 await expect(insert('u1',randomUUID())).rejects.toMatchObject({code:'42501'});
 await expect(insert('u1',j.lease,2)).rejects.toMatchObject({code:'42501'});
 await pool.query("UPDATE control_audit_jobs SET lease_expires_at=now()-interval '1 second' WHERE company_id=$1 AND job_id=$2",[j.company,j.id]);
 await expect(insert('u1')).rejects.toMatchObject({code:'42501'});
 await pool.query("UPDATE control_audit_jobs SET lease_expires_at=now()+interval '5 minutes' WHERE company_id=$1 AND job_id=$2",[j.company,j.id]);
 await insert('u1');
 expect((await actor(c=>c.query('SELECT job_id FROM control_audit_comparison_items WHERE company_id=$1 AND job_id=$2',[j.company,j.id]),'u3')).rows).toEqual([]);
 for(const command of ['UPDATE control_audit_comparison_items SET position=1','DELETE FROM control_audit_comparison_items'])await expect(actor(c=>c.query(`${command} WHERE company_id=$1 AND job_id=$2`,[j.company,j.id]))).rejects.toMatchObject({code:'42501'});
});
it('binds every source item to its original snapshot builder and supports a later comparison builder',async()=>{
 const s=await snapshot(),j=await job(),other=await job();
 await actor(c=>c.query("INSERT INTO control_audit_comparison_sources(company_id,snapshot_id,build_job_id,build_generation,build_lease_id,protected_header) VALUES($1,$2,$3,1,$4,'{}')",[j.company,s.id,j.id,j.lease]));
 await actor(c=>c.query("INSERT INTO control_audit_comparison_source_items(company_id,snapshot_id,build_job_id,build_generation,build_lease_id,section,position,protected_item) VALUES($1,$2,$3,1,$4,'records',99999,'{}')",[j.company,s.id,j.id,j.lease]));
 await expect(actor(c=>c.query("INSERT INTO control_audit_comparison_source_items(company_id,snapshot_id,build_job_id,build_generation,build_lease_id,section,position,protected_item) VALUES($1,$2,$3,1,$4,'records',0,'{}')",[j.company,s.id,other.id,other.lease]))).rejects.toMatchObject({code:'23503'});
 await expect(actor(c=>c.query("INSERT INTO control_audit_comparison_sources(company_id,snapshot_id,build_job_id,build_generation,build_lease_id,protected_header) VALUES($1,$2,$3,1,$4,'{}')",[identities().companyB,s.id,j.id,j.lease]))).rejects.toMatchObject({code:'42501'});
});
it('cannot claim success without its own generation result and forbids post-publication appends',async()=>{
 const j=await job();
 const publish=()=>actor(c=>c.query("UPDATE control_audit_jobs SET state='succeeded',result_comparison_id=job_id,lease_id=NULL,lease_expires_at=NULL,completed_at=now() WHERE company_id=$1 AND job_id=$2",[j.company,j.id]));
 await expect(publish()).rejects.toMatchObject({code:'23503'});
 await actor(c=>c.query("INSERT INTO control_audit_comparison_results(company_id,job_id,generation,lease_id,protected_header) VALUES($1,$2,1,$3,'{}')",[j.company,j.id,j.lease]));
 await publish();
 await expect(actor(c=>c.query("INSERT INTO control_audit_comparison_items(company_id,job_id,generation,lease_id,section,position,protected_item) VALUES($1,$2,1,$3,'records',0,'{}')",[j.company,j.id,j.lease]))).rejects.toMatchObject({code:'42501'});
});
it('admits disjoint output beyond 100000 and rolls back partial staging on failure',async()=>{
 const j=await job();
 await expect(actor(async c=>{
  await c.query("INSERT INTO control_audit_comparison_items(company_id,job_id,generation,lease_id,section,position,protected_item) VALUES($1,$2,1,$3,'records',199999,'{}')",[j.company,j.id,j.lease]);
  throw new Error('Synthetic staged failure');
 })).rejects.toThrow('Synthetic staged failure');
 expect((await pool.query('SELECT job_id FROM control_audit_comparison_items WHERE company_id=$1 AND job_id=$2',[j.company,j.id])).rows).toEqual([]);
});

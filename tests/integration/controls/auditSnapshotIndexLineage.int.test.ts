import {afterAll,it,expect} from 'vitest';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {validateFixtureTarget} from '../forensic-fixture';
const target=validateFixtureTarget(fixtureConfigFromEnv(process.env));
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:1});
afterAll(()=>pool.end());
it('retains explicit nullable historical builder lineage without inventing old execution evidence',async()=>{
 const columns=(await pool.query("SELECT column_name,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='control_audit_snapshot_indexes' AND column_name IN('build_job_id','build_generation','build_lease_id') ORDER BY column_name")).rows;
 expect(columns).toEqual([{column_name:'build_generation',is_nullable:'YES'},{column_name:'build_job_id',is_nullable:'YES'},{column_name:'build_lease_id',is_nullable:'YES'}]);
});
it.each(['control_audit_snapshot_indexes','control_audit_snapshot_index_items','control_audit_snapshot_index_chunks'])('requires current builder lineage and keeps %s append-only',async table=>{
 const policy=(await pool.query("SELECT with_check FROM pg_policies WHERE schemaname='public' AND tablename=$1 AND policyname='tenant_create'",[table])).rows[0]?.with_check;
 for(const part of ['build_lease_id','build_generation','lease_expires_at','running'])expect(policy).toContain(part);
 expect((await pool.query("SELECT has_table_privilege('app_user',$1,'UPDATE') AS update,has_table_privilege('app_user',$1,'DELETE') AS delete",[table])).rows[0]).toEqual({update:false,delete:false});
});

import {afterAll,expect,it} from 'vitest';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {validateFixtureTarget} from '../forensic-fixture';
const target=validateFixtureTarget(fixtureConfigFromEnv(process.env));
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:1});
afterAll(()=>pool.end());
it('persists immutable owned audit requests separately from mutable worker leases',async()=>{
 for(const table of ['control_audit_job_intents','control_audit_jobs'])expect((await pool.query('SELECT to_regclass($1)::text AS name',[table])).rows[0].name).toBe(table);
 expect((await pool.query("SELECT has_table_privilege('app_user','control_audit_job_intents','UPDATE') AS update,has_table_privilege('app_user','control_audit_job_intents','DELETE') AS delete")).rows[0]).toEqual({update:false,delete:false});
});

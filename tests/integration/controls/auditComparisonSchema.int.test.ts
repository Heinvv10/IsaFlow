import {afterAll,expect,it} from 'vitest';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {validateFixtureTarget} from '../forensic-fixture';
const target=validateFixtureTarget(fixtureConfigFromEnv(process.env));
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:1});
afterAll(()=>pool.end());
it.each(['control_audit_comparison_sources','control_audit_comparison_source_items','control_audit_comparison_results','control_audit_comparison_items'])('retains append-only tenant protected comparison material in %s',async table=>{
 expect((await pool.query('SELECT to_regclass($1)::text AS name',[table])).rows[0].name).toBe(table);
 expect((await pool.query("SELECT has_table_privilege('app_user',$1,'SELECT') AS read,has_table_privilege('app_user',$1,'INSERT') AS create,has_table_privilege('app_user',$1,'UPDATE') AS update,has_table_privilege('app_user',$1,'DELETE') AS delete",[table])).rows[0]).toEqual({read:true,create:true,update:false,delete:false});
 expect((await pool.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=to_regclass($1)',[table])).rows[0]).toEqual({relrowsecurity:true,relforcerowsecurity:true});
});

import {afterAll,expect,it} from 'vitest';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {validateFixtureTarget} from '../forensic-fixture';
const target=validateFixtureTarget(fixtureConfigFromEnv(process.env));
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:1});
afterAll(()=>pool.end());
it('provides tenant-owned exception, occurrence and immutable decision storage',async()=>{
 const tables=['control_exceptions','control_exception_occurrences','control_exception_decisions'];
 const rows=await pool.query('SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=ANY($1)',[tables]);
 expect(rows.rows.map(r=>r.relname).sort()).toEqual([...tables].sort());
 for(const row of rows.rows){expect(row.relrowsecurity).toBe(true);expect(row.relforcerowsecurity).toBe(true);}
});
it('forbids app role mutation of occurrence and decision history',async()=>{
 for(const table of ['control_exception_occurrences','control_exception_decisions']){
  const rows=await pool.query("SELECT has_table_privilege('app_user',$1,'UPDATE') AS update,has_table_privilege('app_user',$1,'DELETE') AS delete",[table]);
  expect(rows.rows[0]).toEqual({update:false,delete:false});
 }
});

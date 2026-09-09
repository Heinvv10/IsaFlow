import {afterAll,beforeAll,expect,it} from 'vitest';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:1});
let fixture:ForensicFixture;
beforeAll(async()=>{fixture=await provisionForensicFixture(config);});
afterAll(async()=>{await pool.end();});
it.each(['control_historical_import_sources','control_historical_imports'])(
 'gives app_user immutable tenant storage for %s',async table=>{
  const result=await pool.query(`SELECT relrowsecurity,relforcerowsecurity,has_table_privilege('app_user',oid,'UPDATE,DELETE,TRUNCATE') AS mutable
   FROM pg_class WHERE oid=to_regclass($1)`,[table]);
  expect(result.rows).toEqual([{relrowsecurity:true,relforcerowsecurity:true,mutable:false}]);
 });
it('seeds distinct immutable mandatory independent policies for newly created companies',async()=>{
 const result=await pool.query('SELECT company_id,id,version::int,approver_role FROM control_mandatory_import_policies WHERE company_id=ANY($1)',[[fixture.companyA,fixture.companyB]]);
 expect(result.rows).toHaveLength(2);expect(new Set(result.rows.map(row=>row.id)).size).toBe(2);
 for(const row of result.rows)expect(row).toMatchObject({version:1,approver_role:'admin'});
 const client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",
   [JSON.stringify({sub:fixture.u1.id,company_id:fixture.companyA,role:'authenticated'}),fixture.companyA]);
  expect((await client.query('SELECT company_id FROM control_mandatory_import_policies')).rows).toEqual([{company_id:fixture.companyA}]);
  await expect(client.query('DELETE FROM control_mandatory_import_policies WHERE company_id=$1',[fixture.companyA])).rejects.toMatchObject({code:'42501'});
 }finally{await client.query('ROLLBACK');client.release();}
});

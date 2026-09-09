import {afterAll,beforeAll,expect,it} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:1});
let fixture:ForensicFixture;
beforeAll(async()=>{fixture=await provisionForensicFixture(config);});
afterAll(()=>pool.end());
it('requires actual nonempty resolution evidence even when nullable SQL fields are supplied',async()=>{
 for(const reason of [null,'','   ']){
  const client=await pool.connect();
  try{
   await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
   await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",
    [JSON.stringify({sub:fixture.u1.id,role:'authenticated',company_id:fixture.companyA}),fixture.companyA]);
   await expect(client.query(`INSERT INTO control_exceptions(company_id,id,check_id,finding_key,check_version,finding,severity,
    status,reporter_person_id,reviewer_person_id,resolution_reason)
    VALUES($1,$2::uuid,'three_way_match_exceptions',$2::text,1,'{}','high','fixed',$3,$4,$5)`,
   [fixture.companyA,randomUUID(),fixture.u1.id,fixture.u2.id,reason])).rejects.toMatchObject({code:'23514'});
  }finally{await client.query('ROLLBACK');client.release();}
 }
});

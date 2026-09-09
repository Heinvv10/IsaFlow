import {afterAll,expect,it} from 'vitest';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {validateFixtureTarget} from '../forensic-fixture';
const pool=new Pool({connectionString:validateFixtureTarget(fixtureConfigFromEnv(process.env)).connectionString,ssl:false,max:1});
afterAll(()=>pool.end());
it('has immutable compensation intent storage with exact owned source binding',async()=>{
 const rows=await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='control_payroll_compensation_intents'");
 expect(rows.rows.map(row=>row.column_name)).toEqual(expect.arrayContaining(['company_id','id','requester_person_id','effective_date','amount','currency','payload','source_fingerprint','created_at']));
});
it('has mandatory independent compensation policy storage',async()=>{
 expect((await pool.query("SELECT to_regclass('public.control_mandatory_compensation_policies')::text AS name")).rows[0].name).toBe('control_mandatory_compensation_policies');
});

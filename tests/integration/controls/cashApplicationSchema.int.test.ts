import {afterAll,expect,it} from 'vitest';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {validateFixtureTarget} from '../forensic-fixture';
const target=validateFixtureTarget(fixtureConfigFromEnv(process.env));
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:1});
afterAll(()=>pool.end());
it('provides immutable owned cash application and inverse intents',async()=>{
 for(const table of ['control_cash_application_intents','control_cash_application_reversal_intents']){
  expect((await pool.query('SELECT to_regclass($1)::text AS name',[table])).rows[0].name).toBe(table);
  const row=(await pool.query("SELECT has_table_privilege('app_user',$1,'SELECT') AS read,has_table_privilege('app_user',$1,'INSERT') AS create,has_table_privilege('app_user',$1,'UPDATE') AS update,has_table_privilege('app_user',$1,'DELETE') AS delete",[table])).rows[0];
  expect(row).toEqual({read:true,create:true,update:false,delete:false});
 }
});
it('retains original positive allocation rows with explicit application and reversal lineage',async()=>{
 for(const table of ['customer_payment_allocations','payment_allocations']){
  const result=await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name IN ('application_intent_id','reversed_at','reversal_intent_id') ORDER BY column_name",[table]);
  expect(result.rows.map(r=>r.column_name)).toEqual(['application_intent_id','reversal_intent_id','reversed_at']);
 }
});

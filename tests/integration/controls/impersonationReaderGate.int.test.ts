import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {validateFixtureTarget} from '../forensic-fixture';
import {assertImpersonationReaderDeployed,IMPERSONATION_READER_GATE_SQL} from '@/lib/auth/sessionImpersonation';

/** The deploy gate's SQL, against a real Postgres, in transactions that are always rolled back. */
describe('impersonation reader deploy gate: actual PostgreSQL',()=>{
 let pool:Pool;
 beforeAll(()=>{pool=new Pool({connectionString:validateFixtureTarget(fixtureConfigFromEnv(process.env)).connectionString,max:2});});
 afterAll(async()=>{await pool?.end();});
 async function gate(prepare:(client:PoolClient)=>Promise<void>){
  const client=await pool.connect();
  try{
   await client.query('BEGIN');await prepare(client);
   return await assertImpersonationReaderDeployed(async text=>(await client.query(text)).rows)
    .then(()=>'passed',error=>String(error instanceof Error?error.message:error));
  }finally{await client.query('ROLLBACK');client.release();}
 }
 it('passes when both functions exist and both roles may execute them',async()=>{
  expect(await gate(async()=>{})).toBe('passed');
 });
 it('fails when the reader function is missing',async()=>{
  expect(await gate(async c=>{await c.query('DROP FUNCTION public.control_session_impersonator()');}))
   .toMatch(/control_session_impersonator\(\) is not deployed/);
 });
 it('fails when the liveness function is missing',async()=>{
  expect(await gate(async c=>{await c.query('DROP FUNCTION public.impersonation_delegation_live(uuid,text,text,text)');}))
   .toMatch(/impersonation_delegation_live\(.*\) is not deployed/);
 });
 it('fails when app_user cannot execute the reader',async()=>{
  expect(await gate(async c=>{await c.query('REVOKE EXECUTE ON FUNCTION public.control_session_impersonator() FROM app_user');}))
   .toMatch(/app_user cannot EXECUTE .*control_session_impersonator/);
 });
 it('fails when the role that runs the liveness query cannot execute it',async()=>{
  // impersonationDelegationLive runs from verifyToken on the DATABASE_URL login role, before
  // any app_user transaction exists - so that role, not app_user, is the one that matters.
  const role=`gate_login_${randomUUID().replaceAll('-','')}`;
  expect(await gate(async c=>{await c.query(`CREATE ROLE ${role} NOLOGIN`);await c.query(`SET LOCAL ROLE ${role}`);}))
   .toMatch(new RegExp(`${role} cannot EXECUTE .*impersonation_delegation_live`));
 });
});

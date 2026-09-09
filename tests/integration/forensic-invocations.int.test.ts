import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {Pool,type PoolClient} from 'pg';
import {PAT_SCOPES} from '../../src/lib/auth/patScopes';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from './forensic-fixture';
import {withControlRequest,requireControlTx} from '../../src/modules/accounting/services/controls/context';
import {settleControlTransaction} from '../../src/modules/accounting/services/controls/transactionObservers';
import {beginMcpInvocation,completeMcpInvocation,closeInvocationPool,getMcpInvocationStatus,listMcpInvocations,reconcileMcpInvocation,type InvocationHandle} from '../../src/lib/mcp/invocationStore';
const enabled=process.env.ISAFLOW_FORENSIC_FIXTURE_OPT_IN==='1';
describe.skipIf(!enabled)('durable invocation evidence on owned PostgreSQL',()=>{
 let pool:Pool,fixture:ForensicFixture;
 const oldUrl=process.env.DATABASE_URL,oldSsl=process.env.DATABASE_SSL;
 const input={tool:'synthetic_tool',argsHash:'a'.repeat(64),idempotencyKeyHash:null};
 const completion={status:'ok' as const,reportedWrite:true,durationMs:3,reasonCode:'SUCCESS' as const};
 beforeAll(async()=>{
  const config={optIn:process.env.ISAFLOW_FORENSIC_FIXTURE_OPT_IN,databaseUrl:process.env.ISAFLOW_FORENSIC_FIXTURE_URL};
  const target=validateFixtureTarget(config);process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
  fixture=await provisionForensicFixture(config);pool=new Pool({connectionString:target.connectionString,ssl:false,max:4});
 });
 afterAll(async()=>{await closeInvocationPool();if(pool)await pool.end();if(oldUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldUrl;if(oldSsl===undefined)delete process.env.DATABASE_SSL;else process.env.DATABASE_SSL=oldSsl;});
 async function request<T>(handler:(client:PoolClient)=>Promise<T>,opts:{rollback?:boolean;settle?:boolean;foreign?:boolean;tokenIndex?:number}={}):Promise<T>{
  const client=await pool.connect(),user=opts.foreign?fixture.u3:fixture.u1;
  try{
   await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
   const claims={sub:user.id,role:'authenticated',company_id:user.companyId};
   await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
   const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},
    opts.tokenIndex===undefined?{personId:user.id,companyId:user.companyId,authMethod:'cookie'}:
     {personId:user.id,companyId:user.companyId,authMethod:'pat',grantId:user.tokens[opts.tokenIndex]!.id,connectionId:user.tokens[opts.tokenIndex]!.id,grantedScopes:[...PAT_SCOPES]},()=>handler(client));
   const command=await client.query(opts.rollback?'ROLLBACK':'COMMIT');
   if(opts.settle!==false)await settleControlTransaction(client,command.command==='COMMIT'?'committed':'rolled_back');
   return result;
  }catch(error){await client.query('ROLLBACK');if(opts.settle!==false)await settleControlTransaction(client,'rolled_back');throw error;}
  finally{client.release();}
 }
 async function counts(id:string){return(await pool.query('SELECT (SELECT count(*) FROM mcp_invocation_attempts WHERE company_id=$1 AND id=$2)::int AS attempts,(SELECT count(*) FROM mcp_invocation_receipts WHERE company_id=$1 AND attempt_id=$2)::int AS receipts,(SELECT count(*) FROM mcp_invocation_outcomes WHERE company_id=$1 AND attempt_id=$2)::int AS outcomes',[fixture.companyA,id])).rows[0];}
 it('admits before effect and settles only after actual commit',async()=>{
  let handle!:InvocationHandle;
  await request(async()=>{handle=await beginMcpInvocation(input);expect(await counts(handle.attemptId)).toEqual({attempts:1,receipts:0,outcomes:0});await completeMcpInvocation(handle,completion);expect(await counts(handle.attemptId)).toEqual({attempts:1,receipts:0,outcomes:0});});
  expect(await counts(handle.attemptId)).toEqual({attempts:1,receipts:1,outcomes:1});
  const status=await request(()=>getMcpInvocationStatus(requireControlTx(),handle.attemptId));expect(status).toMatchObject({transactionOutcome:'committed',status:'ok',reportedWrite:true,personId:fixture.u1.id});
 });
 it('retains admission and rollback evidence when the effect transaction aborts',async()=>{
  let handle!:InvocationHandle;await request(async()=>{handle=await beginMcpInvocation(input);await completeMcpInvocation(handle,completion);},{rollback:true});
  expect(await counts(handle.attemptId)).toEqual({attempts:1,receipts:0,outcomes:1});
  expect(await request(()=>getMcpInvocationStatus(requireControlTx(),handle.attemptId))).toMatchObject({transactionOutcome:'rolled_back'});
 });
 it('reconciles a committed receipt after simulated process loss before observer settlement',async()=>{
  const handle=await request(async()=>{const h=await beginMcpInvocation(input);await completeMcpInvocation(h,completion);return h;},{settle:false});
  expect(await request(()=>getMcpInvocationStatus(requireControlTx(),handle.attemptId))).toMatchObject({transactionOutcome:'unknown'});
  expect(await request(()=>reconcileMcpInvocation(requireControlTx(),handle.attemptId))).toMatchObject({transactionOutcome:'committed',status:'ok'});
 });
 it('proves an abandoned transaction aborted instead of guessing from absent receipt',async()=>{
  const handle=await request(()=>beginMcpInvocation(input),{rollback:true,settle:false});
  expect(await request(()=>reconcileMcpInvocation(requireControlTx(),handle.attemptId))).toMatchObject({transactionOutcome:'rolled_back',status:null});
 });
 it('keeps committed transactions with missing or savepoint-discarded completion unknown',async()=>{
  const missing=await request(()=>beginMcpInvocation(input));
  const discarded=await request(async client=>{const h=await beginMcpInvocation(input);await client.query('SAVEPOINT discard_receipt');await completeMcpInvocation(h,completion);await client.query('ROLLBACK TO SAVEPOINT discard_receipt');return h;});
  for(const h of [missing,discarded])expect(await request(()=>reconcileMcpInvocation(requireControlTx(),h.attemptId))).toMatchObject({transactionOutcome:'unknown',status:null,reportedWrite:null});
 });
 it('keeps an in-progress invocation unknown and later completes it',async()=>{
  await request(async()=>{const h=await beginMcpInvocation(input);expect(await request(()=>reconcileMcpInvocation(requireControlTx(),h.attemptId))).toMatchObject({transactionOutcome:'unknown'});await completeMcpInvocation(h,completion);});
 });
 it('gives each retry its own admission and isolates tenant reads and reconciliation',async()=>{
  const ids:string[]=[];for(let i=0;i<2;i++)ids.push((await request(async()=>{const h=await beginMcpInvocation({...input,idempotencyKeyHash:'b'.repeat(64)});await completeMcpInvocation(h,{...completion,status:i?'replay':'ok',reportedWrite:!i});return h;})).attemptId);
  expect(ids[0]).not.toBe(ids[1]);for(const id of ids){expect(await request(()=>getMcpInvocationStatus(requireControlTx(),id),{foreign:true})).toBeNull();expect(await request(()=>reconcileMcpInvocation(requireControlTx(),id),{foreign:true})).toBeNull();}
  expect((await request(()=>listMcpInvocations(requireControlTx(),{limit:1}))).items).toHaveLength(1);
 });
 it('records two runtime synthetic grants as the same person without token plaintext',async()=>{
  const ids:string[]=[];for(const tokenIndex of [0,1])ids.push((await request(async()=>{const h=await beginMcpInvocation(input);await completeMcpInvocation(h,completion);return h;},{tokenIndex})).attemptId);
  const rows=(await pool.query('SELECT person_id,grant_id,auth_method,args_hash,key_hash FROM mcp_invocation_attempts WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY grant_id',[fixture.companyA,ids])).rows;
  expect(rows).toHaveLength(2);expect(new Set(rows.map(r=>r.person_id))).toEqual(new Set([fixture.u1.id]));expect(new Set(rows.map(r=>r.grant_id))).toEqual(new Set(fixture.u1.tokens.map(t=>t.id)));
  expect(JSON.stringify(rows)).not.toContain(fixture.u1.tokens[0]!.raw);
 });
 it('rejects escaped handles and cannot alter append-only evidence',async()=>{
  const h=await request(()=>beginMcpInvocation(input));await expect(request(()=>completeMcpInvocation(h,completion))).rejects.toThrow();
  for(const table of ['mcp_invocation_attempts','mcp_invocation_receipts','mcp_invocation_outcomes']){
   await expect(request(client=>client.query(`DELETE FROM ${table} WHERE company_id=$1`,[fixture.companyA]))).rejects.toMatchObject({code:'42501'});
  }
 });
 it('fails closed within the configured timeout before effect when admission cannot persist',async()=>{
  const locker=await pool.connect();let effect=false;const started=Date.now();
  try{await locker.query('BEGIN');await locker.query('LOCK TABLE mcp_invocation_attempts IN ACCESS EXCLUSIVE MODE');
   await expect(request(async()=>{await beginMcpInvocation(input);effect=true;})).rejects.toMatchObject({code:'INVOCATION_UNAVAILABLE'});
   expect(effect).toBe(false);expect(Date.now()-started).toBeLessThan(5500);
  }finally{await locker.query('ROLLBACK');locker.release();}
 },10000);
 it('persists completion using original identity after membership removal',async()=>{
  const client=await pool.connect();let h!:InvocationHandle;
  try{
   await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');const claims={sub:fixture.u2.id,role:'authenticated',company_id:fixture.companyA};
   await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),fixture.companyA]);
   await withControlRequest({client,userId:fixture.u2.id,companyId:fixture.companyA,claims},{personId:fixture.u2.id,companyId:fixture.companyA,authMethod:'cookie'},async()=>{h=await beginMcpInvocation(input);await completeMcpInvocation(h,completion);});
   await client.query('COMMIT');await pool.query('DELETE FROM company_users WHERE company_id=$1 AND user_id=$2',[fixture.companyA,fixture.u2.id]);await settleControlTransaction(client,'committed');
   expect(await counts(h.attemptId)).toEqual({attempts:1,receipts:1,outcomes:1});
  }finally{client.release();await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT DO NOTHING",[fixture.companyA,fixture.u2.id]);}
 });
});

import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from './forensic-fixture';
import {withControlRequest,requireControlTx} from '../../src/modules/accounting/services/controls/context';
import type {ControlTx} from '../../src/modules/accounting/services/controls/contracts';
import {finalizeRequestTransaction} from '../../src/lib/auth/transactionFinalization';
import {acquireIdempotencyLock,findIdempotentReplay,recordToolCall} from '../../src/lib/mcp/audit';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:3});
let fixture:ForensicFixture;
beforeAll(async()=>{fixture=await provisionForensicFixture(config);});
afterAll(async()=>{await pool.end();const{getPoolForTests}=await import('../../src/lib/neon');await getPoolForTests().end();});
async function transact<T>(company: string, user: string, fn: (ctx: ControlTx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('SET LOCAL ROLE app_user');
    const claims = { sub: user, company_id: company, role: 'authenticated' };
    await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)", [JSON.stringify(claims), company]);
    const result = await withControlRequest({ client, userId: user, companyId: company, claims },
      { personId: user, companyId: company, authMethod: 'cookie' }, () => fn(requireControlTx()));
    await finalizeRequestTransaction(client, false); return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function invoke(key:string,fail=false){
  return transact(fixture.companyA,fixture.u1.id,async ctx=>{
    await acquireIdempotencyLock(fixture.companyA,'synthetic_create',key);
    const replay=await findIdempotentReplay(fixture.companyA,'synthetic_create',key,'args');
    if(replay.status==='match')return replay.result;
    const id=randomUUID(),result={content:[{type:'text' as const,text:id}]};
    await ctx.sql`INSERT INTO suppliers(id,company_id,name) VALUES(${id}::uuid,${fixture.companyA}::uuid,'Dedup synthetic')`;
    await recordToolCall({ctx:{companyId:fixture.companyA,userId:fixture.u1.id,tokenJti:null,oauthAppId:null,scopes:[]},
      tool:'synthetic_create',argsHash:'args',idempotencyKey:key,status:'ok',result,durationMs:1});
    if(fail)throw new Error('synthetic rollback');
    return result;
  });
}
it('history pruning cannot allow a committed intent to execute again',async()=>{
  const key=randomUUID(),first=await invoke(key);
  await pool.query('DELETE FROM mcp_tool_calls WHERE company_id=$1',[fixture.companyA]);
  expect(await invoke(key)).toEqual(first);
  const id=first.content[0]!.text;
  expect((await pool.query('SELECT id FROM suppliers WHERE company_id=$1 AND id=$2',[fixture.companyA,id])).rows).toHaveLength(1);
});
it('same-key concurrent requests create one effect and one durable receipt',async()=>{
  const key=randomUUID(),results=await Promise.all([invoke(key),invoke(key)]);
  expect(results[0]).toEqual(results[1]);
  expect((await pool.query('SELECT idempotency_key FROM mcp_idempotency_results WHERE company_id=$1 AND idempotency_key=$2',[fixture.companyA,key])).rows).toHaveLength(1);
});
it('rollback removes receipt and effect so a clean retry can execute',async()=>{
  const key=randomUUID();await expect(invoke(key,true)).rejects.toThrow('synthetic rollback');
  expect((await pool.query('SELECT idempotency_key FROM mcp_idempotency_results WHERE company_id=$1 AND idempotency_key=$2',[fixture.companyA,key])).rows).toHaveLength(0);
  expect((await invoke(key)).content).toHaveLength(1);
});
it('foreign tenant cannot read receipts and app role cannot prune them',async()=>{
  const key=randomUUID();await invoke(key);
  await transact(fixture.companyB,fixture.u3.id,async()=>{
    expect(await findIdempotentReplay(fixture.companyA,'synthetic_create',key,'args')).toEqual({status:'none'});
  });
  await expect(transact(fixture.companyA,fixture.u1.id,async ctx=>{
    await ctx.sql`DELETE FROM mcp_idempotency_results WHERE company_id=${fixture.companyA}::uuid AND idempotency_key=${key}`;
  })).rejects.toThrow('permission denied');
});

it('reapplying migration preserves legacy successful keys before audit pruning',async()=>{
  const key=randomUUID(),result={content:[{type:'text',text:'legacy-created'}]};
  await pool.query("INSERT INTO mcp_tool_calls(company_id,user_id,tool,args_hash,idempotency_key,status,result) VALUES($1,$2,'legacy','args',$3,'ok',$4::jsonb)",
    [fixture.companyA,fixture.u1.id,key,JSON.stringify(result)]);
  const migration=await readFile(new URL('../../scripts/migrations/sql/629_forensic_invocations_idempotency.sql',import.meta.url),'utf8');
  await pool.query(migration);await pool.query(migration);
  await pool.query('DELETE FROM mcp_tool_calls WHERE company_id=$1',[fixture.companyA]);
  await transact(fixture.companyA,fixture.u1.id,async()=>{
    expect(await findIdempotentReplay(fixture.companyA,'legacy',key,'args')).toEqual({status:'match',result});
    expect(await findIdempotentReplay(fixture.companyA,'legacy',key,'changed')).toEqual({status:'conflict'});
  });
});

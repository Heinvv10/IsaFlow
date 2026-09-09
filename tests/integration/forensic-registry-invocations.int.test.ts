import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from './forensic-fixture';
import {seedApAccounts} from './controls/apSyntheticAccounts';
import {withControlRequest} from '@/modules/accounting/services/controls/context';
import {finalizeRequestTransaction} from '@/lib/auth/transactionFinalization';
import {closeInvocationPool} from '@/lib/mcp/invocationStore';
import {PAT_SCOPES} from '@/lib/auth/patScopes';
import {McpRegistry} from '@/lib/mcp/registry';
import {postJournalTool} from '@/lib/mcp/tools/writeJournals';
import {createJournalEntry} from '@/modules/accounting/services/gl/journalEntryService';
import type {McpTool,McpToolContext} from '@/lib/mcp/types';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:3});
let fixture:ForensicFixture,accounts:Awaited<ReturnType<typeof seedApAccounts>>;
const oldUrl=process.env.DATABASE_URL;
beforeAll(async()=>{
 process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
 process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
 fixture=await provisionForensicFixture(config);accounts=await seedApAccounts(pool,fixture.companyA);
 await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
 VALUES($1,$2,'Synthetic registry',1,2081,'2081-01-01','2081-01-31','open')`,[randomUUID(),fixture.companyA]);
});
afterAll(async()=>{await closeInvocationPool();await pool.end();if(oldUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldUrl;});
async function request<T>(run:(ctx:McpToolContext)=>Promise<T>,options:{rollback?:boolean;secondToken?:boolean;foreign?:boolean}={}){
 const user=options.foreign?fixture.u3:fixture.u1,token=user.tokens[options.secondToken?1:0]!,client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  const claims={sub:user.id,role:'authenticated',company_id:user.companyId};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
  const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},
   {personId:user.id,companyId:user.companyId,authMethod:'pat',grantId:token.id,connectionId:token.id,grantedScopes:[...PAT_SCOPES]},
   ()=>run({companyId:user.companyId,userId:user.id,tokenJti:token.id,oauthAppId:null,scopes:[...PAT_SCOPES]}));
  await finalizeRequestTransaction(client,options.rollback===true);return result;
 }catch(error){await finalizeRequestTransaction(client,true);throw error;}finally{client.release();}
}
async function draft(){
 return request(ctx=>createJournalEntry(ctx.companyId,{entryDate:'2081-01-15',description:'Synthetic registry journal',source:'manual',
  lines:[{glAccountId:accounts.bank,debit:115.1,credit:0},{glAccountId:accounts.payable,debit:0,credit:115.1}]},ctx.userId));
}
function registry(handler:McpTool['handler']=postJournalTool.handler){const r=new McpRegistry();r.register({...postJournalTool,handler});return r;}
async function state(id:string){return(await pool.query('SELECT status FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[fixture.companyA,id])).rows[0].status;}
async function attempts(key:string){
 const {createHash}=await import('node:crypto');
 return(await pool.query(`SELECT a.id,a.person_id,a.grant_id,o.status,o.transaction_outcome,o.reported_write
 FROM mcp_invocation_attempts a JOIN mcp_invocation_outcomes o ON o.company_id=a.company_id AND o.attempt_id=a.id
 WHERE a.company_id=$1 AND a.key_hash=$2 ORDER BY a.admitted_at`,[fixture.companyA,createHash('sha256').update(key).digest('hex')])).rows;
}
it('posts a real journal once and records a second-token replay as a separate committed attempt',async()=>{
 const entry=await draft(),key=randomUUID(),r=registry(),args={journal_id:entry.id,idempotency_key:key};
 const first=await request(ctx=>r.call('post_journal',args,ctx));expect(first.isError).not.toBe(true);
 const second=await request(ctx=>r.call('post_journal',args,ctx),{secondToken:true});expect(second).toEqual(first);
 expect(await state(entry.id)).toBe('posted');
 const history=await attempts(key);expect(history.map(row=>row.status)).toEqual(['ok','replay']);
 expect(history.map(row=>row.transaction_outcome)).toEqual(['committed','committed']);
 expect(history.map(row=>row.reported_write)).toEqual([true,false]);
 expect(new Set(history.map(row=>row.grant_id)).size).toBe(2);expect(new Set(history.map(row=>row.person_id)).size).toBe(1);
 const effects=await pool.query("SELECT count(*)::int AS n FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2 AND operation='journal.post'",[fixture.companyA,entry.id]);
 expect(effects.rows[0].n).toBe(1);
});
it.each(['throw','refuse'])('rolls back a real posted journal when its handler subsequently %s',async mode=>{
 const entry=await draft(),key=randomUUID(),r=registry(async(args,ctx)=>{
  await postJournalTool.handler(args,ctx);
  if(mode==='throw')throw new Error('Synthetic failure after posting');
  return {content:[{type:'text',text:'Synthetic refusal'}],isError:true};
 });
 const result=await request(ctx=>r.call('post_journal',{journal_id:entry.id,idempotency_key:key},ctx));
 expect(result.isError).toBe(true);expect(await state(entry.id)).toBe('draft');
 const history=await attempts(key);expect(history).toHaveLength(1);
 expect(history[0]).toMatchObject({transaction_outcome:'committed',status:mode==='throw'?'error':'rejected',reported_write:false});
 const counts=await pool.query(`SELECT (SELECT count(*) FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2)::int AS effects,
 (SELECT count(*) FROM mcp_idempotency_results WHERE company_id=$1 AND idempotency_key=$3)::int AS receipts`,[fixture.companyA,entry.id,key]);
 expect(counts.rows[0]).toEqual({effects:0,receipts:0});
});
it('does not describe an outer rollback as a committed financial effect',async()=>{
 const entry=await draft(),key=randomUUID();
 await request(ctx=>registry().call('post_journal',{journal_id:entry.id,idempotency_key:key},ctx),{rollback:true});
 expect(await state(entry.id)).toBe('draft');expect((await attempts(key))[0]).toMatchObject({transaction_outcome:'rolled_back',status:'ok',reported_write:true});
});
it('checks current permission before replay and retains its refusal attempt',async()=>{
 const entry=await draft(),key=randomUUID(),r=registry(),args={journal_id:entry.id,idempotency_key:key};
 await request(ctx=>r.call('post_journal',args,ctx));
 await pool.query('UPDATE company_users SET role=$1 WHERE company_id=$2 AND user_id=$3',['viewer',fixture.companyA,fixture.u1.id]);
 try{expect((await request(ctx=>r.call('post_journal',args,ctx))).isError).toBe(true);}
 finally{await pool.query('UPDATE company_users SET role=$1 WHERE company_id=$2 AND user_id=$3',['admin',fixture.companyA,fixture.u1.id]);}
 expect((await attempts(key)).map(row=>row.status)).toEqual(['ok','rejected']);
});

import { readFileSync } from 'node:fs';
import { afterAll,beforeAll,expect,it,vi } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import twilio from 'twilio';
import inboxRoute from '../../pages/api/accounting/capture/whatsapp-inbox';
import webhook from '../../pages/api/accounting/capture/inbound/whatsapp';
import { assertDisposable,request,response } from './mfa-impersonation-postgres.helpers';

vi.mock('@/modules/accounting/services/capture/whatsAppReplyService',()=>({sendWhatsAppMessage:vi.fn(async()=>({sent:true}))}));
vi.mock('@/modules/accounting/services/capture/captureRouterService',()=>({routeEvent:vi.fn(async()=>undefined)}));
assertDisposable();
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const first=crypto.randomUUID(),second=crypto.randomUUID();
const userA=crypto.randomUUID(),userB=crypto.randomUUID();
const shared='+27820001001',old='+27820001002';
const companies=[first,second];
const tokens=new Map<string,string>();
const authToken='disposable-whatsapp-signature-fixture';
const origin='http://localhost:3200';
const url='/api/accounting/capture/inbound/whatsapp';
const migration=readFileSync('scripts/migrations/sql/617_capture_whatsapp_destination_identity.sql','utf8');
beforeAll(async()=>{
  // Run alone on the explicit disposable fixture; restore the index after cleanup.
  await pool.query('DROP INDEX IF EXISTS ux_capture_inboxes_whatsapp_address');
  vi.stubEnv('TWILIO_AUTH_TOKEN',authToken);
  vi.stubEnv('APP_URL',origin);
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',[first,'WA first fixture',second,'WA second fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'viewer',true),($3,$4,'viewer',true)",[userA,`${userA}@test.local`,userB,`${userB}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin'),($3,$4,'admin')",[first,userA,second,userB]);
  const secret=process.env.JWT_SECRET;
  if(!secret)throw new Error('Disposable JWT_SECRET required');
  for(const [company,user] of [[first,userA],[second,userB]] as const){
    tokens.set(company,await new SignJWT({sub:user,aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(secret)));
  }
});
afterAll(async()=>{
  vi.unstubAllEnvs();
  try{
    await pool.query('DELETE FROM capture_events WHERE company_id=ANY($1::uuid[])',[companies]);
    await pool.query('DELETE FROM capture_inboxes WHERE company_id=ANY($1::uuid[])',[companies]);
    await pool.query('DELETE FROM company_users WHERE company_id=ANY($1::uuid[]) AND user_id=ANY($2::text[])',[companies,[userA,userB]]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[companies]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::text[])',[[userA,userB]]);
  }finally{try{await pool.query(migration);}finally{await pool.end();}}
});
async function configure(company:string,address:string){
  const req=request({'sb-access-token':tokens.get(company)!,active_company_id:company},'POST');
  req.url='/api/accounting/capture/whatsapp-inbox';req.body={address};
  const result=response();await inboxRoute(req,result.res);return result;
}
async function deliver(signature?:string,toNumber=shared){
  const body={From:'whatsapp:+27821111111',To:`whatsapp:${toNumber}`,Body:'Paid R100 at Fixture',NumMedia:'0',MessageSid:'SM-disposable-routing'};
  const req=request({},'POST');req.url=url;req.body=body;
  req.headers['x-twilio-signature']=signature??twilio.getExpectedTwilioSignature(authToken,origin+url,body);
  const result=response();await webhook(req,result.res);return result;
}
it('signed inbound message to an ambiguous number is rejected before tenant event creation',async()=>{
  await pool.query("INSERT INTO capture_inboxes(company_id,channel,address) VALUES($1,'whatsapp',$3),($2,'whatsapp',$3)",[first,second,shared]);
  const result=await deliver();
  expect(result.state.statusCode).toBe(200);
  expect((result.state.body as {data:unknown}).data).toEqual({rejected:'ambiguous inbox'});
  expect((await pool.query('SELECT company_id FROM capture_events WHERE company_id=ANY($1::uuid[])',[companies])).rows).toEqual([]);
});
it('missing credentials and invalid provider signature remain fail-closed',async()=>{
  expect((await deliver('invalid')).state.statusCode).toBe(403);
  vi.stubEnv('TWILIO_AUTH_TOKEN','');
  try{expect((await deliver()).state.statusCode).toBe(503);}finally{vi.stubEnv('TWILIO_AUTH_TOKEN',authToken);}
});

it('migration refuses legacy collisions unchanged, then upgrades cleanly and repeatedly',async()=>{
  await expect(pool.query(migration)).rejects.toThrow('collisions require reviewed remediation');
  expect((await pool.query('SELECT id FROM capture_inboxes WHERE company_id=ANY($1::uuid[])',[companies])).rows).toHaveLength(2);
  await pool.query('DELETE FROM capture_inboxes WHERE company_id=ANY($1::uuid[])',[companies]);
  await pool.query(migration);await pool.query(migration);
});
it('duplicate number claim is refused without disabling the second tenant current number',async()=>{
  expect((await configure(first,shared)).state.statusCode).toBe(200);
  expect((await configure(second,old)).state.statusCode).toBe(200);
  const duplicate=await configure(second,shared);
  expect(duplicate.state.statusCode).toBe(409);
  expect((await pool.query('SELECT address FROM capture_inboxes WHERE company_id=$1 AND is_active',[second])).rows).toEqual([{address:old}]);
});

it('same-company repeat and rotation preserve reserved numbers and signed routing',async()=>{
  expect((await configure(first,shared)).state.statusCode).toBe(200);
  expect((await pool.query('SELECT id FROM capture_inboxes WHERE company_id=$1 AND address=$2',[first,shared])).rows).toHaveLength(1);
  const next='+27820001003';
  expect((await configure(first,next)).state.statusCode).toBe(200);
  expect((await configure(second,shared)).state.statusCode).toBe(409);
  expect((await deliver()).state.body).toMatchObject({data:{rejected:'no matching inbox'}});
  expect((await deliver(undefined,next)).state.body).toMatchObject({data:{companyId:first}});
  expect((await deliver(undefined,old)).state.body).toMatchObject({data:{companyId:second}});
  const rows=(await pool.query('SELECT company_id FROM capture_events WHERE company_id=ANY($1::uuid[])',[companies])).rows;
  expect(rows.map(r=>r.company_id).sort()).toEqual([...companies].sort());
});
it('existing manager write-access can configure the company number',async()=>{
  await pool.query("UPDATE company_users SET role='manager' WHERE company_id=$1 AND user_id=$2",[first,userA]);
  try{expect((await configure(first,'+27820001004')).state.statusCode).toBe(200);}
  finally{await pool.query("UPDATE company_users SET role='admin' WHERE company_id=$1 AND user_id=$2",[first,userA]);}
});
it('concurrent different-number updates leave exactly one active company inbox',async()=>{
  const results=await Promise.all([configure(first,'+27820001005'),configure(first,'+27820001006')]);
  expect(results.map(r=>r.state.statusCode)).toEqual([200,200]);
  expect((await pool.query("SELECT id FROM capture_inboxes WHERE company_id=$1 AND channel='whatsapp' AND is_active",[first])).rows).toHaveLength(1);
});
it('company lock blocks its configuration while another company can finish',async()=>{
  const blocker=await pool.connect();
  let pending:ReturnType<typeof configure>|undefined;
  try{
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,617))',[first]);
    const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    pending=configure(first,'+27820001007');
    let waiting=false;
    for(let attempt=0;attempt<100;attempt++){
      waiting=(await pool.query(`SELECT EXISTS (
        SELECT 1 FROM pg_locks held JOIN pg_locks waiter
          ON waiter.locktype=held.locktype AND waiter.classid=held.classid
         AND waiter.objid=held.objid AND waiter.objsubid=held.objsubid
        WHERE held.pid=$1 AND held.locktype='advisory' AND held.granted AND NOT waiter.granted
      ) AS waiting`,[pid])).rows[0].waiting;
      if(waiting)break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    expect(waiting).toBe(true);
    expect((await configure(second,'+27820001008')).state.statusCode).toBe(200);
    await blocker.query('COMMIT');
    expect((await pending).state.statusCode).toBe(200);
  }finally{
    await blocker.query('ROLLBACK');
    blocker.release();
    if(pending)await pending;
  }
});

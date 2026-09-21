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
const shared='+27820002001';
const companies=[first,second];
const tokens=new Map<string,string>();
const authToken='disposable-whatsapp-signature-fixture';
const origin='http://localhost:3200';
const url='/api/accounting/capture/inbound/whatsapp';
beforeAll(async()=>{
  await pool.query(readFileSync('scripts/migrations/sql/618_capture_whatsapp_provider_proof.sql','utf8'));
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
    await pool.query('DELETE FROM capture_whatsapp_claims WHERE company_id=ANY($1::uuid[])',[companies]);
    await pool.query('DELETE FROM capture_inboxes WHERE company_id=ANY($1::uuid[])',[companies]);
    await pool.query('DELETE FROM company_users WHERE company_id=ANY($1::uuid[]) AND user_id=ANY($2::text[])',[companies,[userA,userB]]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[companies]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::text[])',[[userA,userB]]);
  }finally{await pool.end();}
});
async function configure(company:string,address:string){
  const req=request({'sb-access-token':tokens.get(company)!,active_company_id:company},'POST');
  req.url='/api/accounting/capture/whatsapp-inbox';req.body={address};
  const result=response();await inboxRoute(req,result.res);return result;
}
async function deliver(signature?:string,toNumber=shared){
  const body={From:'whatsapp:+27821111111',To:`whatsapp:${toNumber}`,Body:'Paid R100 at Fixture',NumMedia:'0',WaId:'27821111111',MessageSid:'SM-disposable-routing'};
  const req=request({},'POST');req.url=url;req.body=body;
  req.headers['x-twilio-signature']=signature??twilio.getExpectedTwilioSignature(authToken,origin+url,body);
  const result=response();await webhook(req,result.res);return result;
}
it('a first registrant cannot activate an unproven number or receive its signed traffic',async()=>{
  const claim=await configure(first,shared);
  expect(claim.state.statusCode).toBe(200);
  const inbound=await deliver();
  expect(inbound.state.statusCode).toBe(200);
  const events=(await pool.query('SELECT company_id FROM capture_events WHERE company_id=ANY($1::uuid[])',[companies])).rows;
  expect(events,'Unproven first claimant must not receive a provider-authenticated message').toEqual([]);
  expect(claim.state.body).toMatchObject({data:{isActive:false}});
});

type Pending = { address: string; verificationUrl: string };
async function start(company:string,address=shared):Promise<Pending>{
  const result=await configure(company,address);
  expect(result.state.statusCode).toBe(200);
  expect(result.state.body).toMatchObject({data:{isActive:false}});
  return (result.state.body as {data:Pending}).data;
}
async function callback(pending:Pending,options:{to?:string;url?:string;signUrl?:string;body?:Record<string,string>;omit?:string[]}={}){
  const target=options.url??pending.verificationUrl;
  const body:Record<string,string>={From:'whatsapp:+27821111111',To:`whatsapp:${options.to??pending.address}`,Body:'Paid R100 at Fixture',NumMedia:'0',WaId:'27821111111',MessageSid:crypto.randomUUID(),...options.body};
  for(const key of options.omit??[])delete body[key];
  const req=request({},'POST');const parsed=new URL(target);
  req.url=parsed.pathname+parsed.search;req.body=body;
  req.headers['x-twilio-signature']=twilio.getExpectedTwilioSignature(authToken,options.signUrl??target,body);
  const result=response();await webhook(req,result.res);return result;
}
async function active(company:string){
  return (await pool.query("SELECT address FROM capture_inboxes WHERE company_id=$1 AND channel='whatsapp' AND is_active",[company])).rows;
}
async function rejected(pending:Pending,options:Parameters<typeof callback>[1]={}){
  const before=(await pool.query('SELECT id FROM capture_events WHERE company_id=ANY($1::uuid[])',[companies])).rows.length;
  expect((await callback(pending,options)).state.body).toMatchObject({data:{rejected:'destination verification required'}});
  expect((await pool.query('SELECT id FROM capture_events WHERE company_id=ANY($1::uuid[])',[companies])).rows).toHaveLength(before);
}
it('pending claims do not reserve a number; the company proving delivery receives subsequent capture',async()=>{
  await start(first);
  const owner=await start(second);
  expect(await active(first)).toEqual([]);
  const verified=await callback(owner);
  expect(verified.state.body).toMatchObject({data:{companyId:second}});
  expect(await active(second)).toEqual([{address:shared}]);
  expect((await callback(owner)).state.body).toMatchObject({data:{companyId:second}});
});
it('valid signatures for wrong number, missing, unknown and duplicated tokens cause no capture',async()=>{
  const pending=await start(first,'+27820002002');
  await rejected(pending,{to:'+27820002999'});
  await rejected(pending,{url:origin+url});
  await rejected(pending,{url:origin+url+'?token='+ 'a'.repeat(43)});
  await rejected(pending,{url:pending.verificationUrl+'&token='+new URL(pending.verificationUrl).searchParams.get('token')});
  expect(await active(first)).toEqual([]);
  expect((await callback(pending,{signUrl:origin+url})).state.statusCode).toBe(403);
});
it('expired or replaced challenges cannot activate and newest challenge can',async()=>{
  const expired=await start(first,'+27820002002');
  await pool.query("UPDATE capture_whatsapp_claims SET expires_at=NOW()-INTERVAL '1 second' WHERE company_id=$1",[first]);
  await rejected(expired);
  const replaced=await start(first,'+27820002002');
  const current=await start(first,'+27820002003');
  await rejected(replaced);
  expect((await callback(current)).state.body).toMatchObject({data:{companyId:first}});
});
it('a pending rotation and conflicting proof preserve the previous verified callback',async()=>{
  const original=await start(first,'+27820002003');await callback(original);
  const conflict=await start(first,shared);
  await rejected(conflict);
  expect(await active(first)).toEqual([{address:'+27820002003'}]);
  expect((await callback(original)).state.body).toMatchObject({data:{companyId:first}});
  const rotation=await start(first,'+27820002004');
  expect((await callback(rotation)).state.body).toMatchObject({data:{companyId:first}});
  await rejected(original);
  const retired=await start(second,'+27820002003');await rejected(retired);
  expect(await active(second)).toEqual([{address:shared}]);
});
it('creator role is rechecked at activation; a manager can verify',async()=>{
  const pending=await start(first,'+27820002005');
  await pool.query("UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2",[first,userA]);
  try{await rejected(pending);}finally{await pool.query("UPDATE company_users SET role='manager' WHERE company_id=$1 AND user_id=$2",[first,userA]);}
  expect((await callback(pending)).state.body).toMatchObject({data:{companyId:first}});
  await pool.query("UPDATE company_users SET role='admin' WHERE company_id=$1 AND user_id=$2",[first,userA]);
});
it('suspended user and company cannot activate a pending proof',async()=>{
  const pending=await start(first,'+27820002006');
  await pool.query('UPDATE users SET is_active=false WHERE id=$1',[userA]);
  try{await rejected(pending);}finally{await pool.query('UPDATE users SET is_active=true WHERE id=$1',[userA]);}
  await pool.query("UPDATE companies SET status='suspended' WHERE id=$1",[first]);
  try{await rejected(pending);}finally{await pool.query("UPDATE companies SET status='active' WHERE id=$1",[first]);}
  expect((await callback(pending)).state.body).toMatchObject({data:{companyId:first}});
});
it('a callback waiting on a company lock rechecks a replaced challenge after acquiring it',async()=>{
  const stale=await start(first,'+27820002007');
  const blocker=await pool.connect();let pending:ReturnType<typeof callback>|undefined;
  try{
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,617))',[first]);
    const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    pending=callback(stale);
    let waiting=false;
    for(let attempt=0;attempt<100;attempt++){
      waiting=(await pool.query(`SELECT EXISTS (SELECT 1 FROM pg_locks held JOIN pg_locks waiter
        ON waiter.locktype=held.locktype AND waiter.classid=held.classid AND waiter.objid=held.objid AND waiter.objsubid=held.objsubid
        WHERE held.pid=$1 AND held.locktype='advisory' AND held.granted AND NOT waiter.granted) AS waiting`,[pid])).rows[0].waiting;
      if(waiting)break;await new Promise(resolve=>setTimeout(resolve,20));
    }
    expect(waiting).toBe(true);
    // Emulate replacement while holding the exact lock used by the real POST.
    await blocker.query("UPDATE capture_whatsapp_claims SET token_hash=repeat('b',64) WHERE company_id=$1",[first]);
    await blocker.query('COMMIT');
    expect((await pending).state.body).toMatchObject({data:{rejected:'destination verification required'}});
    expect(await active(first)).toEqual([{address:'+27820002006'}]);
  }finally{await blocker.query('ROLLBACK');blocker.release();if(pending)await pending;}
});
it('migration repeats without inventing proof for legacy rows',async()=>{
  await pool.query("INSERT INTO capture_inboxes(company_id,channel,address,is_active) VALUES($1,'whatsapp','+27820002008',false)",[second]);
  await pool.query(readFileSync('scripts/migrations/sql/618_capture_whatsapp_provider_proof.sql','utf8'));
  expect((await pool.query("SELECT webhook_token_hash,provider_verified_at FROM capture_inboxes WHERE company_id=$1 AND address='+27820002008'",[second])).rows).toEqual([{webhook_token_hash:null,provider_verified_at:null}]);
});
it('removed creator membership prevents activation',async()=>{
  const pending=await start(first,'+27820002009');
  await pool.query('DELETE FROM company_users WHERE company_id=$1 AND user_id=$2',[first,userA]);
  try{await rejected(pending);}finally{await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",[first,userA]);}
});
it('claim RLS restricts an authenticated member to the selected company',async()=>{
  await start(first,'+27820002009');await start(second,'+27820002010');
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'viewer')",[second,userA]);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify({sub:userA}),first]);
    expect((await client.query('SELECT company_id FROM capture_whatsapp_claims')).rows).toEqual([{company_id:first}]);
    expect((await client.query('UPDATE capture_whatsapp_claims SET expires_at=NOW() WHERE company_id=$1 RETURNING company_id',[second])).rows).toEqual([]);
  }finally{await client.query('ROLLBACK');client.release();await pool.query('DELETE FROM company_users WHERE company_id=$1 AND user_id=$2',[second,userA]);}
});
it('historical inventory is read-only and limited to the supplied company',async()=>{
  const rows=(await pool.query(readFileSync('docs/audits/remediation/R-003/historical-impact.sql','utf8'),[second])).rows;
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({company_id:second,address:'+27820002008',provider_verified_at:null});
});

it('a signed outbound status callback cannot prove the recipient number',async()=>{
  const pending=await start(first,'+27820002011');
  await rejected(pending,{body:{MessageStatus:'delivered',SmsStatus:'delivered'}});
});

it.each(['sent','delivered','read','failed'])('signed %s status cannot establish inbound authority',async status=>{
  const pending=await start(first,'+27820002011');
  await rejected(pending,{body:{MessageStatus:status}});
});
it('missing inbound fields, wrong sender identity and query-supplied body fields do not prove a number',async()=>{
  const pending=await start(first,'+27820002012');
  await rejected(pending,{omit:['Body','NumMedia','WaId']});
  await rejected(pending,{body:{WaId:'27829999999'}});
  await rejected(pending,{omit:['Body','NumMedia','WaId'],url:pending.verificationUrl+'&Body=verification&NumMedia=0&WaId=27821111111'});
});

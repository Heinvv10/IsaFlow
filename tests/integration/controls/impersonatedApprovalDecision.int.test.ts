import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {SignJWT} from 'jose';
import type {NextApiRequest,NextApiResponse} from 'next';
import {platformImportApprovalFixture} from './platformImportApprovalFixture';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {validateFixtureTarget} from '../forensic-fixture';
import {mintImpersonationProof} from '@/lib/auth/impersonationAssurance';
import {IMPERSONATION_PROOF_COOKIE} from '@/lib/auth/impersonation-cookies';
import {ACCESS_COOKIE,ACTIVE_COMPANY_COOKIE} from '@/lib/auth/cookies';
import {historicalHash,storeHistoricalImportSource} from '@/modules/accounting/services/controls/historicalImportSourceService';
import {prepareHistoricalImport} from '@/modules/accounting/services/controls/historicalImportPreparation';
import {requestOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import {executeHistoricalImport} from '@/modules/accounting/services/controls/historicalImportExecution';
import approvalsRoute from '../../../pages/api/accounting/control-approvals';
import exceptionsRoute from '../../../pages/api/accounting/control-exceptions';
import type {OperationRef} from '@/modules/accounting/services/controls/contracts';

const csrf='impersonation-decision-csrf-0123456789012345';
function response(){
 const headers=new Map<string,unknown>();
 return {statusCode:200,body:undefined as unknown,headersSent:false,finished:false,
  status(code:number){this.statusCode=code;return this;},
  setHeader(name:string,value:unknown){headers.set(name.toLowerCase(),value);return this;},
  getHeader(name:string){return headers.get(name.toLowerCase());},
  json(body:unknown){this.body=body;return this.end();},
  end(){this.headersSent=true;this.finished=true;return this;}};
}
type Decision={status:number;body:{success?:boolean;message?:string;data?:{status?:string}}};
type Route=(req:NextApiRequest,res:NextApiResponse)=>Promise<unknown>;
async function post(route:Route,url:string,body:unknown,cookies:Record<string,string>):Promise<Decision>{
 const jar={...cookies,isaflow_csrf:csrf};
 const req={method:'POST',url,query:{},cookies:jar,body,
  headers:{cookie:Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; '),'x-csrf-token':csrf},
  socket:{remoteAddress:'127.0.0.91'}} as unknown as NextApiRequest;
 const res=response();
 await route(req,res as unknown as NextApiResponse);
 return {status:res.statusCode,body:res.body as Decision['body']};
}
async function list(cookies:Record<string,string>):Promise<Decision>{
 const jar={...cookies,isaflow_csrf:csrf};
 const req={method:'GET',url:'/api/accounting/control-approvals',query:{action:'pending'},cookies:jar,
  headers:{cookie:Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; ')},
  socket:{remoteAddress:'127.0.0.91'}} as unknown as NextApiRequest;
 const res=response();
 await (approvalsRoute as Route)(req,res as unknown as NextApiResponse);
 return {status:res.statusCode,body:res.body as Decision['body']};
}
const decide=(cookies:Record<string,string>,approvalId:string)=>
 post(approvalsRoute as Route,'/api/accounting/control-approvals',{action:'decide',approvalId,decision:'approved'},cookies);

describe('control approval decisions under actual impersonated sessions: actual PostgreSQL and withAuth',()=>{
 let h:Awaited<ReturnType<typeof platformImportApprovalFixture>>;
 let target:string;
 const secret=randomBytes(32).toString('hex');
 async function session(person:string,sessionId:string,aal:'aal1'|'aal2'){
  return new SignJWT({sub:person,session_id:sessionId,aal,role:'authenticated',aud:'authenticated',email:`${person}@forensic.invalid`})
   .setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
 }
 /** Exactly the cookies the impersonation route sets: the target's own session plus the actor's delegation proof. */
 /** A live impersonation: the stash row the admin route writes, plus its cookies. */
 async function impersonated(sessionId:string,stash?:string){
  const now=Math.floor(Date.now()/1000);
  const stashId=stash??await stashRow();
  return {[ACCESS_COOKIE]:await session(target,sessionId,'aal1'),[ACTIVE_COMPANY_COOKIE]:h.f.companyA,
   [IMPERSONATION_PROOF_COOKIE]:await mintImpersonationProof({actorUserId:h.admin,targetUserId:target,
    targetSessionId:sessionId,stashId,actorExpiresAt:now+3600,stashExpiresAt:now+3600})};
 }
 const stashRow=async()=>(await h.pool.query(`INSERT INTO admin_impersonation_stash(admin_user_id,admin_access_token,admin_refresh_token,target_user_id,expires_at)
  VALUES($1,'ciphertext','ciphertext',$2,NOW()+interval '1 hour') RETURNING stash_id`,[h.admin,target])).rows[0].stash_id;
 async function ordinary(sessionId:string){
  return {[ACCESS_COOKIE]:await session(target,sessionId,'aal2'),[ACTIVE_COMPANY_COOKIE]:h.f.companyA};
 }
 /** A member-authored request, so the refusal cannot be explained by platform authority. */
 async function memberApproval(){
  const source={...h.body(),sourceKey:randomUUID()},bytes=Buffer.from(JSON.stringify(source));
  const retained=await h.member(h.f.u1.id,ctx=>storeHistoricalImportSource(ctx,{bytes,mimeType:'application/json'}));
  const prepared=await h.member(h.f.u1.id,ctx=>prepareHistoricalImport(ctx,{sourceSystem:'csv',sourceKey:source.sourceKey,
   kind:'customer_invoice',mode:'post_journal',accountingDate:'2023-02-28',evidenceId:retained.sourceId,sourceRecordIds:['1','2','3']}));
  const ref:OperationRef={entityType:'historical_import',entityId:prepared.importId,operation:'historical_import.post'};
  return {ref,approval:await h.member(h.f.u1.id,ctx=>requestOperationApproval(ctx,ref))};
 }
 const status=async(id:string)=>(await h.pool.query('SELECT status FROM control_operation_approvals WHERE company_id=$1 AND id=$2',[h.f.companyA,id])).rows[0].status;
 const decisions=async(id:string)=>(await h.pool.query('SELECT policy_id FROM control_operation_decisions WHERE company_id=$1 AND approval_id=$2',[h.f.companyA,id])).rowCount;

 beforeAll(async()=>{
  h=await platformImportApprovalFixture();target=h.f.u2.id;
  process.env.DATABASE_URL=validateFixtureTarget(fixtureConfigFromEnv(process.env)).connectionString;
  process.env.JWT_SECRET=secret;process.env.SENTRY_ENABLED='false';
  process.env.GOTRUE_URL='http://gotrue.forensic.invalid';process.env.SUPABASE_ANON_KEY='synthetic-anon';
 },40000);
 afterAll(async()=>{await h?.close();});

 it('refuses the platform maker approving his own import through an impersonated tenant administrator',async()=>{
  const p=await h.prepared(),approval=await h.request(p.ref);
  const result=await decide(await impersonated(`impersonation-${randomUUID()}`),approval.id);
  expect(result.status).toBe(500);
  expect(result.body.message).toBe('Impersonated self approval is not permitted');
  expect(await status(approval.id)).toBe('pending');expect(await decisions(approval.id)).toBe(0);
  expect(await h.noEffects(p.ref)).toEqual({journals:0,effects:0});
  await expect(h.execute(p.ref,approval.id)).rejects.toThrow();
 });

 it('refuses any impersonated decision on another member\'s request',async()=>{
  const {ref,approval}=await memberApproval();
  const result=await decide(await impersonated(`impersonation-${randomUUID()}`),approval.id);
  expect(result.status).toBe(500);
  expect(result.body.message).toBe('An impersonated session cannot record an independent review');
  expect(await status(approval.id)).toBe('pending');expect(await decisions(approval.id)).toBe(0);
  expect(await h.noEffects(ref)).toEqual({journals:0,effects:0});
 });

 it('refuses a recorded impersonation session whose delegation proof cookie was dropped',async()=>{
  const p=await h.prepared(),approval=await h.request(p.ref),sessionId=`impersonation-${randomUUID()}`;
  await h.pool.query(`INSERT INTO admin_audit_log(admin_user_id,action,target_type,target_id,details)
   VALUES($1::uuid,'impersonation_start','user',$2::uuid,$3::jsonb)`,[h.admin,target,JSON.stringify({target_session_id:sessionId})]);
  const cookies=await impersonated(sessionId);delete cookies[IMPERSONATION_PROOF_COOKIE];
  // Without the proof the session is an ordinary AAL1 cookie: GoTrue reports the target has no verified factor.
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({id:target,factors:[]})));
  try{
   const result=await decide(cookies,approval.id);
   expect(result.status).toBe(500);
   expect(result.body.message).toBe('Impersonated self approval is not permitted');
  }finally{vi.unstubAllGlobals();}
  expect(await status(approval.id)).toBe('pending');expect(await decisions(approval.id)).toBe(0);
 });

 it('refuses the maker approving his own import from his own tenant session token',async()=>{
  const p=await h.prepared(),approval=await h.request(p.ref);
  await h.pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",[h.f.companyA,h.admin]);
  try{
   const cookies={[ACCESS_COOKIE]:await session(h.admin,`maker-${randomUUID()}`,'aal2'),[ACTIVE_COMPANY_COOKIE]:h.f.companyA};
   const result=await decide(cookies,approval.id);
   expect(result.status).toBe(500);
   expect(result.body.message).toBe('Self approval is not permitted');
  }finally{await h.pool.query('DELETE FROM company_users WHERE company_id=$1 AND user_id=$2',[h.f.companyA,h.admin]);}
  expect(await status(approval.id)).toBe('pending');expect(await decisions(approval.id)).toBe(0);
 });
 it('refuses a high risk control exception resolved through an impersonated session',async()=>{
  const exceptionId=randomUUID();
  await h.pool.query(`INSERT INTO control_exceptions(company_id,id,check_id,finding_key,check_version,finding,severity,reporter_person_id)
   VALUES($1,$2,'three_way_match_exceptions',$3,1,'{}'::jsonb,'high',$4)`,[h.f.companyA,exceptionId,`impersonation-${exceptionId}`,h.f.u1.id]);
  const body={action:'resolve',exceptionId,expectedVersion:1,resolution:'accepted_risk',
   reason:'Reviewed under an impersonated session',expiresAt:'2099-01-01T00:00:00.000Z'};
  const refused=await post(exceptionsRoute as Route,'/api/accounting/control-exceptions',body,await impersonated(`impersonation-${randomUUID()}`));
  expect(refused.status).toBe(500);
  expect(refused.body.message).toBe('An impersonated session cannot record an independent review');
  const row=(await h.pool.query('SELECT status,reviewer_person_id,version FROM control_exceptions WHERE company_id=$1 AND id=$2',[h.f.companyA,exceptionId])).rows[0];
  expect(row).toMatchObject({status:'open',reviewer_person_id:null,version:1});
  const allowed=await post(exceptionsRoute as Route,'/api/accounting/control-exceptions',body,await ordinary(`ordinary-${randomUUID()}`));
  expect(allowed.status).toBe(200);
  expect((await h.pool.query('SELECT status,reviewer_person_id FROM control_exceptions WHERE company_id=$1 AND id=$2',[h.f.companyA,exceptionId])).rows[0])
   .toEqual({status:'accepted_risk',reviewer_person_id:target});
 });
 it('stops accepting the delegation proof once the impersonation has ended',async()=>{
  const sessionId=`impersonation-${randomUUID()}`,now=Math.floor(Date.now()/1000);
  const stash=await stashRow();
  const cookies=await impersonated(sessionId,stash);
  // While the delegation lives the proof still satisfies the session gate.
  expect((await list(cookies)).status).toBe(200);
  // Ending impersonation deletes the stash; the copied cookies must stop authenticating.
  await h.pool.query('DELETE FROM admin_impersonation_stash WHERE stash_id=$1',[stash]);
  expect((await list(cookies)).status).toBe(401);
 });
 it('stops accepting the delegation proof once an end is recorded for that session',async()=>{
  const sessionId=`impersonation-${randomUUID()}`,now=Math.floor(Date.now()/1000);
  const stash=await stashRow();
  const cookies=await impersonated(sessionId,stash);
  expect((await list(cookies)).status).toBe(200);
  await h.pool.query(`INSERT INTO admin_audit_log(admin_user_id,action,target_type,target_id,details)
   VALUES($1::uuid,'impersonation_end','user',$2::uuid,$3::jsonb)`,[h.admin,target,JSON.stringify({target_session_id:sessionId})]);
  expect((await list(cookies)).status).toBe(401);
  await h.pool.query('DELETE FROM admin_impersonation_stash WHERE stash_id=$1',[stash]);
 });
 it('still lets the same tenant administrator approve and the maker post from an unimpersonated session',async()=>{
  const p=await h.prepared(),approval=await h.request(p.ref);
  const result=await decide(await ordinary(`ordinary-${randomUUID()}`),approval.id);
  expect(result.status).toBe(200);expect(result.body.success).toBe(true);
  expect(await status(approval.id)).toBe('approved');expect(await decisions(approval.id)).toBe(1);
  const posted=await h.maker({action:'execute',importId:p.ref.entityId},ctx=>executeHistoricalImport(ctx,p.ref,approval.id));
  expect(posted).toMatchObject({importId:p.ref.entityId,amount:'1150'});
  expect(await h.noEffects(p.ref)).toEqual({journals:1,effects:1});
 });
});

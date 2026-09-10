import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {copyFile,mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {finalizeRequestTransaction} from '@/lib/auth/transactionFinalization';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import type {ControlTx,OperationRef} from '@/modules/accounting/services/controls/contracts';
export type Person='u1'|'u2'|'u3';
export interface Identity {id:string;companyId:string}
export const upper=(id:string)=>{const value=id.toUpperCase();if(value===id)throw new Error('Synthetic UUID lacks case distinction');return value;};
/** Actual app_user/RLS requests that settle through real COMMIT observers; no auth mocks, no preverified rows. */
export async function uuidBoundaryFixture(){
 process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
 const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
 process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
 const pool=new Pool({connectionString:target.connectionString,ssl:false,max:4,statement_timeout:15000});
 try{
  const f=await provisionForensicFixture(config);
  async function actor<T>(fn:(ctx:ControlTx)=>Promise<T>,person:Person='u1',as?:Identity):Promise<T>{
   const user=as??f[person],client=await pool.connect();
   try{
    await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
    const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
    await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
    const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},
     {personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>fn(requireControlTx()));
    await finalizeRequestTransaction(client,false);return result;
   }catch(error){await finalizeRequestTransaction(client,true);throw error;}finally{client.release();}
  }
  /** Maker requests; a different company member decides whenever a policy leaves the request pending. */
  async function approve(ref:OperationRef,maker:Identity=f.u1,checker:Identity=f.u2){
   const request=await actor(ctx=>requestOperationApproval(ctx,ref),'u1',maker);
   if(request.status==='pending')await actor(ctx=>decideOperationApproval(ctx,request.id,'approved'),'u2',checker);
   return request.id as string;
  }
  async function effects(entityType:string,operation:string,id:string,company=f.companyA){
   return(await pool.query(`SELECT id,entity_id,operation_id,binding_hash,result FROM control_operation_effects
    WHERE company_id=$1 AND entity_type=$2 AND operation=$3 AND lower(entity_id)=lower($4) ORDER BY committed_at,id`,[company,entityType,operation,id])).rows;
  }
  async function approvals(entityType:string,id:string,company=f.companyA){
   return(await pool.query(`SELECT id,status,consumed_effect_id FROM control_operation_approvals
    WHERE company_id=$1 AND entity_type=$2 AND lower(entity_id)=lower($3) ORDER BY requested_at,id`,[company,entityType,id])).rows;
  }
  /** Settles every attempt, then reports the outcomes so a refusal and a duplicate are both observable. */
  async function attempt<T>(fn:()=>Promise<T>):Promise<{value?:T;error?:unknown}>{
   try{return{value:await fn()};}catch(error){return{error};}
  }
  return{pool,f,actor,approve,effects,approvals,attempt,close:()=>pool.end()};
 }catch(error){await pool.end();throw error;}
}
/**
 * Runs a legacy seed runner inside the isolated pre-normalization baseline (fad0f57f7) so retained
 * rows are written by genuine old code. Only test files are copied; src and migrations must be pristine.
 */
export async function runBaselineSeed(runner:string,dependencies:string[],args:string[]=[]):Promise<unknown>{
 const baseline=process.env.ISAFLOW_UUID_BOUNDARY_BASELINE;
 if(!baseline)throw new Error('Set ISAFLOW_UUID_BOUNDARY_BASELINE to the isolated fad0f57f7 worktree');
 const run=promisify(execFile),directory=await mkdtemp(path.join(tmpdir(),'isaflow-uuid-boundary-')),artifact=path.join(directory,'seed.json');
 try{
  const head=await run('git',['rev-parse','--short=9','HEAD'],{cwd:baseline});
  if(head.stdout.trim()!=='fad0f57f7')throw new Error('Baseline worktree is not fad0f57f7');
  await run('git',['diff','--exit-code','fad0f57f7','--','src','scripts/migrations/sql'],{cwd:baseline});
  for(const file of [runner,...dependencies])await copyFile(path.join(__dirname,file),path.join(baseline,'tests/integration/controls',file));
  await run('bun',[`tests/integration/controls/${runner}`,artifact,...args],{cwd:baseline,timeout:60000,maxBuffer:4*1024*1024});
  return JSON.parse(await readFile(artifact,'utf8')) as unknown;
 }finally{await rm(directory,{recursive:true,force:true});}
}

import {log} from '@/lib/logger';
import {recordBatchEntity} from './batchPaymentWriteService';
import {Pool} from 'pg';
import {UUID_RE} from '@/lib/validation';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {finalizeRequestTransaction} from '@/lib/auth/transactionFinalization';
import {assertControlTx,withControlRequest,requireControlTx} from '../controls/context';
import {observeControlTransaction,settleControlTransaction} from '../controls/transactionObservers';
import type {ControlPrincipal,ControlTx} from '../controls/contracts';
import {claimPaymentRelease,type ReleaseClaim} from './paymentReleaseClaim';
import {paymentReleaseAmount} from './paymentReleaseValidation';
import {renderReleasedEft} from './paymentReleaseFile';
let pool:Pool|undefined;
function dispatchPool(){
 if(!pool){
  if(!process.env.DATABASE_URL)throw new Error('Release database unavailable');
  pool=new Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:2000,idleTimeoutMillis:10000,
   statement_timeout:5000,query_timeout:6000,
   ssl:process.env.DATABASE_SSL==='disable'?false:process.env.DATABASE_SSL==='strict'?{rejectUnauthorized:true}:{rejectUnauthorized:false}});
  pool.on('error',()=>log.error('Payment release database connection failed',{},'payment-release'));
 }
 return pool;
}
export async function closePaymentReleasePool(){if(pool){await pool.end();pool=undefined;}}
type Identity=Pick<ControlPrincipal,'companyId'|'personId'|'connectionId'|'grantId'|'grantedScopes'> & {authMethod:'cookie'|'pat'|'oauth'};
async function transaction<T>(identity:Identity,action:(ctx:ControlTx)=>Promise<T>):Promise<T>{
 const client=await dispatchPool().connect();let finished=false;
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  const claims={sub:identity.personId,role:'authenticated',company_id:identity.companyId};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),identity.companyId]);
  const result=await withControlRequest({client,userId:identity.personId,companyId:identity.companyId,claims},identity,()=>action(requireControlTx()));
  await finalizeRequestTransaction(client,false);finished=true;return result;
 }catch(error){
  if(!finished){try{await finalizeRequestTransaction(client,true);}catch{await settleControlTransaction(client,'unknown');}}
  throw error;
 }finally{client.release();}
}
/** This function is private: only a claim returned from a completed transaction reaches the transport. */
async function transmit(claim:ReleaseClaim):Promise<{state:'accepted'|'unknown'|'exported';code:string;providerBatchReference?:string}>{
 if(claim.payload.channel==='eft'){renderReleasedEft(claim.payload);return{state:'exported',code:'FILE_GENERATED'};}
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
 try{
  const response=await fetch('https://api.netcash.co.za/v1/eft/submit',{method:'POST',signal:controller.signal,
   headers:{'Content-Type':'application/json','X-ServiceKey':claim.serviceKey},
   body:JSON.stringify({serviceKey:claim.serviceKey,payoutsKey:claim.payoutsKey,batchReference:claim.providerReference,
    payments:claim.payload.payments.map(p=>({accountHolder:p.beneficiaryName,bankCode:p.beneficiaryBranchCode,accountNumber:p.beneficiaryAccountNumber,
     amountCents:paymentReleaseAmount(String(p.amount),'ZAR').cents,reference:p.reference}))})});
  if(!response.ok)return{state:'unknown',code:'PROVIDER_RESPONSE_UNCERTAIN'};
  const data:unknown=await response.json();
  const reference=data&&typeof data==='object'&&'batchReference' in data?data.batchReference:null;
  if(typeof reference!=='string'||!reference.length||reference.length>128||/[\r\n\u0000-\u001f]/.test(reference))return{state:'unknown',code:'PROVIDER_RESPONSE_UNCERTAIN'};
  return{state:'accepted',code:'PROVIDER_ACCEPTED',providerBatchReference:reference};
 }catch{return{state:'unknown',code:'PROVIDER_RESPONSE_UNCERTAIN'};}
 finally{clearTimeout(timer);}
}
/** Register during the authenticated request; no escaped ctx, body identity, or recoverable fake cookie. */
export async function schedulePaymentReleaseDispatch(ctx:ControlTx,intentId:string):Promise<void>{
 assertControlTx(ctx);if(!UUID_RE.test(intentId)||(ctx.principal.authMethod==='job'||ctx.principal.authMethod==='platform_import'))throw new Error('Authenticated fixed release required');
 await assertEffectivePermission(ctx,'write:release');
 const [intent]=await ctx.sql`SELECT requester_person_id FROM control_payment_release_intents
  WHERE company_id=${ctx.principal.companyId}::uuid AND id=${intentId}::uuid` as Array<{requester_person_id:string}>;
 if(intent?.requester_person_id!==ctx.principal.personId)throw new Error('Release requester required');
 const p=ctx.principal;
 if(p.authMethod==='job'||p.authMethod==='platform_import')throw new Error('Authenticated release principal required');
 const identity:Identity=Object.freeze({companyId:p.companyId,personId:p.personId,authMethod:p.authMethod,
  connectionId:p.connectionId,grantId:p.grantId,grantedScopes:p.grantedScopes===null?null:Object.freeze([...p.grantedScopes])});
 let settled=false;
 observeControlTransaction(async outcome=>{
  if(settled)return;settled=true;if(outcome!=='committed')return;
  const claim=await transaction(identity,current=>claimPaymentRelease(current,intentId));
  if(!claim)return;
  // Only this lexical continuation owns the once-only capability after actual COMMIT.
  const result=await transmit(claim);
  await transaction(identity,current=>completePaymentRelease(current,claim,result));
 });
}

/** Only the lexical committed-claim transport continuation may acknowledge a provider result. */
async function completePaymentRelease(ctx:ControlTx,claim:ReleaseClaim,
 outcome:{state:'accepted'|'unknown'|'failed'|'exported';code:string;providerBatchReference?:string}){
 assertControlTx(ctx);
 const [before]=await ctx.sql`SELECT *,intent_id AS id FROM control_payment_release_outbox WHERE company_id=${ctx.principal.companyId}::uuid
  AND intent_id=${claim.intentId}::uuid AND attempt_id=${claim.attemptId}::uuid FOR UPDATE` as Array<Record<string,unknown>>;
 if(!before||before.state!=='attempting')throw new Error('Release attempt is not awaiting acknowledgement');
 const [after]=await ctx.sql`UPDATE control_payment_release_outbox SET state=${outcome.state},outcome_code=${outcome.code},
  provider_batch_reference=${outcome.providerBatchReference??null},finished_at=clock_timestamp()
  WHERE company_id=${ctx.principal.companyId}::uuid AND intent_id=${claim.intentId}::uuid AND attempt_id=${claim.attemptId}::uuid AND state='attempting'
  RETURNING *,intent_id AS id` as Array<Record<string,unknown>>;
 if(!after)throw new Error('Release acknowledgement failed');
 await recordBatchEntity(ctx,'payment_release_outbox',before,after,`payment_release.${outcome.state}`);
}

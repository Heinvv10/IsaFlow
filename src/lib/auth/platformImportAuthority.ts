import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {als,assertTxUsable,type RequestContext} from '@/lib/als';
import {sql} from '@/lib/neon';
import {assertControlTx,withControlPlatformImportRequest} from '@/modules/accounting/services/controls/context';
import type {ControlPrincipal,ControlTx} from '@/modules/accounting/services/controls/contracts';
import {isActiveUserAccount,type UserAccountRow} from './userAccountStatus';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const targetSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('retain'),companyId:uuid,sourceHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
 z.object({action:z.literal('prepare'),companyId:uuid,sourceId:uuid}).strict(),
 z.object({action:z.literal('request'),companyId:uuid,importId:uuid}).strict(),
 z.object({action:z.literal('execute'),companyId:uuid,importId:uuid}).strict(),
 z.object({action:z.literal('read'),companyId:uuid,importId:uuid}).strict(),
]);
export type PlatformImportTarget=Readonly<z.infer<typeof targetSchema>>;
export interface PlatformImportRequestCapability {readonly requestId:string}
type RequestLife={active:boolean;busy:boolean;store:RequestContext;client:RequestContext['client'];personId:string};
type TargetLife={active:boolean;request:RequestLife;store:RequestContext;target:PlatformImportTarget};
const requests=new WeakMap<PlatformImportRequestCapability,RequestLife>();
const registered=new WeakSet<RequestContext>();
const principals=new WeakMap<ControlPrincipal,TargetLife>();
function integrity(store:RequestContext){
 if(store.controlWriteFailed||store.criticalAuditFailed||store.txUnusable)throw new Error('Platform import transaction evidence or integrity failed');
}
function requestCurrent(life:RequestLife){
 if(!life.active||life.store.client!==life.client||life.store.userId!==life.personId||life.store.claims.sub!==life.personId)throw new Error('Platform import request lifetime changed');
 integrity(life.store);
}
/** Trusted middleware calls this only after verifying the global administrator cookie. */
export async function withPlatformImportRequest<T>(store:RequestContext,handler:(capability:PlatformImportRequestCapability)=>Promise<T>):Promise<T>{
 if(registered.has(store)||store.companyId||store.controlPrincipal||!store.userId||store.claims.sub!==store.userId)throw new Error('Verified global admin request required');
 integrity(store);
 const cap=Object.freeze({requestId:randomUUID()}),life:RequestLife={active:true,busy:false,store,client:store.client,personId:store.userId};
 requests.set(cap,life);registered.add(store);
 return als.run(store,async()=>{
  try{
   const result=await handler(cap);
   if(life.busy){store.controlWriteFailed=true;throw new Error('Platform import target still active at request completion');}
   requestCurrent(life);return result;
  }
  finally{life.active=false;registered.delete(store);}
 });
}
/** Context issuance and every later context use must retain this private target association. */
export function assertPlatformImportPrincipal(principal:ControlPrincipal,store:RequestContext):void{
 const life=principals.get(principal);
 if(!life?.active||life.store!==store||store.client!==life.request.client||store.userId!==life.request.personId
  ||principal.personId!==life.request.personId||principal.companyId!==life.target.companyId||store.companyId!==life.target.companyId)throw new Error('Platform import target authority unavailable');
 requestCurrent(life.request);integrity(store);
}
export function readPlatformImportTarget(ctx:ControlTx):PlatformImportTarget{
 assertControlTx(ctx);
 const life=principals.get(ctx.principal);if(!life)throw new Error('Platform import target authority unavailable');
 return life.target;
}
/** Current role/standing is verified on the same privileged transaction, never inferred from the body. */
async function currentStanding(personId:string,companyId:string){
 const rows=await sql`SELECT u.role,u.is_active,u.status,u.suspended_at,c.status AS company_status,c.suspended_at AS company_suspended_at
  FROM users u CROSS JOIN companies c WHERE u.id::text=${personId} AND c.id=${companyId}::uuid FOR SHARE OF u,c` as (UserAccountRow&{role:string;company_status:string|null;company_suspended_at:unknown})[];
 const row=rows[0];
 if(rows.length!==1||row?.role!=='super_admin'||!isActiveUserAccount(row)||row.company_suspended_at!=null
  ||['suspended','deleted'].includes(row.company_status??''))throw new Error('Current platform import authority unavailable');
}
/** Target selection is data. Only the private verified request capability grants an issuance attempt. */
export async function withPlatformImportTarget<T>(capability:PlatformImportRequestCapability,input:unknown,handler:(ctx:ControlTx)=>Promise<T>):Promise<T>{
 const target=Object.freeze(targetSchema.parse(input)),request=requests.get(capability);
 if(!request||als.getStore()!==request.store||request.busy)throw new Error('Platform import capability unavailable');
 requestCurrent(request);assertTxUsable();request.busy=true;
 const store:RequestContext={client:request.client,userId:request.personId,companyId:target.companyId,claims:request.store.claims};
 const principal:ControlPrincipal=Object.freeze({companyId:target.companyId,personId:request.personId,connectionId:null,grantId:null,actingFirmId:null,
  requestId:capability.requestId,operationId:randomUUID(),authMethod:'platform_import',provenance:'human',delegatedByPersonId:null,grantedScopes:null});
 const life:TargetLife={active:true,request,store,target};principals.set(principal,life);
 try{
  return await als.run(store,async()=>{
   await currentStanding(request.personId,target.companyId);requestCurrent(request);
   await sql`SELECT set_config('app.current_company_id',${target.companyId},true)`;requestCurrent(request);
   return withControlPlatformImportRequest(store,principal,()=>handlerContext(handler));
  });
 }finally{
  life.active=false;
  if(store.controlWriteFailed)request.store.controlWriteFailed=true;
  if(store.criticalAuditFailed)request.store.criticalAuditFailed=true;
  if(store.txUnusable)request.store.txUnusable=store.txUnusable;
  // A detached child must never issue SQL after its outer request has ended.
  if(request.active){
   try{await als.run(request.store,()=>sql`SELECT set_config('app.current_company_id',${''},true)`);}
   catch(error){request.store.txUnusable='Platform import target context restoration failed';throw error;}
  }
  request.busy=false;
 }
}
async function handlerContext<T>(handler:(ctx:ControlTx)=>Promise<T>){
 const {requireControlTx}=await import('@/modules/accounting/services/controls/context');
 return handler(requireControlTx());
}

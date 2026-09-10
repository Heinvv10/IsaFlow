import {z} from 'zod';
import type {McpTool} from '../types';
import {ok,toolError} from './toolHelpers';
import {requireControlTx} from '@/modules/accounting/services/controls/context';
import {canonicalJson} from '@/modules/accounting/services/controls/canonical';
import {EXCEPTION_CHECK_VERSIONS,parseExceptionCheck,parseExceptionList,parseExceptionAssignment,parseExceptionResolution} from '@/modules/accounting/services/controls/controlExceptionTypes';
import {captureControlExceptions,listControlExceptions,assignControlException,resolveControlException,authorizeControlExceptionTransition} from '@/modules/accounting/services/controls/controlExceptionService';
import {assertExceptionReadPermission} from '@/modules/accounting/services/controls/controlExceptionRecheck';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
const check=z.string(),limit=z.number().int().min(1).max(100).optional(),cursor=z.string().max(2048).optional();
const key=z.string().min(1).max(128),id=z.string().uuid(),version=z.number().int().positive();
const list=z.object({check_id:check,status:z.enum(['open','fixed','accepted_risk']).optional(),cursor:id.optional(),limit}).strict();
const capture=z.object({check_id:check,cutoff:z.string().optional(),cursor,limit,idempotency_key:key}).strict();
const assign=z.object({exception_id:id,expected_version:version,owner_person_id:z.string().min(1).max(200),due_at:z.string().nullable(),idempotency_key:key}).strict();
const resolve=z.object({exception_id:id,expected_version:version,resolution:z.enum(['fixed','accepted_risk']),reason:z.string().min(1).max(2000),expires_at:z.string().optional(),idempotency_key:key}).strict();
const names:Record<string,string>={check_id:'checkId',exception_id:'exceptionId',expected_version:'expectedVersion',owner_person_id:'ownerPersonId',due_at:'dueAt',expires_at:'expiresAt'};
function mapped(args:unknown,schema:z.ZodType){const parsed=schema.parse(JSON.parse(canonicalJson(args))) as Record<string,unknown>;return Object.fromEntries(Object.entries(parsed).filter(([key,value])=>key!=='idempotency_key'&&value!==undefined).map(([key,value])=>[names[key]??key,value]));}
const checkProp={type:'string',enum:Object.keys(EXCEPTION_CHECK_VERSIONS)},limitProp={type:'integer',minimum:1,maximum:100},uuid={type:'string',format:'uuid'},keyProp={type:'string',minLength:1,maxLength:128};
function make(name:string,description:string,write:boolean,properties:Record<string,unknown>,required:string[],parse:(args:unknown)=>unknown,run:(input:unknown)=>Promise<unknown>):McpTool{
 return{name,description,scope:write?'write:approvals':'read:reports',write,...(write?{perUserIdempotency:true}:{}),inputSchema:{type:'object',additionalProperties:false,properties,required},
 ...(write?{authorize:async(args:Record<string,unknown>)=>{
  const input=parse(args) as {checkId?:keyof typeof EXCEPTION_CHECK_VERSIONS;exceptionId?:string},ctx=requireControlTx();
  if(input.exceptionId)await authorizeControlExceptionTransition(ctx,input.exceptionId);
  else{await assertEffectivePermission(ctx,'write:approvals');await assertExceptionReadPermission(ctx,input.checkId!);}
 }}:{}),handler:async(args)=>{let input;try{input=parse(args);}catch{return toolError('Invalid exception arguments');}return ok(await run(input));}};
}
const retained=make('control_exceptions','Read retained exceptions only. Follow nextCursor; this does not run checks.',false,{check_id:checkProp,status:{type:'string',enum:['open','fixed','accepted_risk']},cursor:uuid,limit:limitProp},['check_id'],args=>{const input=mapped(args,list);parseExceptionList(input);return input;},input=>listControlExceptions(requireControlTx(),input));
const observed=make('capture_control_exceptions','Explicitly run one bounded check page and retain findings. Follow nextCursor; not complete until all pages observed.',true,{check_id:checkProp,cutoff:{type:'string',format:'date'},cursor:{type:'string',maxLength:2048},limit:limitProp,idempotency_key:keyProp},['check_id','idempotency_key'],args=>parseExceptionCheck(mapped(args,capture)),input=>captureControlExceptions(requireControlTx(),input));
const assignment=make('assign_exception','Assign an owned exception to a current person at the exact saved version.',true,{exception_id:uuid,expected_version:{type:'integer',minimum:1},owner_person_id:{type:'string',minLength:1,maxLength:200},due_at:{type:['string','null']},idempotency_key:keyProp},['exception_id','expected_version','owner_person_id','due_at','idempotency_key'],args=>parseExceptionAssignment(mapped(args,assign)),input=>assignControlException(requireControlTx(),input));
const resolution=make('resolve_exception','Request resolution using a fresh shared recheck. High-risk findings require an independent human through the authenticated review route; MCP cannot act as that human.',true,{exception_id:uuid,expected_version:{type:'integer',minimum:1},resolution:{type:'string',enum:['fixed','accepted_risk']},reason:{type:'string',minLength:1,maxLength:2000},expires_at:{type:'string'},idempotency_key:keyProp},['exception_id','expected_version','resolution','reason','idempotency_key'],args=>parseExceptionResolution(mapped(args,resolve)),input=>resolveControlException(requireControlTx(),input));
export const forensicExceptionTools=[retained,observed,assignment,resolution] as const;

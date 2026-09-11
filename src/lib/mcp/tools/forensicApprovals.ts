import {z} from 'zod';
import type {McpTool} from '../types';
import {ok,toolError} from './toolHelpers';
import {requireControlTx} from '@/modules/accounting/services/controls/context';
import {canonicalJson} from '@/modules/accounting/services/controls/canonical';
import {CONTROL_OPERATIONS} from '@/modules/accounting/services/controls/contracts';
import {canonicalOperationRef} from '@/modules/accounting/services/controls/operationMaterializer';
import {operationPermission,approvalOperationNames} from '@/modules/accounting/services/controls/operationPermissions';
import {assertOperationRequester} from '@/modules/accounting/services/controls/operationRequester';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {getApprovalRequirements,requestOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import {listOperationApprovals} from '@/modules/accounting/services/controls/approvalReadService';
const fields={operation:z.enum(CONTROL_OPERATIONS),entity_type:z.string().min(1).max(80),entity_id:z.string().min(1).max(80),expected_version:z.number().int().positive().optional(),reversal_date:z.string().optional()};
const read=z.object(fields).strict(),write=read.extend({idempotency_key:z.string().min(1).max(128)}).strict();
const page=z.object({limit:z.number().int().min(1).max(100).optional(),cursor:z.string().min(1).max(2048).optional()}).strict();
const properties={operation:{type:'string',enum:[...approvalOperationNames()]},entity_type:{type:'string',minLength:1,maxLength:80},entity_id:{type:'string',minLength:1,maxLength:80},expected_version:{type:'integer',minimum:1},reversal_date:{type:'string',format:'date'}};
function detached(args:Record<string,unknown>,company?:string):Record<string,unknown>{
 const input=JSON.parse(canonicalJson(args)) as Record<string,unknown>;
 if(company!==undefined&&Object.hasOwn(input,'company_id')){if(input.company_id!==company)throw new Error('Company assertion mismatch');delete input.company_id;}return input;
}
function ref(input:z.infer<typeof read>){return canonicalOperationRef({operation:input.operation,entityType:input.entity_type,entityId:input.entity_id,
 ...(input.expected_version===undefined?{}:{expectedVersion:input.expected_version}),...(input.reversal_date===undefined?{}:{reversalDate:input.reversal_date})});}
const requirements:McpTool={name:'approval_requirements',description:'Read current approval requirements for an exact controlled operation. Does not approve or execute it. Each policy names the company role that may approve it; owner_or_admin means a company owner or admin.',scope:null,write:false,
 inputSchema:{type:'object',additionalProperties:false,properties,required:['operation','entity_type','entity_id']},handler:async(args)=>{
  let input;try{input=ref(read.parse(detached(args)));}catch{return toolError('Invalid approval arguments');}
  return ok(await getApprovalRequirements(requireControlTx(),input));
 }};
const request:McpTool={name:'request_operation_approval',description:'Request independent human approval for current exact operation material. This does not execute the operation.',scope:'write:approvals',write:true,perUserIdempotency:true,
 inputSchema:{type:'object',additionalProperties:false,properties:{...properties,idempotency_key:{type:'string',minLength:1,maxLength:128}},required:['operation','entity_type','entity_id','idempotency_key']},
 authorize:async(args,context)=>{
  const input=ref(write.parse(detached(args,context.companyId))),ctx=requireControlTx();
  await assertEffectivePermission(ctx,operationPermission(input.operation,'read'));
  await assertEffectivePermission(ctx,'write:approvals');await assertEffectivePermission(ctx,operationPermission(input.operation,'write'));
  await assertOperationRequester(ctx,input,ctx.principal.personId);
 },handler:async(args,context)=>{
  let input;try{input=ref(write.parse(detached(args,context.companyId)));}catch{return toolError('Invalid approval arguments');}
  return ok(await requestOperationApproval(requireControlTx(),input));
 }};
const pending:McpTool={name:'list_pending_approvals',description:'Read currently permitted pending approvals, with a signed continuation cursor. Continue until nextCursor is null.',scope:'read:approvals',write:false,
 inputSchema:{type:'object',additionalProperties:false,properties:{limit:{type:'integer',minimum:1,maximum:100},cursor:{type:'string',minLength:1,maxLength:2048}},required:[]},handler:async(args)=>{
  let input;try{input=page.parse(detached(args));}catch{return toolError('Invalid approval page');}
  return ok(await listOperationApprovals(requireControlTx(),{...input,status:'pending'}));
 }};
export const forensicApprovalTools=[requirements,request,pending] as const;

import {z} from 'zod';
import type {McpTool} from '../types';
import {ok,toolError} from './toolHelpers';
import {requireControlTx} from '@/modules/accounting/services/controls/context';
import {canonicalJson} from '@/modules/accounting/services/controls/canonical';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {proposeBeneficiaryChange} from '@/modules/accounting/services/controls/beneficiaryService';
import {readSupplierBankChangeStatus} from '@/modules/accounting/services/controls/beneficiaryStatusService';
const uuid={type:'string',format:'uuid'},id=z.string().uuid();
const bank=z.object({bankName:z.string().min(1).max(100),accountNumber:z.string().regex(/^\d{5,30}$/),branchCode:z.string().regex(/^\d{6}$/),accountType:z.enum(['cheque','current','savings','transmission'])}).strict();
const evidence=z.object({store:z.literal('captured'),entityType:z.literal('supplier_invoice'),entityId:id,evidenceId:id,version:z.null(),hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const proposal=z.object({supplier_id:id,bank,evidence_refs:z.array(evidence).max(10),idempotency_key:z.string().min(1).max(128)}).strict();
const status=z.object({supplier_id:id,proposal_id:id.optional()}).strict();
function detached(args:Record<string,unknown>,company?:string):Record<string,unknown>{
 const input=JSON.parse(canonicalJson(args)) as Record<string,unknown>;
 if(company!==undefined&&Object.hasOwn(input,'company_id')){if(input.company_id!==company)throw new Error('Company assertion mismatch');delete input.company_id;}return input;
}
const proposed:McpTool={name:'propose_supplier_bank_change',description:'Create an encrypted supplier banking proposal and payment hold. Independent human evidence review is required before activation; this never verifies banking.',scope:'write:beneficiaries',write:true,perUserIdempotency:true,
 inputSchema:{type:'object',additionalProperties:false,required:['supplier_id','bank','evidence_refs','idempotency_key'],properties:{supplier_id:uuid,idempotency_key:{type:'string',minLength:1,maxLength:128},
  bank:{type:'object',additionalProperties:false,required:['bankName','accountNumber','branchCode','accountType'],properties:{bankName:{type:'string',minLength:1,maxLength:100},accountNumber:{type:'string',pattern:'^\\d{5,30}$'},branchCode:{type:'string',pattern:'^\\d{6}$'},accountType:{type:'string',enum:['cheque','current','savings','transmission']}}},
  evidence_refs:{type:'array',maxItems:10,items:{type:'object',additionalProperties:false,required:['store','entityType','entityId','evidenceId','version','hash'],properties:{store:{type:'string',enum:['captured']},entityType:{type:'string',enum:['supplier_invoice']},entityId:uuid,evidenceId:uuid,version:{type:'null'},hash:{type:'string',pattern:'^[a-f0-9]{64}$'}}}}}},
 authorize:async(args,context)=>{
  const input=proposal.parse(detached(args,context.companyId)),ctx=requireControlTx();await assertEffectivePermission(ctx,'write:beneficiaries');
  if(input.evidence_refs.length)await assertEffectivePermission(ctx,'read:invoices');
 },handler:async(args,context)=>{
  let input;try{input=proposal.parse(detached(args,context.companyId));}catch{return toolError('Invalid supplier bank proposal');}
  return ok(await proposeBeneficiaryChange(requireControlTx(),{entityType:'supplier',entityId:input.supplier_id},input.bank,input.evidence_refs));
 }};
const read:McpTool={name:'supplier_bank_change_status',description:'Read masked current supplier banking verification and proposal status. A pending hold does not activate proposed banking.',scope:'read:contacts',write:false,
 inputSchema:{type:'object',additionalProperties:false,required:['supplier_id'],properties:{supplier_id:uuid,proposal_id:uuid}},handler:async(args)=>{
  let input;try{input=status.parse(detached(args));}catch{return toolError('Invalid supplier bank status arguments');}
  return ok(await readSupplierBankChangeStatus(requireControlTx(),{supplierId:input.supplier_id,...(input.proposal_id===undefined?{}:{proposalId:input.proposal_id})}));
 }};
export const forensicBeneficiaryTools=[proposed,read] as const;

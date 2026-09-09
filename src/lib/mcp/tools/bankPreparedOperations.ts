import {z} from 'zod';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {requireControlTx} from '@/modules/accounting/services/controls/context';
import {bankControlSchema} from '@/modules/accounting/services/bank/bankControlActionSchema';
import {dispatchBankControlAction} from '@/modules/accounting/services/bank/bankControlActionService';
import type {McpTool,McpToolContext} from '../types';
import {inspectInput} from '../inputValidation';
import {mcpPostingOpts} from '../mcpActor';
import {ok,toolError} from './toolHelpers';
import {bankPreparedOperationSchema,bankPreparationActions,bankExecutionActions} from './bankPreparedOperationSchema';
const schema=z.object({instruction:bankControlSchema,idempotency_key:z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/)}).strict();
function parse(args:Record<string,unknown>,ctx:McpToolContext,prepare:boolean){
 inspectInput(args,true);
 const {company_id,...input}=args;
 if(company_id!==undefined&&company_id!==ctx.companyId)throw new Error('Company assertion mismatch');
 const parsed=schema.parse(input),allowed:readonly string[]=prepare?bankPreparationActions:bankExecutionActions;
 if(!allowed.includes(parsed.instruction.action))throw new Error('Wrong bank operation action');
 return parsed.instruction;
}
async function authority(ctx:McpToolContext){
 const issued=requireControlTx();
 if(issued.principal.companyId!==ctx.companyId||issued.principal.personId!==ctx.userId)throw new Error('Bank operation principal mismatch');
 await assertEffectivePermission(issued,'write:bank-tx');await assertEffectivePermission(issued,'write:post');
 return issued;
}
function tool(prepare:boolean):McpTool{
 const name=prepare?'prepare_bank_operation':'execute_bank_operation';
 return{name,description:prepare?
  'Save an immutable bank allocation, split, transfer or reversal instruction without posting. Uses the same shared preparation as the bank UI. Return operation to approval_requirements and request_operation_approval; an independent human decides approval. For reversal, use the returned canonical bankTransactionId when executing.':
  'Execute a saved bank instruction with its matching approval. Accepts only saved intent, approval and canonical bank transaction references, never replacement financial fields. Rechecks current authority, policy and source versions, posts once, and records MCP provenance. Human approval cannot be supplied as actor arguments.',
  scope:'write:bank-tx',write:true,requiresPost:true,perUserIdempotency:true,inputSchema:bankPreparedOperationSchema(prepare),
  authorize:async(args,ctx)=>{parse(args,ctx,prepare);await authority(ctx);},
  handler:async(args,ctx)=>{
   // Company assertions are authority failures, distinct from malformed business inputs.
   const descriptor=Object.getOwnPropertyDescriptor(args,'company_id');
   if(descriptor&&'value' in descriptor&&descriptor.value!==undefined&&descriptor.value!==ctx.companyId)throw new Error('Company assertion mismatch');
   let instruction:z.infer<typeof bankControlSchema>;
   try{instruction=parse(args,ctx,prepare);}catch{return toolError('Invalid prepared bank operation arguments');}
   const issued=await authority(ctx);
   return ok(await dispatchBankControlAction(issued,instruction,mcpPostingOpts(ctx,name)));
  },
 };
}
export const bankPreparedOperationTools=[tool(true),tool(false)] as const;

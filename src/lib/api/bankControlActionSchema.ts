import {z} from 'zod';
const id=z.string().uuid().transform(value=>value.toLowerCase());
const amount=z.string().regex(/^(0|[1-9]\d*)(\.\d{1,2})?$/).max(23);
const vat=z.enum(['none','standard','zero_rated','exempt']);
const description=z.string().max(500).optional();
const execution={bankTransactionId:id,intent_id:id,approval_id:id};
export const bankControlSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('prepare_allocate'),bankTransactionId:id,allocationType:z.enum(['account','customer','supplier']).default('account'),
  contraAccountId:id.optional(),entityId:id.optional(),description,vatCode:vat.optional(),vatAccountId:id.optional(),cc1Id:id.optional(),cc2Id:id.optional(),buId:id.optional(),
  autoApply:z.boolean().optional(),applications:z.array(z.object({invoiceId:id,amount}).strict()).max(100).optional()}).strict(),
 z.object({action:z.literal('prepare_split_allocate'),bankTransactionId:id,description,vatAccountId:id.optional(),
  lines:z.array(z.object({contraAccountId:id,amount,description,vatCode:vat.optional(),cc1Id:id.optional(),cc2Id:id.optional(),buId:id.optional()}).strict()).min(1).max(100)}).strict(),
 z.object({action:z.literal('prepare_reverse'),bankTransactionId:id,originalIntentId:id,reversalDate:z.string(),reason:z.string().min(1).max(1000)}).strict(),
 z.object({action:z.literal('allocate'),...execution}).strict(),
 z.object({action:z.literal('split_allocate'),...execution}).strict(),
 z.object({action:z.literal('reverse'),...execution,reversalDate:z.string().optional(),reason:z.string().min(1).max(1000).optional()}).strict(),
]);
export function isBankControlAction(value:unknown):boolean{
 return typeof value==='string'&&['prepare_allocate','prepare_split_allocate','prepare_reverse','allocate','split_allocate','reverse'].includes(value);
}
/** Legacy unattended execution cannot create even an intent on this attended route. */
export function bankControlActionRequired(input:unknown){
 if(!input||typeof input!=='object'||Array.isArray(input))return null;
 const body=input as Record<string,unknown>;
 if(!['allocate','split_allocate','reverse'].includes(String(body.action)))return null;
 if(body.intent_id&&body.approval_id)return null;
 const prepareAction=body.action==='reverse'?'prepare_reverse':body.action==='split_allocate'?'prepare_split_allocate':'prepare_allocate';
 return{code:'ACTION_REQUIRED',prepareAction,nextAction:body.intent_id?'request_operation_approval':prepareAction,
  requiredFields:body.intent_id?['approval_id']:['intent_id','approval_id']};
}

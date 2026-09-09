/** Discovery describes the complete bounded instruction; shared domain schema enforces action-specific fields. */
const id={type:'string',format:'uuid'},text={type:'string',maxLength:500};
const amount={type:'string',maxLength:23,pattern:'^(0|[1-9]\\d*)(\\.\\d{1,2})?$'};
const vat={type:'string',enum:['none','standard','zero_rated','exempt']};
const line={type:'object',additionalProperties:false,required:['contraAccountId','amount'],properties:{contraAccountId:id,amount,description:text,vatCode:vat,cc1Id:id,cc2Id:id,buId:id}};
const application={type:'object',additionalProperties:false,required:['invoiceId','amount'],properties:{invoiceId:id,amount}};
export const bankPreparationActions=['prepare_allocate','prepare_split_allocate','prepare_reverse'] as const;
export const bankExecutionActions=['allocate','split_allocate','reverse'] as const;
export function bankPreparedOperationSchema(prepare:boolean){
 const properties=prepare?{
  allocationType:{type:'string',enum:['account','supplier','customer','transfer']},contraAccountId:id,entityId:id,description:text,
  vatCode:vat,vatAccountId:id,cc1Id:id,cc2Id:id,buId:id,autoApply:{type:'boolean'},
  applications:{type:'array',maxItems:100,items:application},lines:{type:'array',minItems:1,maxItems:100,items:line},
  originalIntentId:id,reversalDate:{type:'string',format:'date'},reason:{type:'string',minLength:1,maxLength:1000},
 }:{intent_id:id,approval_id:id,reversalDate:{type:'string',format:'date'},reason:{type:'string',minLength:1,maxLength:1000}};
 return{type:'object',additionalProperties:false,required:['instruction','idempotency_key'],properties:{
  instruction:{type:'object',additionalProperties:false,required:prepare?['action','bankTransactionId']:['action','bankTransactionId','intent_id','approval_id'],properties:{
   action:{type:'string',enum:prepare?[...bankPreparationActions]:[...bankExecutionActions]},bankTransactionId:id,...properties,
  }},idempotency_key:{type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9_.:-]+$'},
 }};
}

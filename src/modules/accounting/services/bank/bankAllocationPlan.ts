import Decimal from 'decimal.js';
import {z} from 'zod';
import {canonicalMoney} from '../controls/canonical';
const D=Decimal.clone({precision:80});
export function allocationMoney(value:string):string{
 const amount=new D(canonicalMoney(value));
 if(!amount.gt(0)||amount.gte('100000000000000000000')||!amount.mul(100).isInteger())throw new Error('Invalid exact allocation money');
 return amount.toFixed();
}
const money=z.string().transform(allocationMoney),id=z.string().uuid().transform(value=>value.toLowerCase());
const accountLine=z.object({accountId:id,amount:money,vatCode:z.enum(['none','standard','zero_rated','exempt']).default('none'),
 description:z.string().max(1000).optional(),cc1Id:id.optional(),cc2Id:id.optional(),buId:id.optional()}).strict();
const common={version:z.literal(1),bankTransactionId:id,description:z.string().max(1000).optional()};
const application=z.object({invoiceId:id,amount:money}).strict();
const schema=z.discriminatedUnion('kind',[
 z.object({...common,kind:z.literal('account'),lines:z.array(accountLine).length(1)}).strict(),
 z.object({...common,kind:z.literal('split'),lines:z.array(accountLine).min(1).max(100)}).strict(),
 z.object({...common,kind:z.literal('customer'),partyId:id,applications:z.array(application).max(100)}).strict(),
 z.object({...common,kind:z.literal('supplier'),partyId:id,applications:z.array(application).max(100)}).strict(),
]);
export type BankAllocationPlan=z.infer<typeof schema>;
export function parseBankAllocationPlan(input:unknown):BankAllocationPlan{
 const plan=schema.parse(input);
 if('applications' in plan&&new Set(plan.applications.map(a=>a.invoiceId.toLowerCase())).size!==plan.applications.length)throw new Error('Duplicate allocation invoice');
 return plan;
}
export interface ExactBankJournalLine {accountId:string;debit:string;credit:string;description:string;vatType:string|null;cc1Id:string|null;cc2Id:string|null;buId:string|null}
export function buildBankAllocationLines(plan:BankAllocationPlan,source:{bankAccountId:string;signedAmount:string;controlAccountId:string|null;vatAccountId:string|null}):ExactBankJournalLine[]{
 const signed=new D(canonicalMoney(source.signedAmount)),amount=allocationMoney(signed.abs().toFixed()),spent=signed.lt(0);
 const description=plan.description??'Bank allocation',result:ExactBankJournalLine[]=[];
 const add=(accountId:string,value:string,debit:boolean,desc=description,vatType:string|null=null,dims?:{cc1Id?:string;cc2Id?:string;buId?:string})=>result.push({accountId,debit:debit?value:'0',credit:debit?'0':value,description:desc,vatType,cc1Id:dims?.cc1Id??null,cc2Id:dims?.cc2Id??null,buId:dims?.buId??null});
 if('applications' in plan){
  if((plan.kind==='customer'&&spent)||(plan.kind==='supplier'&&!spent))throw new Error('Allocation party direction is invalid');
  if(!source.controlAccountId)throw new Error('Allocation control account unavailable');
  if(plan.applications.reduce((sum,a)=>sum.add(a.amount),new D(0)).gt(amount))throw new Error('Applications exceed bank amount');
  add(source.controlAccountId,amount,spent);
 }else{
  if(!plan.lines.reduce((sum,line)=>sum.add(line.amount),new D(0)).eq(amount))throw new Error('Allocation total differs from bank amount');
  for(const line of plan.lines){
   const gross=new D(line.amount),net=line.vatCode==='standard'?gross.div('1.15').toDecimalPlaces(2,Decimal.ROUND_HALF_UP):gross;
   add(line.accountId,net.toFixed(),spent,line.description??description,line.vatCode==='none'?null:line.vatCode,line);
   const vat=gross.sub(net);
   if(vat.gt(0)){
    if(!source.vatAccountId)throw new Error('Allocation VAT account unavailable');
    add(source.vatAccountId,vat.toFixed(),spent,'VAT @ 15%','standard',line);
   }
  }
 }
 add(source.bankAccountId,amount,!spent);
 return result;
}
/** Shared outstanding comparison; extracted from preparation and child effects. */
export function assertAllocationOutstanding(total:string,paid:string,allocated:string):void{
 if(new D(paid).add(allocated).gt(total))throw new Error('Allocation exceeds invoice outstanding');
}

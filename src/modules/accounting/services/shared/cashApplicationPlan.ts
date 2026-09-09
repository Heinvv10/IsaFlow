import Decimal from 'decimal.js';
import {z} from 'zod';
import {isRealCalendarDate} from '@/lib/validation';
const D=Decimal.clone({precision:80});
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
export function cashApplicationMoney(value:string):string{
 if(!/^\d+(?:\.\d{1,2})?$/.test(value))throw new Error('Cash application requires exact positive cents');
 const amount=new D(value);if(amount.lte(0)||amount.gte('1e20'))throw new Error('Cash application amount outside supported range');
 return amount.toFixed(2);
}
const amount=z.string().transform(cashApplicationMoney);
const schema=z.object({version:z.literal(1),kind:z.enum(['customer','supplier']),paymentId:uuid,
 accountingDate:z.string().refine(isRealCalendarDate),applications:z.array(z.object({invoiceId:uuid,amount}).strict()).min(1).max(100)}).strict()
 .refine(plan=>new Set(plan.applications.map(a=>a.invoiceId)).size===plan.applications.length,'Duplicate application target');
export type CashApplicationPlan=z.infer<typeof schema>;
export function cashApplicationTotal(plan:CashApplicationPlan):string{
 return cashApplicationMoney(plan.applications.reduce((sum,a)=>sum.add(a.amount),new D(0)).toFixed(2));
}
export function parseCashApplicationPlan(input:unknown):CashApplicationPlan{
 const plan=schema.parse(input);cashApplicationTotal(plan);return plan;
}
const reversalSchema=z.object({originalIntentId:uuid,reversalDate:z.string().refine(isRealCalendarDate),reason:z.string().trim().min(1).max(1000)}).strict();
export function parseCashApplicationReversalPlan(input:unknown){return reversalSchema.parse(input);}

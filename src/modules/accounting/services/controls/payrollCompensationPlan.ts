import {z} from 'zod';
import Decimal from 'decimal.js';
import {canonicalJson} from './canonical';
import {isRealCalendarDate} from '@/lib/validation';
const D=Decimal.clone({precision:80});
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealCalendarDate,'Invalid compensation date');
export function compensationMoney(value:string):string{
 if(!/^\d+(?:\.\d{1,2})?$/.test(value))throw new Error('Compensation requires nonnegative exact decimal cents');
 const result=new D(value);if(result.gte('1e12'))throw new Error('Compensation exceeds assignment storage bound');return result.toFixed(2);
}
const money=z.string().transform(compensationMoney);
function monthEnd(value:string){const [year,month]=value.split('-').map(Number);return new Date(Date.UTC(year!,month!,0)).toISOString().slice(0,10);}
const dates={effectiveFrom:date,effectiveTo:date.nullable().optional(),isRecurring:z.boolean().default(true)};
const assignment=z.object({kind:z.literal('assign'),employeeId:uuid,componentId:uuid,amount:money,...dates}).strict()
 .transform(value=>({...value,effectiveTo:value.effectiveTo??(value.isRecurring?null:monthEnd(value.effectiveFrom))}))
 .refine(value=>value.effectiveTo===null||value.effectiveTo>=value.effectiveFrom,'Inverted compensation effective dates');
const end=z.object({kind:z.literal('end'),assignmentId:uuid,effectiveTo:date}).strict();
const amend=z.object({kind:z.literal('amend'),assignmentId:uuid,amount:money}).strict();
const source=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('manual')}).strict(),
 z.object({kind:z.literal('package'),sourceId:uuid,employeeId:uuid}).strict(),
 z.object({kind:z.literal('batch'),sourceId:uuid}).strict(),
]);
const manual=z.object({version:z.literal(1),source:z.object({kind:z.literal('manual')}).strict(),actions:z.array(z.union([assignment,end,amend])).min(1).max(1000)}).strict()
 .refine(value=>{const ids=value.actions.flatMap(action=>'assignmentId' in action?[action.assignmentId]:[]);return new Set(ids).size===ids.length;},'Duplicate compensation assignment target');
const input=z.union([manual,z.object({version:z.literal(1),source:z.object({kind:z.literal('package'),sourceId:uuid,employeeId:uuid}).strict(),effectiveFrom:date}).strict(),
 z.object({version:z.literal(1),source:z.object({kind:z.literal('batch'),sourceId:uuid}).strict()}).strict()]);
const action=z.object({kind:z.enum(['assign','end','amend']),assignmentId:uuid,employeeId:uuid,componentId:uuid,amount:money,
 effectiveFrom:date,effectiveTo:date.nullable(),isRecurring:z.boolean()}).strict()
 .refine(value=>value.effectiveTo===null||value.effectiveTo>=value.effectiveFrom,'Inverted compensation effective dates');
const payload=z.object({version:z.literal(1),source,actions:z.array(action).min(1).max(1000)}).strict()
 .refine(value=>new Set(value.actions.map(a=>a.assignmentId)).size===value.actions.length,'Duplicate compensation assignment target');
export type PayrollCompensationInput=z.infer<typeof input>;
export type PayrollCompensationPayload=z.infer<typeof payload>;
export type PayrollCompensationAction=PayrollCompensationPayload['actions'][number];
/** Validate descriptors before any Zod/property traversal and sever all caller references. */
export function parsePayrollCompensationInput(value:unknown):PayrollCompensationInput{return input.parse(JSON.parse(canonicalJson(value)));}
export function parsePayrollCompensationPayload(value:unknown):PayrollCompensationPayload{
 const parsed=payload.parse(JSON.parse(canonicalJson(value)));
 return{...parsed,actions:parsed.actions.sort((a,b)=>a.assignmentId<b.assignmentId?-1:a.assignmentId>b.assignmentId?1:0)};
}
/** Endings retain old exposure; reductions and replacements never hide it through signed netting. */
export function compensationExposure(changes:readonly {before:string|null;after:string}[]):string{
 return changes.reduce((sum,row)=>sum.add(D.max(compensationMoney(row.before??'0'),compensationMoney(row.after))),new D(0)).toFixed(2);
}

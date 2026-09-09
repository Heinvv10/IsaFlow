import {z} from 'zod';
import {canonicalJson} from './canonical';
import {requireControlTx} from './context';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {parsePayrollCompensationInput,parsePayrollCompensationPayload} from './payrollCompensationPlan';
import {compensationAssertionInput,loadPayrollCompensationIntent} from './payrollCompensationMaterial';
import {executePayrollCompensation} from './payrollCompensationControl';
export interface CompensationExecutionOptions{intentId?:string;approvalId?:string}
export function assertCompensationCallerPlan(input:unknown,payload:unknown){
 const actual=parsePayrollCompensationInput(input),expected=parsePayrollCompensationInput(compensationAssertionInput(parsePayrollCompensationPayload(payload)));
 const normalized=(value:typeof actual)=>'actions' in value?{...value,actions:value.actions.map(action=>canonicalJson(action)).sort()}:value;
 if(canonicalJson(normalized(actual))!==canonicalJson(normalized(expected)))throw new Error('Compensation caller assertion does not match approved intent');
}
export async function executeCompensationCaller(companyId:string,input:unknown,options:CompensationExecutionOptions={},userId?:string){
 const ctx=requireControlTx(),assertion=parsePayrollCompensationInput(input);
 const saved=z.object({intentId:z.string().uuid().optional(),approvalId:z.string().uuid().optional()}).strict().parse(JSON.parse(canonicalJson(options)));
 if(ctx.principal.companyId!==companyId||(userId!==undefined&&ctx.principal.personId!==userId))throw new Error('Compensation caller identity does not match current context');
 await assertEffectivePermission(ctx,'write:payroll');
 if(!saved.intentId)throw new Error('Immutable compensation intent and independent approval required');
 const material=await loadPayrollCompensationIntent(ctx,saved.intentId);assertCompensationCallerPlan(assertion,material.plan);
 return executePayrollCompensation(ctx,saved.intentId,saved.approvalId?{approvalId:saved.approvalId}:{});
}

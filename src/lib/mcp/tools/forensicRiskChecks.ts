import {z} from 'zod';
import type {McpTool} from '../types';
import {isRealCalendarDate} from '@/lib/validation';
import {requireControlTx} from '@/modules/accounting/services/controls/context';
import type {ControlTx,ControlCheckResult} from '@/modules/accounting/services/controls/contracts';
import {checkDuplicateInvoices} from '@/modules/accounting/services/controls/duplicateInvoiceChecks';
import {checkPaymentRisks} from '@/modules/accounting/services/controls/paymentRiskChecks';
import type {RiskCheckOptions} from '@/modules/accounting/services/controls/invoiceRiskQueriesResult';
import {ok,toolError} from './toolHelpers';
const options=z.object({limit:z.number().int().min(1).max(100).optional(),cursor:z.string().max(1024).optional(),
 cutoff:z.string().refine(isRealCalendarDate).optional()}).strict();
export function riskTool(name:string,description:string,check:(ctx:ControlTx,input:RiskCheckOptions)=>Promise<ControlCheckResult>):McpTool {
 return{name,description,scope:'read:reports',write:false,inputSchema:{type:'object',additionalProperties:false,properties:{
  limit:{type:'integer',minimum:1,maximum:100,description:'Finding page size; totals cover the complete supported population. Default 20.'},
  cursor:{type:'string',maxLength:1024,description:'Cursor from this check. Restart if source facts change.'},
  cutoff:{type:'string',format:'date',description:'Inclusive accounting date cutoff, YYYY-MM-DD. Current source values are observed.'},
 }},handler:async args=>{
  const parsed=options.safeParse(args);if(!parsed.success)return toolError('Invalid control check options');
  return ok(await check(requireControlTx(),parsed.data));
 }};
}
export const duplicateInvoiceChecksTool=riskTool('duplicate_invoice_checks',
 'Checks supplier invoices for exact supplier/date/amount similarities and verified source-byte reuse, including imported native invoices. '
 +'Requires current report and invoice read permissions. Returns candidate or confirmed observations with complete counts, totals, coverage and missing sources. '
 +'Unmapped imports or populations above 10000 remain unknown. Reads create no findings or exceptions in storage.',checkDuplicateInvoices);
export const paymentRiskChecksTool=riskTool('payment_risk_checks',
 'Checks supplier payment allocations, repeated release preparations, shared verified beneficiary accounts and changes within 48 hours of payment activity. '
 +'Requires current report, invoice and bank-transaction read permissions. Private account comparison also requires current bank-transaction write authority; otherwise that coverage is unknown. '
 +'Returns bounded findings, complete signal totals and missing evidence. Signals may have legitimate explanations and do not prove external settlement or fraud.',checkPaymentRisks);

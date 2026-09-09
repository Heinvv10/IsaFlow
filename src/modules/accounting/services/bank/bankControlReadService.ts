import {z} from 'zod';
import {resolveEffectivePermissions,EffectivePermissionError} from '@/lib/auth/effectivePermissions';
import {isRealCalendarDate} from '@/lib/validation';
import {assertControlTx} from '../controls/context';
import type {ControlTx,OperationRef} from '../controls/contracts';
import type {ApprovalSummary} from '../controls/approvalQueries';
import {parseBankAllocationPlan,type BankAllocationPlan} from './bankAllocationPlan';
import {readBankPreparedRows,resolveBankApprovalTarget} from './bankControlReadQueries';
import {readBankCurrentOriginal,type BankControlRow} from './bankControlReadProvenance';
const id=z.string().uuid().transform(s=>s.toLowerCase());
const inputSchema=z.object({bankTransactionId:id.optional(),intentId:id.optional(),approvalId:id.optional()}).strict()
 .refine(value=>!(value.intentId&&value.approvalId)&&(value.approvalId||value.bankTransactionId));
const reversalSchema=z.object({originalIntentId:z.string().uuid(),bankTransactionId:z.string().uuid(),reversalDate:z.string().refine(isRealCalendarDate),reason:z.string().min(1).max(1000)}).strict();
export interface BankPreparedOperation {
 intentId:string;operation:OperationRef;createdAt:string;accountingDate:string;amount:string;currency:string;
 plan:BankAllocationPlan|z.infer<typeof reversalSchema>;executed:boolean;requesterIsCurrentPerson:boolean;approval:ApprovalSummary|null;approvalVisibility:'visible'|'denied';
}
type Row={id:string;requester_person_id:string;entity_type:string;operation:OperationRef['operation'];created_at:Date|string;accounting_date:string;amount:string;currency:string;plan:unknown;executed:boolean;total:number;approval:ApprovalSummary|null};
export async function readBankControlState(ctx:ControlTx,input:unknown){
 assertControlTx(ctx);const query=inputSchema.parse(input),rights=await resolveEffectivePermissions(ctx);
 if(!rights.permissions.includes('read:bank-tx'))throw new EffectivePermissionError();
 if(query.approvalId&&!rights.permissions.includes('read:approvals'))throw new EffectivePermissionError();
 const bankId=query.approvalId?await resolveBankApprovalTarget(ctx,query.approvalId,query.bankTransactionId):query.bankTransactionId!;
 const [bank]=await ctx.sql`SELECT id,status,amount::text,transaction_date,bank_account_id,matched_journal_line_id FROM bank_transactions
  WHERE company_id=${ctx.principal.companyId}::uuid AND id=${bankId}::uuid FOR SHARE` as BankControlRow[];
 if(!bank)throw new Error('Bank transaction not found');
 const original=await readBankCurrentOriginal(ctx,bank),visible=rights.permissions.includes('read:approvals');
 const map=(row:Row):BankPreparedOperation=>{
  const plan=row.entity_type==='bank_allocation_intent'?parseBankAllocationPlan(row.plan):reversalSchema.parse(row.plan);
  if(plan.bankTransactionId!==bank.id)throw new Error('Prepared bank intent is inconsistent');
  return{intentId:row.id,operation:{entityType:row.entity_type,entityId:row.id,operation:row.operation},createdAt:row.created_at instanceof Date?row.created_at.toISOString():row.created_at,
   accountingDate:row.accounting_date,amount:row.amount,currency:row.currency,plan,executed:row.executed,requesterIsCurrentPerson:row.requester_person_id===ctx.principal.personId,approval:visible?row.approval:null,approvalVisibility:visible?'visible':'denied'};
 };
 const rows=await readBankPreparedRows(ctx,bank.id,visible,null) as Row[];
 const selectedRows=query.intentId||query.approvalId?await readBankPreparedRows(ctx,bank.id,visible,query.intentId??null,query.approvalId??null) as Row[]:[];
 if((query.intentId||query.approvalId)&&selectedRows.length!==1)throw new Error('Prepared bank intent not found');
 const items=rows.map(map),total=rows[0]?.total??0;
 return{bankTransactionId:bank.id,...original,prepared:{items,total,hasMore:total>items.length},selected:selectedRows[0]?map(selectedRows[0]):null};
}

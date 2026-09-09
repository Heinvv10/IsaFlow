import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from '../controls/context';
import type {ControlTx} from '../controls/contracts';
import {loadPreparedPayment} from './paymentPreparationService';
import {validateReleasePopulation} from './paymentReleaseValidation';
export interface BatchSourceRow extends Record<string,unknown>{id:string;batch_date:string;total_amount:string;payment_count:number;status:string;bank_account_id:string|null;batch_number:string}
export async function loadPreparedBatch(ctx:ControlTx,batchId:string){
 assertControlTx(ctx);await assertEffectivePermission(ctx,'write:bank-tx');
 const [batch]=await ctx.sql`SELECT *,batch_date::text,total_amount::text FROM supplier_payment_batches
  WHERE company_id=${ctx.principal.companyId}::uuid AND id=${batchId}::uuid FOR UPDATE` as BatchSourceRow[];
 if(!batch)throw new Error('Batch not found');
 const rows=await ctx.sql`SELECT sp.id,p.id AS preparation_id FROM supplier_payments sp
  LEFT JOIN LATERAL (SELECT p.id FROM control_payment_preparations p WHERE p.company_id=sp.company_id AND p.payment_id=sp.id
   ORDER BY p.created_at DESC,p.id DESC LIMIT 1) p ON true
  WHERE sp.company_id=${ctx.principal.companyId}::uuid AND sp.batch_id=${batchId}::uuid ORDER BY sp.id LIMIT 101` as Array<{id:string;preparation_id:string|null}>;
 if(!rows.length||rows.length>100||rows.some(row=>!row.preparation_id))throw new Error('Batch requires explicit current payment preparation');
 const payments=[];
 for(const row of rows)payments.push(await loadPreparedPayment(ctx,row.id,row.preparation_id!));
 const money=validateReleasePopulation(payments.map(p=>({id:p.payment.id,supplierId:p.payment.supplier_id,amount:p.amount,currency:p.currency})),batch.total_amount,Number(batch.payment_count));
 if(payments.some(p=>p.payment.payment_date!==batch.batch_date||p.payment.bank_account_id!==batch.bank_account_id))throw new Error('Batch source account/date does not match payments');
 return{batch,payments,...money};
}
export async function loadBatchBankAccount(ctx:ControlTx,bankAccountId:string|null){
 if(!bankAccountId)throw new Error('Batch requires an explicit owned bank account');
 const [bank]=await ctx.sql`SELECT id,account_code,account_type,account_subtype,bank_account_number,bank_branch_code,bank_account_type,is_active
  FROM gl_accounts WHERE company_id=${ctx.principal.companyId}::uuid AND id=${bankAccountId}::uuid FOR SHARE` as Array<{
   id:string;account_code:string;account_type:string;account_subtype:string;bank_account_number:string|null;bank_branch_code:string|null;bank_account_type:string;is_active:boolean}>;
 if(!bank||!bank.is_active||bank.account_type!=='asset'||bank.account_subtype!=='bank')throw new Error('Owned active bank account required');
 return bank;
}

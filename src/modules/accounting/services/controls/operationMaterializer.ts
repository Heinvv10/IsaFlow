import {materializeBankAllocationOperation} from '../bank/bankAllocationMaterial';
import {materializeInvoiceMatchOverride} from '../ap/invoiceMatchOverrideMaterial';
import {materializeBankTransferOperation} from './bankTransferOperationMaterializer';
import {materializeAssetDepreciationOperation} from './assetDepreciationOperationMaterializer';
import {materializeArOperation} from './arOperationMaterializer';
import { materializePayrollOperation } from './payrollOperationMaterializer';
import { materializePaymentBatchOperation } from '../ap/paymentBatchMaterializer';
import { materializePaymentReleaseOperation } from '../ap/paymentReleaseMaterializer';
import { materializePeriodOperation } from './periodOperationMaterializer';
import { isRealCalendarDate } from '@/lib/validation';
import { materializeGlOperation } from './glOperationMaterializer';
import { operationRuleType } from './operationPermissions';
import { canonicalJson, operationBindingHash } from './canonical';
import { assertControlTx } from './context';
import { materializeApOperation, type ApMaterial } from './apOperationMaterializer';
import { loadApprovalRules, type ApprovalRuleRow } from './approvalRuleService';
import { matchOperationPolicies } from './aggregateOperationPolicy';
import { supplierExposureBuckets } from './supplierExposureBuckets';
import type { ControlTx, OperationBinding, OperationRef } from './contracts';

export function canonicalOperationRef(ref: OperationRef): OperationRef {
  canonicalJson(ref);
  const dates=ref.entityId.split('/');
  const validId=ref.entityType==='fiscal_year' ? /^[1-9][0-9]{3}$/.test(ref.entityId)
    : ref.entityType==='vat_period' ? dates.length===2 && dates.every(isRealCalendarDate) && dates[0]!<=dates[1]!
      : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref.entityId);
  if(!validId)throw new Error('Invalid operation reference');
  const operations = ref.entityType==='invoice_match_override_intent'?['invoice_match.override']:ref.entityType === 'supplier_invoice'
    ? ['supplier_invoice.approve', 'supplier_invoice.post', 'supplier_invoice.cancel']
    : ref.entityType === 'bank_allocation_reversal_intent' ? ['bank_allocation.reverse']
    : ref.entityType === 'bank_allocation_intent' ? ['bank_allocation.post']
    : ref.entityType === 'bank_transfer_intent' ? ['bank_transfer.post']
    : ref.entityType === 'asset_depreciation_intent' ? ['asset_depreciation.post']
    : ref.entityType === 'customer_invoice' ? ['customer_invoice.post','customer_invoice.cancel']
    : ref.entityType === 'customer_payment' ? ['customer_payment.confirm','customer_payment.cancel']
    : ref.entityType === 'credit_note' ? ['credit_note.approve','credit_note.cancel']
    : ref.entityType === 'credit_note_application' ? ['credit_note_application.apply']
    : ref.entityType === 'recurring_invoice_run' ? ['recurring_invoice.generate']
    : ref.entityType === 'supplier_payment_batch' ? ['supplier_payment_batch.process']
    : ref.entityType === 'payment_release_intent' ? ['payment_release.dispatch']
    : ref.entityType === 'supplier_payment' ? ['supplier_payment.process', 'supplier_payment.void']
      : ref.entityType === 'journal_entry' ? ['journal.post','journal.reverse']
        : ref.entityType === 'payroll_run' ? ['payroll_run.post','payroll_run.reopen']
          : ref.entityType === 'fiscal_period' ? ['fiscal_period.close','fiscal_period.lock','fiscal_period.reopen']
            : ref.entityType === 'fiscal_year' ? ['year.close','year.periods_close']
              : ref.entityType === 'vat_period' ? ['vat_period.lock']
                : ref.entityType === 'company_lockdown_intent' ? ['company_lockdown.change'] : [];
  if (!operations.includes(ref.operation)) throw new Error('Unsupported controlled operation');
  const reverses = ['journal.reverse','supplier_payment.void','supplier_invoice.cancel','payroll_run.reopen','customer_invoice.cancel','customer_payment.cancel','credit_note.cancel'].includes(ref.operation);
  const reversalDate = ref.reversalDate ?? (reverses && 'accountingDate' in ref ? ref.accountingDate : undefined);
  if (reversalDate !== undefined && (!reverses || typeof reversalDate !== 'string' || !isRealCalendarDate(reversalDate))) throw new Error('Invalid reversal date');
  return { entityType: ref.entityType, entityId: ref.entityId,
    ...(ref.expectedVersion === undefined ? {} : { expectedVersion: ref.expectedVersion }),
    ...(reversalDate === undefined ? {} : { reversalDate }),
    operation: ref.operation === 'supplier_invoice.approve' ? 'supplier_invoice.post' : ref.operation };
}
export interface OperationMaterial extends ApMaterial {
  binding: OperationBinding; bindingHash: string; rules: ApprovalRuleRow[]; windowStart: string;
}

/** No writes/reservations: inspection is a current observation, not historical proof. */
export async function loadOperationMaterial(ctx: ControlTx, input: OperationRef): Promise<OperationMaterial> {
  assertControlTx(ctx);
  const ref = canonicalOperationRef(input);
  // Root627 policy mutations take the same tenant lock, including INSERT phantoms.
  await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${ctx.principal.companyId}`},0))`;
  const rules = await loadApprovalRules(ctx, operationRuleType(ref.operation));
  const material = await materializeOperation(ctx, ref);
  const [clock] = await ctx.sql`SELECT (clock_timestamp() AT TIME ZONE 'Africa/Johannesburg')::date::text AS day` as Array<{ day: string }>;
  if (!clock) throw new Error('Execution clock unavailable');
  const binding = { ...material.binding, policies: await matchOperationPolicies(ctx, rules, material, clock.day) };
  return { ...material, binding, bindingHash: operationBindingHash(binding), rules, windowStart: clock.day };
}

export async function reserveOperationExposure(ctx: ControlTx, material: OperationMaterial,
  approvalId: string | null, state: 'reserved' | 'committed'): Promise<void> {
  assertControlTx(ctx);
  for (const rule of material.rules.filter(row => row.aggregate_window_days !== null)) {
    for (const bucket of supplierExposureBuckets(material)) {
    await ctx.sql`
      INSERT INTO control_policy_exposure(company_id,policy_id,beneficiary_key,currency,window_start,
        operation,entity_id,amount,state,approval_id)
      VALUES(${ctx.principal.companyId}::uuid,${rule.id},${bucket.beneficiaryKey},${bucket.currency},
        ${material.windowStart}::date,${material.binding.operation},${material.binding.entityId},${bucket.amount}::numeric,
        ${state},${approvalId}::uuid)
      ON CONFLICT(company_id,policy_id,operation,entity_id,beneficiary_key,currency) DO UPDATE SET
        beneficiary_key=EXCLUDED.beneficiary_key,currency=EXCLUDED.currency,window_start=EXCLUDED.window_start,
        amount=EXCLUDED.amount,state=EXCLUDED.state,approval_id=EXCLUDED.approval_id
      WHERE control_policy_exposure.state<>'committed'
    `;
    }
  }
}

/** Authoritative source material is shared by approval, execution and after-effect evidence. */
export async function materializeOperation(ctx:ControlTx,ref:OperationRef):Promise<ApMaterial>{
  if(['bank_allocation_intent','bank_allocation_reversal_intent'].includes(ref.entityType))return materializeBankAllocationOperation(ctx,ref);
  if(ref.entityType==='invoice_match_override_intent')return materializeInvoiceMatchOverride(ctx,ref);
  if(ref.entityType==='bank_transfer_intent')return materializeBankTransferOperation(ctx,ref);
  if(ref.entityType==='asset_depreciation_intent')return materializeAssetDepreciationOperation(ctx,ref);
  if(['customer_invoice','customer_payment','credit_note','credit_note_application','recurring_invoice_run'].includes(ref.entityType))return materializeArOperation(ctx,ref);
  if(ref.entityType==='supplier_payment_batch')return materializePaymentBatchOperation(ctx,ref);
  if(ref.entityType==='payment_release_intent')return materializePaymentReleaseOperation(ctx,ref);
  if(ref.entityType==='payroll_run')return materializePayrollOperation(ctx,ref);
  if(['fiscal_period','fiscal_year','vat_period','company_lockdown_intent'].includes(ref.entityType))return materializePeriodOperation(ctx,ref);
  return ref.entityType==='journal_entry' ? materializeGlOperation(ctx,ref) : materializeApOperation(ctx,ref);
}

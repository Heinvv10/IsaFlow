import { requireControlTx } from '../controls/context';
import { assertControlledEffectPermit, type ControlledEffectPermit } from '../controls/approvalExecutionService';
import { recordCommittedChange } from '../controls/changeEventService';
import { readControlEntityVersion } from '../controls/operationVersions';

/** Amounts and target invoices are read from the locked, owned payment allocations. */
export async function applyControlledSupplierSettlement(paymentId: string, accountingDate: string,
  permit: ControlledEffectPermit): Promise<void> {
  const ctx = requireControlTx(), companyId = ctx.principal.companyId;
  if (!['supplier_payment.process', 'supplier_payment.void'].includes(permit.operation)) throw new Error('Invalid settlement parent');
  assertControlledEffectPermit(ctx, permit, { operation: permit.operation, entityType: 'supplier_payment', entityId: paymentId });
  const allocations = await ctx.sql`
    SELECT pa.invoice_id,pa.amount_allocated::text FROM payment_allocations pa
    JOIN supplier_payments sp ON sp.id=pa.payment_id
    JOIN supplier_invoices si ON si.id=pa.invoice_id AND si.company_id=sp.company_id AND si.supplier_id=sp.supplier_id
    WHERE sp.company_id=${companyId}::uuid AND sp.id=${paymentId}::uuid ORDER BY si.id FOR UPDATE OF si
  ` as Array<{ invoice_id: string; amount_allocated: string }>;
  for (const allocation of allocations) {
    const [before] = await ctx.sql`SELECT * FROM supplier_invoices WHERE company_id=${companyId}::uuid AND id=${allocation.invoice_id}::uuid` as Record<string, unknown>[];
    if (!before) throw new Error('Settlement invoice disappeared');
    const version = await readControlEntityVersion(ctx, { entityType: 'supplier_invoice', entityId: allocation.invoice_id });
    let currentVersion = version?.version ?? 0;
    if (!version) {
      const observed = await recordCommittedChange(ctx, { entityType: 'supplier_invoice', entityId: allocation.invoice_id,
        previousVersion: null, newVersion: 1, action: 'baseline_observed', accountingDate, before: null, after: before,
        bindingHash: null, protectedEvidenceRef: null, operationId: permit.operationId });
      currentVersion = observed.newVersion;
    }
    const delta = permit.operation === 'supplier_payment.void' ? `-${allocation.amount_allocated}` : allocation.amount_allocated;
    const paidThreshold = permit.operation === 'supplier_payment.void' ? '0.01' : '0';
    const [after] = await ctx.sql`
      UPDATE supplier_invoices SET amount_paid=GREATEST(amount_paid+${delta}::numeric,0),
        status=CASE WHEN total_amount-GREATEST(amount_paid+${delta}::numeric,0)<=0.01 THEN 'paid'
          WHEN GREATEST(amount_paid+${delta}::numeric,0)>${paidThreshold}::numeric THEN 'partially_paid' ELSE 'approved' END
      WHERE company_id=${companyId}::uuid AND id=${allocation.invoice_id}::uuid RETURNING *
    ` as Record<string, unknown>[];
    if (!after) throw new Error('Settlement invoice changed concurrently');
    await recordCommittedChange(ctx, { entityType: 'supplier_invoice', entityId: allocation.invoice_id,
      previousVersion: currentVersion, newVersion: currentVersion + 1,
      action: permit.operation === 'supplier_payment.void' ? 'payment_unapplied' : 'payment_applied',
      accountingDate, before, after, bindingHash: null, protectedEvidenceRef: null, operationId: permit.operationId });
  }
}

import { als } from '@/lib/als';
import { assertEffectivePermission } from '@/lib/auth/effectivePermissions';
import { requireControlTx } from './context';
import { executeControlledOperation, type ControlledEffectPermit } from './approvalExecutionService';
import type { ControlTx, OperationRef } from './contracts';
export interface PeriodControlOptions { approvalId?: string }
export function requirePeriodControl(companyId: string, userId?: string): ControlTx {
  const ctx = requireControlTx();
  if (ctx.principal.companyId !== companyId || (userId !== undefined && ctx.principal.personId !== userId)) throw new Error('Period control transaction actor mismatch');
  return ctx;
}
/** The authority every period control asserts, callable by a preview that skips only the write. */
export async function assertPeriodControlAuthority(companyId: string, userId?: string): Promise<void> {
  await assertEffectivePermission(requirePeriodControl(companyId, userId), 'write:locks');
}
export async function runPeriodControl<T>(companyId: string, ref: OperationRef, options: PeriodControlOptions | undefined,
  effect: (ctx: ControlTx, permit: ControlledEffectPermit) => Promise<T>, userId?: string): Promise<T> {
  try {
    const ctx = requirePeriodControl(companyId, userId);
    await assertEffectivePermission(ctx, 'write:locks');
    if (ref.entityType === 'vat_period') await assertEffectivePermission(ctx, 'read:vat');
    return await executeControlledOperation(ctx, ref, options?.approvalId ?? null,
      async permit => JSON.parse(JSON.stringify(await effect(ctx, permit))) as T);
  } catch (error) {
    const store = als.getStore(); if (store) store.controlWriteFailed = true;
    throw error;
  }
}

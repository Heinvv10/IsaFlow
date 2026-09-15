import type { ControlTx, OperationRef } from './contracts';

/**
 * What an unattended gateway principal is allowed to do, and it is one thing.
 *
 * The principal exists so a settled card payment can be banked without a human
 * (see `withControlGatewayReceiptRequest`). That justification covers
 * confirming the receipt and nothing else: cancelling one, posting a journal,
 * paying a supplier and every other controlled operation all have a person who
 * can be asked. Independent of the permission ceiling on purpose — a widened
 * ceiling must still not let this authority into another operation kernel,
 * which is the same defence `assertPlatformImportOperation` provides.
 */
export function assertGatewayReceiptOperation(ctx: ControlTx, ref: OperationRef): void {
  if (ctx.principal.authMethod !== 'gateway') return;
  if (ref.entityType !== 'customer_payment' || ref.operation !== 'customer_payment.confirm') {
    throw new Error('Gateway authority is restricted to confirming a customer payment receipt');
  }
}

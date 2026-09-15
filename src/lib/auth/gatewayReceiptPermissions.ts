import type { ControlTx } from '@/modules/accounting/services/controls/contracts';
import { EFFECTIVE_PERMISSION_RULES, type PermissionReason } from './effectivePermissionPolicy';
import { EffectivePermissionError } from './effectivePermissionQueries';

/**
 * Exactly what banking one settled card receipt asks for: the write the
 * operation is mapped to, and the posting right its journal needs. There is no
 * membership to read — the gateway principal is not a person and has no role —
 * so this ceiling IS the authority, and everything outside it is denied rather
 * than left to a role lookup that would find nothing.
 */
const GATEWAY_RECEIPT_PERMISSIONS: readonly string[] = Object.freeze(['write:bank-tx', 'write:post']);

export function gatewayReceiptPermissions(ctx: ControlTx) {
  const denied: Record<string, PermissionReason> = {};
  for (const permission of Object.keys(EFFECTIVE_PERMISSION_RULES)) {
    if (!GATEWAY_RECEIPT_PERMISSIONS.includes(permission)) denied[permission] = 'ROLE_CEILING';
  }
  return { companyId: ctx.principal.companyId, personId: ctx.principal.personId,
    role: 'gateway', permissions: [...GATEWAY_RECEIPT_PERMISSIONS], denied };
}

export function assertGatewayReceiptPermission(permission: string): void {
  if (!GATEWAY_RECEIPT_PERMISSIONS.includes(permission)) {
    throw new EffectivePermissionError(permission, 'ROLE_CEILING');
  }
}

/**
 * An employee's address changed (wave 6 SS, review #1570 M2b): their portal login, invited or active, belonged to the
 * old address, so it ends. The pending invitation's token stops working, the login is revoked and session_version is
 * bumped, so every session signed in with it ends at its next request. The employer invites the new address.
 *
 * Called by PE's setEmployeeEmail after it changes the address. The write runs on migration_admin (no app role writes
 * employee_portal_access, 999u) with its audit row in the same transaction. It commits on its own, before the
 * request's: if the request then fails, the address stays as it was and the login is ended anyway, the safe side.
 */
import { buildQuery, type TxSql } from '@/lib/neon';
import { migrationAdminTx } from '@/lib/auth/migrationAdminPool';
import type pg from 'pg';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import type { EmployeeEmailActor } from './payrollEmployeeEmail';

/** A tagged-template TxSql on a migration_admin client, so an audit row joins that client's transaction. */
export function clientTx(client: pg.PoolClient): TxSql {
  return async (strings, ...values) => {
    const { text, values: params } = buildQuery(strings, values);
    return (await client.query(text, params)).rows as unknown[];
  };
}

export async function endPortalAccessForAddressChange(companyId: string, employeeId: string, actor: EmployeeEmailActor): Promise<void> {
  await migrationAdminTx('employee portal address change', async (client) => {
    const ended = (await client.query(
      `UPDATE employee_portal_access
          SET status = 'revoked', revoked_at = now(), revoked_by = $3, password_hash = NULL, invite_token_hash = NULL,
              invite_expires_at = NULL, session_version = session_version + 1, updated_at = now()
        WHERE company_id = $1::uuid AND employee_id = $2::uuid AND status <> 'revoked'
        RETURNING id`,
      [companyId, employeeId, actor.userId],
    )).rows as Array<{ id: string }>;
    if (!ended[0]) return;
    await logAuditOrThrow({
      companyId, userId: actor.userId, userEmail: actor.userEmail, action: 'delete', entityType: 'employee_portal_access',
      entityId: ended[0].id,
      changes: { fields: [{ field: 'status', old: 'invited/active', new: 'revoked', label: 'Portal access (address changed)' }] },
      ip: actor.ip, userAgent: actor.userAgent, sessionId: actor.sessionId ?? undefined,
    }, clientTx(client));
  });
}

/**
 * The audit row for a Default Accounts save: who moved which row from which account to which, with the account ids
 * AND codes. Written on the save's own transaction with `logAuditOrThrow`, so a save whose audit row cannot be
 * written is rolled back (an unrecorded change of where net pay or a control account points is worse than a failed
 * save), and the record commits with the change it describes.
 * One row per save: `entity_id` is the company (the settings view has no row id of its own).
 */
import type { TxSql } from '@/lib/neon';
import { logAuditOrThrow } from '../core/auditTrailService';

/** One row of the page that this save changed: its UI key, and the account id before and after (null = none). */
export interface DefaultAccountChange {
  key: string;
  fromId: string | null;
  toId: string | null;
}

/** "2170 Net Salaries Payable (uuid)", or just the id when the account is gone, or null for none. */
function describeAccount(id: string | null, byId: Map<string, { code: string; name: string }>): string | null {
  if (id === null) return null;
  const account = byId.get(id);
  return account ? `${account.code} ${account.name} (${id})` : `(${id})`;
}

export async function auditDefaultAccountChanges(
  tx: TxSql, companyId: string, userId: string, changes: readonly DefaultAccountChange[],
): Promise<void> {
  if (changes.length === 0) return;
  const ids = [...new Set(changes.flatMap((c) => [c.fromId, c.toId]).filter((id): id is string => id !== null))];
  const rows = (await tx`
    SELECT id::TEXT AS id, account_code, account_name FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND id::TEXT = ANY(${ids}::TEXT[])
  `) as Array<{ id: string; account_code: string; account_name: string }>;
  const byId = new Map(rows.map((r) => [r.id, { code: r.account_code, name: r.account_name }]));
  await logAuditOrThrow({
    companyId, userId, action: 'update', entityType: 'default_accounts', entityId: companyId, entityRef: 'Default accounts',
    changes: {
      fields: changes.map((c) => ({
        field: c.key, label: `Default account: ${c.key}`, old: describeAccount(c.fromId, byId), new: describeAccount(c.toId, byId),
      })),
      metadata: { area: 'default_accounts' },
    },
  }, tx);
}

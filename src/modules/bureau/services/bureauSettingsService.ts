/**
 * Bureau settings — the merchant-pattern sharing opt-in (bureaus.share_merchant_patterns, migration 904)
 * and its audit trail (bureau_audit_log).
 *
 * Runs on the RLS-bypassing pool like every bureau service (no company context; bureau_audit_log is
 * deny-all to app_user by design, see 904's header). Authority:
 *   - read: any bureau member (the route checks bureau_users first);
 *   - change: the bureau OWNER only — bureau_users.role = 'owner', re-checked INSIDE the write transaction
 *     with the bureau row locked, so a role removed between the route's check and the write cannot slip a
 *     change through, and two owners toggling at once serialize and each audit row reads the true old value.
 * A no-op change (same value) writes nothing and is reported `changed: false`.
 */

import { sql, withTransaction } from '@/lib/neon';
import type { BureauRole } from './bureauService';

export interface BureauSettingChange {
  changedAt: string;
  actorUserId: string;
  oldValue: boolean | null;
  newValue: boolean;
}

export interface BureauSharingSetting {
  shareMerchantPatterns: boolean;
  history: BureauSettingChange[];
}

export type SetSharingResult =
  | { kind: 'forbidden' }
  | { kind: 'ok'; changed: boolean; oldValue: boolean; newValue: boolean };

/** The caller's role in the bureau, or null when not a member. */
export async function getBureauRole(userId: string, bureauId: string): Promise<BureauRole | null> {
  const rows = (await sql`
    SELECT role FROM bureau_users WHERE bureau_id = ${bureauId}::UUID AND user_id = ${userId} LIMIT 1
  `) as Array<{ role: BureauRole }>;
  return rows[0]?.role ?? null;
}

const asBool = (v: unknown): boolean | null => (v === true ? true : v === false ? false : null);

export async function getBureauSharingSetting(bureauId: string, historyLimit = 10): Promise<BureauSharingSetting | null> {
  const rows = (await sql`
    SELECT share_merchant_patterns FROM bureaus WHERE id = ${bureauId}::UUID
  `) as Array<{ share_merchant_patterns: boolean }>;
  if (rows.length === 0) return null;
  const history = (await sql`
    SELECT created_at, actor_user_id, old_value, new_value FROM bureau_audit_log
    WHERE bureau_id = ${bureauId}::UUID AND setting = 'share_merchant_patterns'
    ORDER BY created_at DESC, id DESC
    LIMIT ${historyLimit}
  `) as Array<{ created_at: Date | string; actor_user_id: string; old_value: unknown; new_value: unknown }>;
  return {
    shareMerchantPatterns: rows[0]!.share_merchant_patterns === true,
    history: history.map((h) => ({
      changedAt: new Date(h.created_at).toISOString(),
      actorUserId: String(h.actor_user_id),
      oldValue: asBool(h.old_value),
      newValue: asBool(h.new_value) ?? false,
    })),
  };
}

/** Owner-only toggle; one audit row per real change (who, when, old -> new), in the same transaction. */
export async function setBureauSharingSetting(opts: {
  bureauId: string; actorUserId: string; value: boolean;
}): Promise<SetSharingResult> {
  return withTransaction(async (tx) => {
    const rows = (await tx`
      SELECT b.share_merchant_patterns
      FROM bureaus b
      JOIN bureau_users bu ON bu.bureau_id = b.id AND bu.user_id = ${opts.actorUserId} AND bu.role = 'owner'
      WHERE b.id = ${opts.bureauId}::UUID
      FOR UPDATE OF b
    `) as Array<{ share_merchant_patterns: boolean }>;
    if (rows.length === 0) return { kind: 'forbidden' } as const;
    const oldValue = rows[0]!.share_merchant_patterns === true;
    if (oldValue === opts.value) return { kind: 'ok', changed: false, oldValue, newValue: opts.value } as const;
    await tx`
      UPDATE bureaus SET share_merchant_patterns = ${opts.value}, updated_at = now()
      WHERE id = ${opts.bureauId}::UUID
    `;
    await tx`
      INSERT INTO bureau_audit_log (bureau_id, actor_user_id, action, setting, old_value, new_value)
      VALUES (${opts.bureauId}::UUID, ${opts.actorUserId}, 'setting_changed', 'share_merchant_patterns',
              to_jsonb(${oldValue}::BOOLEAN), to_jsonb(${opts.value}::BOOLEAN))
    `;
    return { kind: 'ok', changed: true, oldValue, newValue: opts.value } as const;
  });
}

/**
 * Bureau settings — the merchant-pattern sharing opt-in (bureaus.share_merchant_patterns, migration 904)
 * and its audit trail (bureau_audit_log).
 *
 * The toggle and the audit history run on the migration_admin pool (migration 932): no app role may write
 * bureaus or read or write bureau_audit_log (deny-all to app_user, 904), because SQL injected on an app pool
 * can forge the claims any policy would judge. Every statement is fixed and keyed on the verified session's
 * user id. The flag itself is read on the service pool. Authority:
 *   - read: any bureau member (the route checks bureauService.getBureauRole first);
 *   - change: the bureau OWNER only — bureaus.owner_user_id (getBureauRole explains why that column),
 *     re-checked INSIDE the write transaction with the bureau row locked, so an ownership change between the
 *     route's check and the write cannot slip a change through, and two toggles at once serialize and each
 *     audit row reads the true old value.
 * A no-op change (same value) writes nothing and is reported `changed: false`.
 * Switching ON is refused for everyone while MERCHANT_SHARING_ENABLED is off (merchantSharingGate.ts: the
 * consent copy awaits legal review), checked after the owner and no-op checks so a non-owner still gets
 * 403 and "on" for a bureau already on is a no-op; switching OFF is always allowed.
 */

import { sql } from '@/lib/neon';
import { migrationAdminTx } from '@/lib/auth/migrationAdminPool';
import { isMerchantSharingEnabled } from './merchantSharingGate';

export interface BureauSettingChange {
  id: string;
  changedAt: string;
  actorUserId: string;
  /** The actor's name, else email; null when the user no longer exists. Shown to bureau members only. */
  actorName: string | null;
  oldValue: boolean | null;
  newValue: boolean;
}

export interface BureauSharingSetting {
  shareMerchantPatterns: boolean;
  history: BureauSettingChange[];
}

export type SetSharingResult =
  | { kind: 'forbidden' }
  | { kind: 'pending_legal_review' }
  | { kind: 'ok'; changed: boolean; oldValue: boolean; newValue: boolean };

const asBool = (v: unknown): boolean | null => (v === true ? true : v === false ? false : null);

export async function getBureauSharingSetting(bureauId: string, historyLimit = 10): Promise<BureauSharingSetting | null> {
  // The flag is readable on the service pool; only the audit log (deny-all to the app roles) needs migration_admin.
  const rows = (await sql`
    SELECT share_merchant_patterns FROM bureaus WHERE id = ${bureauId}::UUID
  `) as Array<{ share_merchant_patterns: boolean }>;
  if (rows.length === 0) return null;
  const history = await migrationAdminTx('bureau-sharing-history', async (c) => (await c.query<{
    id: string; created_at: Date | string; actor_user_id: string; old_value: unknown; new_value: unknown;
    actor_name: string | null;
  }>(`
    SELECT a.id, a.created_at, a.actor_user_id, a.old_value, a.new_value,
           COALESCE(NULLIF(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email) AS actor_name
    FROM bureau_audit_log a
    LEFT JOIN users u ON u.id = a.actor_user_id::TEXT
    WHERE a.bureau_id = $1::UUID AND a.setting = 'share_merchant_patterns'
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT $2
  `, [bureauId, historyLimit])).rows);
  return {
    shareMerchantPatterns: rows[0]!.share_merchant_patterns === true,
    history: history.map((h) => ({
      id: String(h.id),
      changedAt: new Date(h.created_at).toISOString(),
      actorUserId: String(h.actor_user_id),
      actorName: h.actor_name ?? null,
      oldValue: asBool(h.old_value),
      newValue: asBool(h.new_value) ?? false,
    })),
  };
}

/** Owner-only toggle; one audit row per real change (who, when, old -> new), in the same transaction. */
export async function setBureauSharingSetting(opts: {
  bureauId: string; actorUserId: string; value: boolean;
}): Promise<SetSharingResult> {
  return migrationAdminTx('bureau-sharing-set', async (c) => {
    // The owner is read live, under the row lock: the only authority for the write below.
    const { rows } = await c.query<{ share_merchant_patterns: boolean }>(`
      SELECT b.share_merchant_patterns
      FROM bureaus b
      WHERE b.id = $1::UUID AND b.owner_user_id = $2
      FOR UPDATE
    `, [opts.bureauId, opts.actorUserId]);
    if (rows.length === 0) return { kind: 'forbidden' } as const;
    const oldValue = rows[0]!.share_merchant_patterns === true;
    if (oldValue === opts.value) return { kind: 'ok', changed: false, oldValue, newValue: opts.value } as const;
    // After the owner check, so a non-owner hears 403, not the gate; switching OFF never reaches it.
    if (opts.value && !isMerchantSharingEnabled()) return { kind: 'pending_legal_review' } as const;
    await c.query(`
      UPDATE bureaus SET share_merchant_patterns = $2, updated_at = now()
      WHERE id = $1::UUID AND owner_user_id = $3
    `, [opts.bureauId, opts.value, opts.actorUserId]);
    await c.query(`
      INSERT INTO bureau_audit_log (bureau_id, actor_user_id, action, setting, old_value, new_value)
      VALUES ($1::UUID, $2, 'setting_changed', 'share_merchant_patterns', to_jsonb($3::BOOLEAN), to_jsonb($4::BOOLEAN))
    `, [opts.bureauId, opts.actorUserId, oldValue, opts.value]);
    return { kind: 'ok', changed: true, oldValue, newValue: opts.value } as const;
  });
}

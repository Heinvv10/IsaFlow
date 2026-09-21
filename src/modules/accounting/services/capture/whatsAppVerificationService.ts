import { sql, withTransaction, type TxSql } from '@/lib/neon';
import { hashWhatsAppToken } from './whatsAppInboxService';

type Binding = { companyId: string; inboxId: string; tokenHash: string };
type Claim = { company_id: string; address: string; created_by: string };
type Inbox = { id: string; company_id: string };

async function activeBinding(tx: TxSql, companyId: string, address: string, hash: string): Promise<Binding | null> {
  const rows = await tx`
    SELECT i.id, i.company_id FROM capture_inboxes i
    JOIN companies c ON c.id = i.company_id
    WHERE i.company_id = ${companyId}::uuid AND i.channel = 'whatsapp'
      AND btrim(i.address) = ${address} AND i.webhook_token_hash = ${hash}
      AND i.provider_verified_at IS NOT NULL AND i.is_active
      AND c.status IS DISTINCT FROM 'suspended' AND c.status IS DISTINCT FROM 'deleted'
      AND c.suspended_at IS NULL
  ` as Inbox[];
  return rows[0] ? { companyId, inboxId: rows[0].id, tokenHash: hash } : null;
}

/** Called only after provider signature verification for the exact token-bearing URL. */
export async function verifyWhatsAppDestination(token: string, address: string): Promise<Binding | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !/^\+\d{7,15}$/.test(address)) return null;
  const hash = hashWhatsAppToken(token);
  // Global opaque-token routing lookup establishes tenant scope; never enumerate by number alone.
  const candidates = await sql<{ company_id: string }>`
    SELECT company_id FROM capture_whatsapp_claims WHERE token_hash = ${hash}
    UNION SELECT company_id FROM capture_inboxes WHERE webhook_token_hash = ${hash} AND channel = 'whatsapp'
  `;
  if (candidates.length !== 1) return null;
  const companyId = candidates[0]!.company_id;
  return withTransaction(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${companyId}::text, 617))`;
    const active = await activeBinding(tx, companyId, address, hash);
    if (active) return active;
    // Re-read AFTER locking: a concurrent restart may have replaced this challenge.
    const claims = await tx`
      SELECT p.company_id, p.address, p.created_by FROM capture_whatsapp_claims p
      JOIN company_users cu ON cu.company_id = p.company_id AND cu.user_id = p.created_by
      JOIN users u ON u.id = p.created_by
      JOIN companies c ON c.id = p.company_id
      WHERE p.company_id = ${companyId}::uuid AND p.token_hash = ${hash}
        AND p.address = ${address} AND p.expires_at > clock_timestamp()
        AND cu.role IN ('owner', 'admin', 'manager')
        AND u.is_active = true AND u.suspended_at IS NULL
        AND (u.status IS NULL OR lower(u.status) = 'active')
        AND c.status IS DISTINCT FROM 'suspended' AND c.status IS DISTINCT FROM 'deleted'
        AND c.suspended_at IS NULL
    ` as Claim[];
    const claim = claims[0];
    if (!claim) return null;
    const inserted = await tx`
      INSERT INTO capture_inboxes(company_id, channel, address, is_active, created_by)
      VALUES (${companyId}::uuid, 'whatsapp', ${address}, false, ${claim.created_by}::uuid)
      ON CONFLICT DO NOTHING RETURNING id, company_id
    ` as Inbox[];
    const own = inserted[0] ?? (await tx`
      SELECT id, company_id FROM capture_inboxes
      WHERE company_id = ${companyId}::uuid AND channel = 'whatsapp' AND btrim(address) = ${address}
    ` as Inbox[])[0];
    if (!own) return null; // Preserve previous active routing on another company's reservation.
    await tx`
      UPDATE capture_inboxes SET is_active = false, updated_at = NOW()
      WHERE company_id = ${companyId}::uuid AND channel = 'whatsapp' AND id <> ${own.id}::uuid AND is_active
    `;
    await tx`
      UPDATE capture_inboxes SET is_active = true, address = ${address}, webhook_token_hash = ${hash},
        provider_verified_at = NOW(), updated_at = NOW()
      WHERE company_id = ${companyId}::uuid AND id = ${own.id}::uuid
    `;
    await tx`DELETE FROM capture_whatsapp_claims WHERE company_id = ${companyId}::uuid AND token_hash = ${hash}`;
    return { companyId, inboxId: own.id, tokenHash: hash };
  });
}

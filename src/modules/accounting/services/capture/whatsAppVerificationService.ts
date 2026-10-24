import { sql } from '@/lib/neon';
import { migrationAdminTx } from '@/lib/auth/migrationAdminPool';
import { hashWhatsAppToken } from './whatsAppInboxService';

type Binding = { companyId: string; inboxId: string; tokenHash: string };
type Claim = { company_id: string; address: string; created_by: string };
type Inbox = { id: string; company_id: string };

type Query = <T>(text: string, params: unknown[]) => Promise<T[]>;

async function activeBinding(query: Query, companyId: string, address: string, hash: string): Promise<Binding | null> {
  const rows = await query<Inbox>(`
    SELECT i.id, i.company_id FROM capture_inboxes i
    JOIN companies c ON c.id = i.company_id
    WHERE i.company_id = $1::uuid AND i.channel = 'whatsapp'
      AND btrim(i.address) = $2 AND i.webhook_token_hash = $3
      AND i.provider_verified_at IS NOT NULL AND i.is_active
      AND c.status IS DISTINCT FROM 'suspended' AND c.status IS DISTINCT FROM 'deleted'
      AND c.suspended_at IS NULL
  `, [companyId, address, hash]);
  return rows[0] ? { companyId, inboxId: rows[0].id, tokenHash: hash } : null;
}

const onServicePool: Query = async <T>(text: string, params: unknown[]) => (await sql.query<T>(text, params)) as T[];

/**
 * Called only after provider signature verification for the exact token-bearing URL.
 *
 * Activation runs on the migration_admin pool (S-07d, migration 935): the claim
 * and the inbox it activates decide which company a WhatsApp number's documents
 * go to, so no app role may INSERT or UPDATE capture_whatsapp_claims or
 * capture_inboxes. Every statement is keyed on the token's hash and the
 * provider-verified number, never on a claim read from the session. The
 * steady state, a message to an already-active binding, only reads, on the
 * service pool.
 */
export async function verifyWhatsAppDestination(token: string, address: string): Promise<Binding | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !/^\+\d{7,15}$/.test(address)) return null;
  const hash = hashWhatsAppToken(token);
  // Global opaque-token routing lookup establishes tenant scope; never enumerate by number alone.
  // Read on the service pool: every inbound message makes it, and only a claim to consume needs migration_admin.
  const candidates = await onServicePool<{ company_id: string }>(`
    SELECT company_id FROM capture_whatsapp_claims WHERE token_hash = $1
    UNION SELECT company_id FROM capture_inboxes WHERE webhook_token_hash = $1 AND channel = 'whatsapp'
  `, [hash]);
  if (candidates.length !== 1) return null;
  const companyId = candidates[0]!.company_id;
  const active = await activeBinding(onServicePool, companyId, address, hash);
  if (active) return active;
  return migrationAdminTx('verify whatsapp inbox', async (client) => {
    const onAdmin: Query = async <T>(text: string, params: unknown[]) => (await client.query(text, params)).rows as T[];
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 617))', [companyId]);
    // Re-read AFTER locking: a concurrent callback may have activated it, or a restart replaced this challenge.
    const bound = await activeBinding(onAdmin, companyId, address, hash);
    if (bound) return bound;
    const claim = (await onAdmin<Claim>(`
      SELECT p.company_id, p.address, p.created_by FROM capture_whatsapp_claims p
      JOIN company_users cu ON cu.company_id = p.company_id AND cu.user_id = p.created_by
      JOIN users u ON u.id = p.created_by
      JOIN companies c ON c.id = p.company_id
      WHERE p.company_id = $1::uuid AND p.token_hash = $2
        AND p.address = $3 AND p.expires_at > clock_timestamp()
        AND cu.role IN ('owner', 'admin', 'manager')
        AND u.is_active = true AND u.suspended_at IS NULL
        AND (u.status IS NULL OR lower(u.status) = 'active')
        AND c.status IS DISTINCT FROM 'suspended' AND c.status IS DISTINCT FROM 'deleted'
        AND c.suspended_at IS NULL
    `, [companyId, hash, address]))[0];
    if (!claim) return null;
    const inserted = await onAdmin<Inbox>(`
      INSERT INTO capture_inboxes(company_id, channel, address, is_active, created_by)
      VALUES ($1::uuid, 'whatsapp', $2, false, $3::uuid)
      ON CONFLICT DO NOTHING RETURNING id, company_id
    `, [companyId, address, claim.created_by]);
    const own = inserted[0] ?? (await onAdmin<Inbox>(`
      SELECT id, company_id FROM capture_inboxes
      WHERE company_id = $1::uuid AND channel = 'whatsapp' AND btrim(address) = $2
    `, [companyId, address]))[0];
    if (!own) return null; // Preserve previous active routing on another company's reservation.
    await client.query(`
      UPDATE capture_inboxes SET is_active = false, updated_at = NOW()
      WHERE company_id = $1::uuid AND channel = 'whatsapp' AND id <> $2::uuid AND is_active
    `, [companyId, own.id]);
    await client.query(`
      UPDATE capture_inboxes SET is_active = true, address = $3, webhook_token_hash = $4,
        provider_verified_at = NOW(), updated_at = NOW()
      WHERE company_id = $1::uuid AND id = $2::uuid
    `, [companyId, own.id, address, hash]);
    await client.query('DELETE FROM capture_whatsapp_claims WHERE company_id = $1::uuid AND token_hash = $2', [companyId, hash]);
    return { companyId, inboxId: own.id, tokenHash: hash };
  });
}

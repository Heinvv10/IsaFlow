import { createHash, randomBytes } from 'node:crypto';
import { migrationAdminTx } from '@/lib/auth/migrationAdminPool';
import { requireCtx } from '@/lib/als';

export function hashWhatsAppToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A claim is not a reservation. Only a provider-authenticated callback activates it. */
export async function configureWhatsAppInbox(companyId: string, address: string, userId: string) {
  const ctx = requireCtx();
  if (ctx.companyId !== companyId || ctx.userId !== userId) {
    throw new Error('WhatsApp inbox requires its authenticated company transaction');
  }
  const origin = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  if (!origin || !process.env.TWILIO_AUTH_TOKEN) throw new Error('WhatsApp verification is not configured');
  const token = randomBytes(32).toString('base64url');
  // On the migration_admin pool (S-07d, migration 935): a claim decides which
  // company a provider-verified WhatsApp number's documents go to, so no app
  // role may INSERT or UPDATE capture_whatsapp_claims. Keyed on the verified
  // request (checked above).
  const rows = await migrationAdminTx('claim whatsapp inbox', async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 617))', [companyId]);
    return (await client.query<{ expires_at: Date | string }>(
      `INSERT INTO capture_whatsapp_claims(company_id, address, token_hash, created_by, expires_at)
       VALUES ($1::uuid, $2, $3, $4, NOW() + INTERVAL '24 hours')
       ON CONFLICT (company_id) DO UPDATE SET address = EXCLUDED.address,
         token_hash = EXCLUDED.token_hash, created_by = EXCLUDED.created_by,
         expires_at = EXCLUDED.expires_at, created_at = NOW()
       RETURNING expires_at`,
      [companyId, address, hashWhatsAppToken(token), userId],
    )).rows;
  });
  return {
    address, isActive: false as const,
    verificationUrl: `${origin.replace(/\/$/, '')}/api/accounting/capture/inbound/whatsapp?token=${token}`,
    expiresAt: rows[0]!.expires_at,
  };
}

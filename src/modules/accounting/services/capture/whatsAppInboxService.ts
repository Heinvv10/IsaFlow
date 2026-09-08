import { sql } from '@/lib/neon';
import { requireCtx } from '@/lib/als';

type Row = { id: string; address: string; is_active: boolean };

/** Claim a unique destination without losing the old number on a conflict. */
export async function configureWhatsAppInbox(companyId: string, address: string, userId: string): Promise<Row | null> {
  const ctx = requireCtx();
  if (ctx.companyId !== companyId || ctx.userId !== userId) {
    throw new Error('WhatsApp inbox requires its authenticated company transaction');
  }
  // Serialize different-number changes for one company, not unrelated tenants.
  // An advisory lock avoids requiring company-row UPDATE authority: managers
  // already have write access to this route and capture_inboxes under RLS.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${companyId}::text, 617))`;
  const inserted = await sql<Row>`
    INSERT INTO capture_inboxes (company_id, channel, address, is_active, created_by)
    VALUES (${companyId}::uuid, 'whatsapp', ${address}, true, ${userId}::uuid)
    ON CONFLICT DO NOTHING
    RETURNING id, address, is_active
  `;
  const own = inserted[0] ?? (await sql<Row>`
    SELECT id, address, is_active FROM capture_inboxes
    WHERE company_id = ${companyId}::uuid AND channel = 'whatsapp' AND btrim(address) = ${address}
    LIMIT 1
  `)[0];
  if (!own) return null;
  await sql`
    UPDATE capture_inboxes SET is_active = true, address = ${address}, updated_at = NOW()
    WHERE id = ${own.id}::uuid AND company_id = ${companyId}::uuid
  `;
  await sql`
    UPDATE capture_inboxes SET is_active = false, updated_at = NOW()
    WHERE company_id = ${companyId}::uuid AND channel = 'whatsapp'
      AND id <> ${own.id}::uuid AND is_active = true
  `;
  return { id: own.id, address, is_active: true };
}

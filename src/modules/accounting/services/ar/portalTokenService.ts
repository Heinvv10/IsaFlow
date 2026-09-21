/**
 * Customer invoice portal token — PRD-06 Phase 2.
 *
 * Thin wrapper over the existing customer_invoices.portal_token (mig 300).
 * We deliberately do NOT introduce an HMAC scheme: the stored random 64-hex
 * token already ships in prod, the generate endpoint is idempotent, and
 * swapping schemes would invalidate every link bookkeepers have already
 * emailed.
 *
 * TTL decision (Hein, 2026-04-23): invoice-lifetime. The token is valid
 * until the invoice is cancelled or soft-deleted — verification checks
 * both at read-time, so we don't need an expires_at column.
 */

import crypto from 'node:crypto';

import { sql, type DbRow } from '@/lib/neon';

export interface VerifiedPortalToken {
  invoiceId: string;
  companyId: string;
  status: string;
}

function isValidTokenShape(token: string): boolean {
  return /^[a-f0-9]{64}$/.test(token);
}

function portalUrl(token: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3101';
  return `${appUrl}/portal/invoice/${token}`;
}

/**
 * Read-only: the invoice's stored portal_token, or null when none is stored
 * or the invoice is not portal-eligible. Mints nothing — use this on paths
 * that only display a link (preview), so a read-shaped request never
 * persists a permanent unauthenticated credential.
 */
export async function getInvoicePortalToken(
  invoiceId: string,
  companyId: string,
): Promise<string | null> {
  const rows = (await sql`
    SELECT portal_token
    FROM customer_invoices
    WHERE id = ${invoiceId}::uuid
      AND company_id = ${companyId}::uuid
      AND status != 'cancelled'
      AND deleted_at IS NULL
    LIMIT 1
  `) as DbRow[];

  return rows[0]?.portal_token ? String(rows[0].portal_token) : null;
}

/**
 * Idempotent: returns the invoice's existing portal_token if one is stored,
 * otherwise mints a fresh 32-byte hex token and persists it. Company-scoped.
 *
 * The mint is a single COALESCE UPDATE ... RETURNING, not a read-modify-write:
 * two concurrent renders of the same invoice (the dunning cron and a manual
 * send) would otherwise both see NULL, both mint, and the loser would email a
 * token that is not the one in the database — a dead link, which is the exact
 * 404 this path exists to remove. COALESCE makes the second writer keep the
 * first writer's token and RETURNING hands back whatever is actually stored.
 */
export async function getOrMintInvoicePortalToken(
  invoiceId: string,
  companyId: string,
): Promise<{ token: string; url: string }> {
  const existing = await getInvoicePortalToken(invoiceId, companyId);
  if (existing) return { token: existing, url: portalUrl(existing) };

  const minted = crypto.randomBytes(32).toString('hex');
  const rows = (await sql`
    UPDATE customer_invoices
    SET portal_token = COALESCE(portal_token, ${minted})
    WHERE id = ${invoiceId}::uuid
      AND company_id = ${companyId}::uuid
      AND status != 'cancelled'
      AND deleted_at IS NULL
    RETURNING portal_token
  `) as DbRow[];

  if (!rows[0]) {
    throw new Error(`Invoice not found or not eligible for portal: ${invoiceId}`);
  }

  const token = String(rows[0].portal_token);
  return { token, url: portalUrl(token) };
}

/**
 * Verify a raw portal token and return the invoice + company it unlocks.
 * Invoice-lifetime TTL: cancelled / soft-deleted invoices are rejected.
 * Returns null for missing, malformed, or ineligible tokens — callers
 * should treat null as 404 (never leak the difference).
 */
export async function verifyInvoicePortalToken(
  token: string,
): Promise<VerifiedPortalToken | null> {
  if (!token || !isValidTokenShape(token)) return null;

  const rows = (await sql`
    SELECT id, company_id, status
    FROM customer_invoices
    WHERE portal_token = ${token}
      AND status != 'cancelled'
      AND deleted_at IS NULL
    LIMIT 1
  `) as DbRow[];

  if (!rows[0]) return null;

  return {
    invoiceId: String(rows[0].id),
    companyId: String(rows[0].company_id),
    status: String(rows[0].status),
  };
}

/**
 * One-way SHA-256 of the raw portal token. Written to
 * customer_invoice_views.session_token so we can count distinct sessions
 * without ever storing the token itself.
 */
export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

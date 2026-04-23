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

/**
 * Idempotent: returns the invoice's existing portal_token if one is stored,
 * otherwise mints a fresh 32-byte hex token and persists it. Company-scoped.
 */
export async function getOrMintInvoicePortalToken(
  invoiceId: string,
  companyId: string,
): Promise<{ token: string; url: string }> {
  const rows = (await sql`
    SELECT portal_token
    FROM customer_invoices
    WHERE id = ${invoiceId}::uuid
      AND company_id = ${companyId}::uuid
      AND status != 'cancelled'
      AND deleted_at IS NULL
    LIMIT 1
  `) as DbRow[];

  if (!rows[0]) {
    throw new Error(`Invoice not found or not eligible for portal: ${invoiceId}`);
  }

  let token = rows[0].portal_token ? String(rows[0].portal_token) : null;

  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    await sql`
      UPDATE customer_invoices
      SET portal_token = ${token}
      WHERE id = ${invoiceId}::uuid
        AND company_id = ${companyId}::uuid
    `;
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3101';
  return { token, url: `${appUrl}/portal/invoice/${token}` };
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

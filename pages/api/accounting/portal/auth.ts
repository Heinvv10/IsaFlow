// pages/api/accounting/portal/auth.ts — POST
// Public route — sends magic link email.
// Rate-limited: 5 requests per minute per IP.
// Always returns 200 to prevent email enumeration.

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import { createMagicLink } from '@/modules/accounting/services/afs/magicLinkService';
import { notifyMagicLinkRequested } from '@/modules/accounting/services/afs/portalNotificationService';
import type { PortalRole } from '@/modules/accounting/services/afs/afsTypes';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.isaflow.co.za';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  // Rate limit by IP — 5 requests per 60 seconds (Neon-backed, multi-pod safe)
  const ip = getClientIp(req);
  const allowed = await checkRateLimit(`portal-auth:${ip}`, { max: 5, windowSecs: 60 });
  if (!allowed) {
    log.warn('Portal auth rate limit exceeded', { ip }, 'portal-auth-api');
    return apiResponse.tooManyRequests(res, 'Too many login attempts. Please try again in a minute.');
  }

  const { email } = req.body as { email?: string };
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return apiResponse.badRequest(res, 'A valid email is required');
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Cross-tenant lookup — user provides only their email, company_id comes from the record
  const contacts = (await sql`
    SELECT id, company_id, name, email, role
    FROM portal_contacts
    WHERE email = ${normalizedEmail} AND active = true
    LIMIT 1
  `) as Array<{ id: string; company_id: string; name: string; email: string; role: string }>;

  if (contacts.length > 0) {
    const contact = contacts[0]!;
    const { token } = await createMagicLink(contact.company_id, contact.id);
    const magicLinkUrl = `${APP_URL}/api/accounting/portal/auth/verify?token=${token}`;

    await notifyMagicLinkRequested(
      {
        id: contact.id,
        companyId: contact.company_id,
        name: contact.name,
        email: contact.email,
        role: contact.role as PortalRole,
        active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      magicLinkUrl,
    );

    log.info('Magic link created for portal contact', { contactId: contact.id }, 'portal-auth-api');
  }

  // Always return success — prevent email enumeration
  return apiResponse.success(res, { sent: true });
}

export default withErrorHandler(handler as never);

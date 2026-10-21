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
import { notifyMagicLinkRequested, type PortalSignInLink } from '@/modules/accounting/services/afs/portalNotificationService';
import { listLiveCompanies } from '@/lib/auth/liveCompanies';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.isaflow.co.za';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  // Rate limit by IP — 5 requests per 60 seconds (Neon-backed, multi-pod safe).
  // Its own key: it used to share `portal-auth:` with the AR portal's password
  // login (pages/api/portal/auth.ts, 5 per 15 minutes). One row, two windows:
  // this route's 60-second window kept resetting that login's count (R-175).
  const ip = getClientIp(req);
  const allowed = await checkRateLimit(`afs-portal-magic-link:${ip}`, { max: 5, windowSecs: 60 });
  if (!allowed) {
    log.warn('Portal auth rate limit exceeded', { ip }, 'portal-auth-api');
    return apiResponse.tooManyRequests(res, 'Too many login attempts. Please try again in a minute.');
  }

  const { email } = req.body as { email?: string };
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return apiResponse.badRequest(res, 'A valid email is required');
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Cross-tenant lookup — the user provides only their email. One email can be
  // a contact on several companies (audit S-08): every live one gets its own
  // link, all in one email, so the contact chooses rather than LIMIT 1.
  const contacts = (await sql`
    SELECT id, company_id, name, email
    FROM portal_contacts
    WHERE email = ${normalizedEmail} AND active = true
    ORDER BY created_at, id
  `) as Array<{ id: string; company_id: string; name: string; email: string }>;

  const live = new Map(
    (await listLiveCompanies(contacts.map((c) => c.company_id))).map((c) => [c.companyId, c.companyName]),
  );
  const liveContacts = contacts.flatMap((c) => {
    const companyName = live.get(c.company_id);
    return companyName === undefined ? [] : [{ ...c, companyName: companyName || 'Your company' }];
  });

  const first = liveContacts[0];
  if (first) {
    // A failure here happens only for an email that exists; answering it as a
    // 500 would tell the caller so. Logged, and answered like every other email.
    try {
      const links: PortalSignInLink[] = [];
      for (const contact of liveContacts) {
        const { token } = await createMagicLink(contact.company_id, contact.id);
        links.push({
          companyId: contact.company_id,
          companyName: contact.companyName,
          url: `${APP_URL}/api/accounting/portal/auth/verify?token=${token}`,
        });
      }
      await notifyMagicLinkRequested({ name: first.name, email: first.email }, links);
      log.info('Magic links created for portal contact', { contactIds: liveContacts.map((c) => c.id) }, 'portal-auth-api');
    } catch (err) {
      log.error('Portal magic links could not be created', {
        contactIds: liveContacts.map((c) => c.id),
        error: err instanceof Error ? err.message : String(err),
      }, 'portal-auth-api');
    }
  }

  // Always return success — prevent email enumeration
  return apiResponse.success(res, { sent: true });
}

export default withErrorHandler(handler as never);

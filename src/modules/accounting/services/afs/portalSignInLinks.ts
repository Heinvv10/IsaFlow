/**
 * Portal sign-in links (audit S-08).
 *
 * One email can be an active portal contact on several companies. Every LIVE
 * one (liveCompanies.listLiveCompanies) gets its own single-use magic link, and
 * all of them go out in ONE email, so the contact chooses the company rather
 * than the lookup picking one.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { listLiveCompanies } from '@/lib/auth/liveCompanies';
import { createMagicLink } from './magicLinkService';
import { notifyMagicLinkRequested, type PortalSignInLink } from './portalNotificationService';

/**
 * Looks `normalizedEmail` up across tenants and sends the sign-in email.
 * Never rejects: every failure is logged, because the caller answers every
 * email alike and does not wait for this (pages/api/accounting/portal/auth.ts).
 */
export async function sendPortalSignInLinks(normalizedEmail: string, appUrl: string): Promise<void> {
  try {
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
    if (!first) return;
    const links: PortalSignInLink[] = [];
    for (const contact of liveContacts) {
      const { token } = await createMagicLink(contact.company_id, contact.id);
      links.push({
        companyId: contact.company_id,
        companyName: contact.companyName,
        url: `${appUrl}/api/accounting/portal/auth/verify?token=${token}`,
      });
    }
    await notifyMagicLinkRequested({ name: first.name, email: first.email }, links);
    log.info('Magic links created for portal contact', { contactIds: liveContacts.map((c) => c.id) }, 'portalSignInLinks');
  } catch (err) {
    log.error('Portal magic links could not be created', {
      error: err instanceof Error ? err.message : String(err),
    }, 'portalSignInLinks');
  }
}

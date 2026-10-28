/**
 * The invitation email's email_log row is written inside the inviter's request,
 * as app_user, where email_log's tenant_isolation policy admits only
 * `company_id = app.current_company_id()`. sendInviteEmail logged companyId
 * NULL, so every invite send since the policy landed failed its audit insert
 * ("new row violates row-level security policy for table email_log"; 7 times in
 * 30 days on prod, all from POST /api/accounting/company-invitations) and User
 * Access could never show a real sent / failed status. It now logs the
 * inviting company.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ sendEmail: vi.fn(async () => ({ success: true, messageId: 'm-1' })) }));
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail: h.sendEmail }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { sendInviteEmail } from '@/modules/accounting/services/core/emailNotificationService';

beforeEach(() => { h.sendEmail.mockClear(); });

describe('sendInviteEmail — the email_log row', () => {
  it('is written for the inviting company, the one the request is scoped to', async () => {
    await sendInviteEmail({
      companyId: 'co-inviting', recipientEmail: 'invitee@example.test', inviteToken: 'tok',
      companyName: 'Probe Co', inviterName: 'Owner', role: 'viewer', baseUrl: 'https://app.example.test',
    });

    expect(h.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      _log: expect.objectContaining({ companyId: 'co-inviting', emailType: 'invite' }),
    }));
  });
});

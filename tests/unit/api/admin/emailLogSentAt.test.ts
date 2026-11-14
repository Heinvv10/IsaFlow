/**
 * Audit 4.11: Email Log "Sent At" printed the raw JS date string ("Thu Nov 05 2026 13:53:22 GMT+0200 (…)"):
 * pg hands sent_at over as a Date and the route String()-ed it. The route must send an ISO timestamp the page
 * formats.
 */
import { describe, it, expect, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/modules/admin/middleware/withAdmin', () => ({ withAdmin: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const SENT = new Date('2026-11-05T11:53:22.000Z');
vi.mock('@/lib/neon', () => {
  const sql = Object.assign(vi.fn(async () => [{ total_sent: 1, total_failed: 0 }]), {
    query: vi.fn(async (q: string) => (q.includes('COUNT(*)')
      ? [{ cnt: 1 }]
      : [{ id: 'e1', company_id: null, company_name: null, recipient_email: 'a@b.test', subject: 'Hi', email_type: 'invite',
           status: 'sent', error_message: null, sent_at: SENT, sent_by: null }])),
  });
  return { sql };
});

import route from '../../../../pages/api/admin/email-log';
import { fmtDate } from '@/components/admin/emailLog/emailLogLabels';

describe('GET /api/admin/email-log', () => {
  it('sends sent_at as an ISO timestamp, which the page formats', async () => {
    let body: { data: { items: { sent_at: string }[] } } | undefined;
    const req = { method: 'GET', query: {}, headers: {} } as unknown as NextApiRequest;
    const res = {
      status() { return res; }, setHeader() { return res; },
      json(b: typeof body) { body = b; return res; },
    } as unknown as NextApiResponse;
    await (route as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<void>)(req, res);
    const sentAt = body?.data.items[0]?.sent_at ?? '';
    expect(sentAt).toBe('2026-11-05T11:53:22.000Z');
    expect(fmtDate(sentAt)).not.toMatch(/GMT|Standard Time/);
  });
});

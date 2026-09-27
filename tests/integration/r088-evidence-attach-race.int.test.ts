// R-088 x R-127 (L2): a manual evidence attach and an invoice post of the SAME
// bytes from two uploads, concurrently. The attach books nothing new and
// stamps nothing, but it spends the slip; so it must serialise on the file's
// fingerprint like every other claim. Otherwise the invoice post reads "nothing
// posted" while the attach is uncommitted, both commit, and migration 710's
// index cannot see the unstamped evidence row.
//
// Deterministic: A's attach runs inside an open transaction, so its advisory
// lock is HELD after the claim; B's inbox post is seen waiting on it before A
// commits, and then answers 409 content_posted with nothing written.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import capturePostRoute from '../../pages/api/accounting/capture/[id]/post';
import { als } from '@/lib/als';
import { attachDocumentToProvisional } from '@/modules/accounting/services/capture/provisionalEvidenceAttach';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  call, company, errorOf, invoiceCount, lockWaiters, pool, postedAt, purge, seed, seedProvisional, upload,
  uploadToInbox, user,
} from './r088-receipt-content-dedupe.helpers';

assertDisposable();

beforeAll(seed);
afterAll(async () => {
  try { await purge(); } finally { clearSystemAccountCache(); await pool.end(); }
}, 60_000);

describe('R-088 a manual evidence attach serialises on the file like every other claim', () => {
  it('an invoice post of the same bytes waits for the attach, then is refused 409 with nothing written', async () => {
    const je = await seedProvisional(3680);
    const a = await upload('race-3680', { total: 3680, invoice: true });
    const b = await uploadToInbox('race-3680', { total: 3680, invoice: true });

    const client = await pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      const attached = await als.run({ client, userId: user, companyId: company, claims: {} } as never,
        () => attachDocumentToProvisional(company, je, a));
      expect(attached.kind).toBe('attached');

      // A is attached but uncommitted, holding what it took. B posts the same file.
      const post = call(capturePostRoute, `/api/accounting/capture/${b.eventId}/post`, {}, b.eventId);
      let parked = false;
      for (let i = 0; i < 40 && !parked; i++) {
        parked = (await lockWaiters()) > 0;
        if (!parked) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await client.query('COMMIT');
      committed = true;
      const posted = await post;

      expect(posted.state.statusCode, JSON.stringify(posted.state.body)).toBe(409);
      expect(errorOf(posted).message).toMatch(/same file was already posted/i);
      expect(await invoiceCount(b.documentId)).toBe(0);
      expect(await postedAt(b.documentId)).toBeNull();
      // The window was entered: B waited on A's fingerprint lock.
      expect(parked).toBe(true);
    } finally {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 30_000);
});

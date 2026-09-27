// R-088 x R-127 (L2 re-check): the evidence claim must CHECK, not only lock.
//
// A manual attach books nothing new, but it tells the ledger "this slip is the
// provisional's evidence". If ANOTHER upload of the same bytes is already booked
// — say B was invoiced from the inbox and its auto-attach missed (supplier,
// amount or date off) — attaching A would mark the provisional evidenced while
// B's bill, which R-127 does not settle (it is not B's document on the
// provisional), books the spend a second time, and hide it from the
// needs-evidence queue. So the evidence claim refuses content_posted too.
//
// The deadlock between the two paths resolves safely either way:
//   * B the victim: B's auto-attach rolls back in its savepoint and B's invoice
//     commits; A, waiting on B's fingerprint lock, then reads B as booked and
//     is refused — the provisional still needs evidence;
//   * A the victim: A is refused busy and writes nothing; B proceeds and its
//     own auto-attach evidences the provisional with B (the R-127 same-document flow).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import capturePostRoute from '../../pages/api/accounting/capture/[id]/post';
import attachRoute from '../../pages/api/accounting/provisional/[jeId]/attach';
import { als } from '@/lib/als';
import { attachDocumentToProvisional } from '@/modules/accounting/services/capture/provisionalEvidenceAttach';
import { attachEvidenceToProvisional } from '@/modules/accounting/services/capture/evidenceAttachmentService';
import { claimCapturedDocumentForPosting } from '@/modules/accounting/services/capture/capturePostingClaim';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  call, company, errorOf, invoiceCount, lockWaiters, pool, postedAt, purge, seed, seedProvisional, today, upload,
  uploadToInbox, user,
} from './r088-receipt-content-dedupe.helpers';

assertDisposable();

beforeAll(seed);
afterAll(async () => {
  try { await purge(); } finally { clearSystemAccountCache(); await pool.end(); }
}, 60_000);

const inCtx = <T>(c: PoolClient, fn: () => Promise<T>) =>
  als.run({ client: c, userId: user, companyId: company, claims: {} } as never, fn);

async function provisionalState(je: string) {
  return (await pool.query(
    `SELECT e.needs_evidence, e.source_document_id, bt.status AS line
       FROM gl_journal_entries e JOIN bank_transactions bt ON bt.provisional_je_id = e.id WHERE e.id=$1`, [je])).rows[0];
}

async function waitUntilSomeoneWaits(): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    if ((await lockWaiters()) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe('R-088 a manual evidence attach is refused when another upload of the file is booked', () => {
  it('B invoiced first (its auto-attach missed), then attaching A is refused and the provisional still needs evidence', async () => {
    const je = await seedProvisional(3795);
    // The inbox invoices B; its auto-attach needs the bank line's predicted supplier, which is unset — so it misses.
    const b = await uploadToInbox('check-3795', { total: 3795, invoice: true });
    expect((await call(capturePostRoute, `/api/accounting/capture/${b.eventId}/post`, {}, b.eventId)).state.statusCode).toBe(200);
    expect(await invoiceCount(b.documentId)).toBe(1);
    expect((await provisionalState(je)).needs_evidence).toBe(true);

    const a = await upload('check-3795', { total: 3795, invoice: true });
    const refused = await call(attachRoute, `/api/accounting/provisional/${je}/attach`,
      { capturedDocumentId: a }, undefined, company, { jeId: je });
    expect(refused.state.statusCode).toBe(400);
    expect(errorOf(refused).message).toMatch(/same file was already posted/i);
    expect(await postedAt(a)).toBeNull();
    expect(await provisionalState(je)).toEqual({ needs_evidence: true, source_document_id: null, line: 'provisional' });
  });

  it('deadlock, B the victim: B\'s claim commits without its attach, and A — waiting on B — is refused', async () => {
    const je = await seedProvisional(3910);
    const a = await upload('dead-3910', { total: 3910, invoice: true });
    const b = await upload('dead-3910', { total: 3910, invoice: true });
    const [ca, cb] = [await pool.connect(), await pool.connect()];
    try {
      await cb.query('BEGIN');
      await ca.query('BEGIN');
      // A waits the longest before looking for a deadlock, so B's check fires first and B is the victim.
      await ca.query("SET LOCAL deadlock_timeout = '10s'");
      // B claims its slip for an invoice: holds the file's fingerprint lock.
      expect(await inCtx(cb, () => claimCapturedDocumentForPosting(company, b, null, { spend: 'invoice' }))).toBeNull();
      // A: bank line -> journal -> document A -> fingerprint (held by B): waits.
      const attach = inCtx(ca, () => attachDocumentToProvisional(company, je, a));
      expect(await waitUntilSomeoneWaits()).toBe(true);
      // B's auto-attach reaches for the bank line A holds: a cycle, and B detects it first.
      const auto = await inCtx(cb, () => attachEvidenceToProvisional(company, b, null, 3910, today));
      expect(auto).toEqual({ attachedJeId: null, bankTxId: null });
      await cb.query('COMMIT');

      const result = await attach;
      expect(result.kind).toBe('refused');
      expect((result as { message: string }).message).toMatch(/same file was already posted/i);
      await ca.query('COMMIT');
    } finally {
      await ca.query('ROLLBACK').catch(() => undefined);
      await cb.query('ROLLBACK').catch(() => undefined);
      ca.release();
      cb.release();
    }
    expect(await postedAt(a)).toBeNull();
    expect((await provisionalState(je)).needs_evidence).toBe(true);
  }, 30_000);

  it('deadlock, A the victim: A is refused busy and writes nothing; B\'s own auto-attach evidences the provisional', async () => {
    const je = await seedProvisional(4025);
    const a = await upload('dead-4025', { total: 4025, invoice: true });
    const b = await upload('dead-4025', { total: 4025, invoice: true });
    const [ca, cb] = [await pool.connect(), await pool.connect()];
    try {
      await cb.query('BEGIN');
      await ca.query('BEGIN');
      await cb.query("SET LOCAL deadlock_timeout = '10s'");
      expect(await inCtx(cb, () => claimCapturedDocumentForPosting(company, b, null, { spend: 'invoice' }))).toBeNull();
      const attach = inCtx(ca, () => attachDocumentToProvisional(company, je, a));
      expect(await waitUntilSomeoneWaits()).toBe(true);
      const auto = inCtx(cb, () => attachEvidenceToProvisional(company, b, null, 4025, today));
      // The victim is A's wait on the fingerprint: a busy refusal, nothing written.
      const result = await attach;
      expect(result.kind).toBe('refused');
      expect((result as { message: string }).message).toMatch(/retry/i);
      await ca.query('ROLLBACK');
      expect(await auto).toMatchObject({ attachedJeId: je });
      await cb.query('COMMIT');
    } finally {
      await ca.query('ROLLBACK').catch(() => undefined);
      await cb.query('ROLLBACK').catch(() => undefined);
      ca.release();
      cb.release();
    }
    expect(await postedAt(a)).toBeNull();
    expect(await provisionalState(je)).toEqual({ needs_evidence: false, source_document_id: b, line: 'matched' });
  }, 30_000);
});

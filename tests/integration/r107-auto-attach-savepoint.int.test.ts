// R-107 review round 1 (MEDIUM) and K-157 — the AUTOMATIC evidence attach runs in
// its own savepoint.
//
// capture/[id]/post and ai-invoice-pipeline lock and claim the slip, create the
// supplier invoice, and then call attachEvidenceToProvisional best-effort, which
// UPDATEs the bank line and then the provisional journal. The manual attach takes
// bank line -> journal -> document, so the two can deadlock on the same slip. When
// the post is the victim, the auto-attach used to catch the 40P01 with no savepoint
// and "continue": the request transaction was aborted, the route answered 200, and
// withAuth's COMMIT on an aborted transaction is a silent ROLLBACK — an invoice the
// operator was told exists, gone.
//
// D11 round 3: the savepoint still protects the transaction (a SELECT works after the 40P01, no 25P02), but the
// auto-attach no longer swallows the victim: the bill would post with its own journal beside the provisional (the slip
// booked twice). It re-throws, the route answers 503 + Retry-After and withAuth rolls the whole request back.
//
// The deadlock is built by hand here so the POST side is the victim, whatever the load: the manual side waits on the
// slip FIRST (and has a 20 s deadlock_timeout), then the post's auto-attach waits on the bank line and closes the
// cycle. The cycle already exists when the post's own 1 s deadlock_timeout fires, so the post always finds it and
// aborts itself; the manual side's check is 20 s away. No step depends on how fast the other side issues its query.
import { describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { attachEvidenceToProvisional } from '@/modules/accounting/services/capture/evidenceAttachmentService';
import { attachDocumentToProvisional } from '@/modules/accounting/services/capture/provisionalEvidenceAttach';
import { lockCapturedDocumentForUpdate } from '@/modules/accounting/services/capture/captureRowLock';
import {
  company, docPostedAt, jeState, pool, seedDoc, seedProvisional, useR107Fixture, user,
} from './r107-provisional-attach.helpers';

useR107Fixture();

const today = new Date().toISOString().slice(0, 10);
// Each case seeds its own amount: the automatic match is by amount (±R0.01) and date, not by id.
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inCtx = <T>(c: PoolClient, fn: () => Promise<T>) =>
  als.run({ client: c, userId: user, companyId: company, claims: {} } as never, fn);

async function waitUntilBlocked(pid: number): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const rows = (await pool.query('SELECT pg_blocking_pids(pid) AS b FROM pg_stat_activity WHERE pid = $1', [pid]))
      .rows as Array<{ b: number[] }>;
    if ((rows[0]?.b ?? []).length > 0) return;
    await pause(25);
  }
  throw new Error(`backend ${pid} never blocked`);
}

describe('R-107 / K-157: the automatic evidence attach cannot poison the posting transaction', () => {
  it('a deadlock inside the auto-attach rolls back only the attach, is re-thrown, and the post transaction stays usable to roll back', async () => {
    const { je, bt } = await seedProvisional({ amount: 211.00 });
    const doc = await seedDoc(company);
    const post = await pool.connect();
    const manual = await pool.connect();
    try {
      await post.query('BEGIN');
      await manual.query('BEGIN');
      const manualPid = (await manual.query('SELECT pg_backend_pid() AS p')).rows[0].p as number;
      await manual.query("SET LOCAL deadlock_timeout = '20s'");
      await post.query("SET LOCAL deadlock_timeout = '1s'"); // inside the BEGIN above; = the default, set so the 20 s vs 1 s gap does not rest on it
      // The manual attach's first lock: the bank line.
      await manual.query('SELECT 1 FROM bank_transactions WHERE id=$1 FOR UPDATE', [bt]);
      // The post: slip locked and claimed.
      await inCtx(post, () => lockCapturedDocumentForUpdate(company, doc));
      await post.query('UPDATE captured_documents SET posted_at = NOW() WHERE id=$1', [doc]);
      // The manual attach reaches for the slip and waits on the post: no cycle yet.
      const manualDoc = manual.query('SELECT 1 FROM captured_documents WHERE id=$1 FOR UPDATE', [doc]);
      await waitUntilBlocked(manualPid);
      // Then the post's auto-attach (as capturePostFollowUps does) reaches for the bank line: the cycle closes here.
      const auto = inCtx(post, () => attachEvidenceToProvisional(company, doc, null, 211.00, today));

      await expect(auto).rejects.toMatchObject({ code: '40P01' });
      // The savepoint rolled the attach back alone: the post's transaction is still usable (no 25P02), so the request
      // can be rolled back cleanly and answered 503.
      await expect(post.query('SELECT 1')).resolves.toBeTruthy();
      await post.query('ROLLBACK');
      await manualDoc;
      await manual.query('ROLLBACK');
    } finally {
      await post.query('ROLLBACK').catch(() => undefined);
      await manual.query('ROLLBACK').catch(() => undefined);
      post.release();
      manual.release();
    }
    expect(await docPostedAt(doc), 'the claim rolled back with the request: a retry works').toBeNull();
    expect((await jeState(je)).needs_evidence).toBe(true);
  }, 30_000);

  it('an auto-attach that lost the journal to a manual attach does not overwrite it', async () => {
    const { je } = await seedProvisional({ amount: 333.00 });
    const manualDoc = await seedDoc(company);
    const autoDoc = await seedDoc(company);
    const manual = await pool.connect();
    const post = await pool.connect();
    try {
      await manual.query('BEGIN');
      await post.query('BEGIN');
      const postPid = (await post.query('SELECT pg_backend_pid() AS p')).rows[0].p as number;
      const attached = await inCtx(manual, () => attachDocumentToProvisional(company, je, manualDoc));
      expect(attached.kind).toBe('attached');
      // The auto-attach matched the journal while it still needed evidence, and waits on the manual attach.
      const auto = inCtx(post, () => attachEvidenceToProvisional(company, autoDoc, null, 333.00, today));
      await waitUntilBlocked(postPid);
      await manual.query('COMMIT');

      expect(await auto).toEqual({ attachedJeId: null, bankTxId: null });
      await post.query('COMMIT');
    } finally {
      await manual.query('ROLLBACK').catch(() => undefined);
      await post.query('ROLLBACK').catch(() => undefined);
      manual.release();
      post.release();
    }
    expect((await jeState(je)).source_document_id).toBe(manualDoc);
  }, 30_000);
});

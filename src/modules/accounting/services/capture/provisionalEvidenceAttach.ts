/**
 * Manual evidence attach for a bank-first provisional journal (R-107).
 *
 * `POST /api/accounting/provisional/[jeId]/attach` names the captured slip that
 * evidences a provisional journal — a journal that has ALREADY expensed the
 * bank line (DR expense / CR bank, posted by `postProvisional`). Attaching the
 * slip therefore posts it, in the only sense the capture fence cares about: a
 * second journal from the same slip would expense the same bank line again. So
 * the attach takes the same `posted_at` claim every capture posting route takes
 * (`capturePostingClaim.ts`), and refuses a slip that is already claimed or
 * rejected.
 *
 * Lock order is bank line → journal → document. The first pair is the
 * canonical order in `services/bank/.claude.md` (a pre-existing journal after
 * its bank line); the document comes last to match `reverseJournalEntry`, which
 * takes the journal and then releases the document. Two paths take the SAME
 * rows the other way round — `capture/[id]/post` (via `capturePostFollowUps`)
 * and `ai-invoice-pipeline` lock and claim the slip, then run the automatic
 * `attachEvidenceToProvisional`, which updates the bank line and the journal.
 * That cycle cannot be ordered away (the reversal pins the other end), so it is
 * made SAFE instead: whichever side Postgres picks as the 40P01 victim, the
 * outcome is an answer, not a corruption. Here the victim answers 409 with
 * nothing written; there the automatic attach runs in its own savepoint, so
 * only the attach rolls back and the post commits (tests/integration/
 * r107-auto-attach-savepoint.int.test.ts).
 *
 * Every refusal is decided before the first write, because `withAuth` COMMITs
 * a 4xx: a refusal here has written nothing.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import {
  BankTransactionLockTimeoutError,
  lockBankTransactionForUpdate,
} from '@/modules/accounting/services/bank/bankTxLock';
import { isLockContention } from '@/modules/accounting/services/core/lockContention';
import {
  CAPTURED_DOCUMENT_REFUSAL_MESSAGE,
  CaptureRowLockTimeoutError,
  claimCapturedDocumentForPosting,
  lockCapturedDocumentForUpdate,
  lockWithTimeout,
} from './captureRowLock';
import { assertDocumentNotAlreadyPosted } from '@/modules/accounting/services/gl/documentJournalClaimGuard';

export type ProvisionalAttachResult =
  | { kind: 'attached'; bankTxId: string | null }
  | { kind: 'not_found'; what: 'Journal entry' | 'Captured document'; id: string }
  | { kind: 'refused'; message: string }
  | { kind: 'contended'; message: string };

const CONTENDED = 'This journal or document is being changed by another request — retry in a moment.';

export async function attachDocumentToProvisional(
  companyId: string,
  jeId: string,
  documentId: string,
): Promise<ProvisionalAttachResult> {
  try {
    // (1) The bank line(s) first. The peek is unlocked; the UPDATE below re-checks
    // provisional_je_id, so a line unlinked while this waited for its lock is skipped. (A line
    // cannot be LINKED meanwhile: postProvisional links only the journal it has just created.)
    const lines = (await sql`
      SELECT id FROM bank_transactions
      WHERE provisional_je_id = ${jeId}::UUID AND company_id = ${companyId}::UUID
      ORDER BY id`) as DbRow[];
    for (const line of lines) await lockBankTransactionForUpdate(companyId, String(line.id));

    // (2) The journal, under the same bounded wait as the document.
    const je = await lockWithTimeout(jeId, async () => (await sql`
      SELECT needs_evidence, reversed_at FROM gl_journal_entries
      WHERE id = ${jeId}::UUID AND company_id = ${companyId}::UUID
      FOR UPDATE`) as DbRow[]);
    if (!je) return { kind: 'not_found', what: 'Journal entry', id: jeId };
    if (je.reversed_at != null) return { kind: 'refused', message: 'Journal entry has been reversed' };
    if (!je.needs_evidence) return { kind: 'refused', message: 'Journal entry is already evidenced' };

    // (3) The document, under a bounded wait (the claim UPDATE alone would wait unbounded).
    const doc = await lockCapturedDocumentForUpdate(companyId, documentId);
    if (!doc) return { kind: 'not_found', what: 'Captured document', id: documentId };
  } catch (err) {
    if (err instanceof BankTransactionLockTimeoutError || err instanceof CaptureRowLockTimeoutError
      || isLockContention(err)) {
      return { kind: 'contended', message: CONTENDED };
    }
    throw err;
  }

  // One document, one claim, at the GL write side — before the posting claim
  // below, which is itself the first write. A document already backing a
  // posted, unreversed journal (invoice, bill, another provisional) refuses here.
  await assertDocumentNotAlreadyPosted(companyId, documentId, jeId);

  // The claim: one predicated UPDATE, so a refusal (already claimed, or rejected) writes nothing.
  const claimRefusal = await claimCapturedDocumentForPosting(companyId, documentId);
  if (claimRefusal) return { kind: 'refused', message: CAPTURED_DOCUMENT_REFUSAL_MESSAGE[claimRefusal] };

  // captured_documents keeps the file hash in raw_bytes_sha256 (mig 410) and the
  // extraction confidence in extracted_data; source_document_hash and
  // extraction_confidence are gl_journal_entries columns.
  const [evidence] = (await sql`
    SELECT raw_bytes_sha256, extracted_data->>'confidence' AS confidence
    FROM captured_documents
    WHERE id = ${documentId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  const docHash = evidence?.raw_bytes_sha256 ? String(evidence.raw_bytes_sha256) : null;
  const rawConfidence = evidence?.confidence != null ? Number(evidence.confidence) : NaN;
  // NUMERIC(5,4) on the journal: anything outside [0, 1] would overflow it after the claim, so it is dropped.
  const docConfidence = rawConfidence >= 0 && rawConfidence <= 1 ? rawConfidence : null;

  const [bankRow] = (await sql`
    UPDATE bank_transactions
    SET status = 'matched'
    WHERE provisional_je_id = ${jeId}::UUID AND company_id = ${companyId}::UUID
    RETURNING id`) as DbRow[];

  await sql`
    UPDATE gl_journal_entries
    SET source_document_id    = ${documentId}::UUID,
        source_document_hash  = ${docHash},
        posting_agent         = 'ai-evidenced:v1',
        needs_evidence        = false,
        evidenced_at          = NOW(),
        extraction_confidence = COALESCE(${docConfidence}, extraction_confidence)
    WHERE id = ${jeId}::UUID AND company_id = ${companyId}::UUID`;

  return { kind: 'attached', bankTxId: bankRow ? String(bankRow.id) : null };
}

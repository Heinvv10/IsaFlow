/**
 * Adversarial round 2: does "ONE DOCUMENT, ONE CLAIM" (B2/item 1) survive an
 * unlink-then-relink across two periods?
 *
 * queryInputVatSupport computes `document_id` per chain from the journal's
 * CURRENTLY ACTIVE link (`jdl.unlinked_at IS NULL`, vatInputSupportQuery.ts
 * ~line 75-80). `doc_claims` then sums `claimed_to_date` only over rows whose
 * `document_id` resolved — i.e. only over journals that STILL carry an active
 * link (or a live `source_document_id`). The moment a link is removed, that
 * journal's real, still-posted claim silently drops out of "every chain
 * naming this document" — even though the GL entry it backed is still
 * posted, unreversed, and its VAT still stands, possibly in an
 * already-filed/locked period.
 *
 * This asserts the CORRECT behaviour: one document's VAT must never be
 * counted as support for more than its own amount, summed across EVERY
 * journal that has EVER carried an active link to it (not merely the one
 * that currently does). AT e8bfc38db this test is RED — confirmed below.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import {
  linkDocumentToJournal, unlinkDocumentFromJournal,
} from '@/modules/accounting/services/gl/journalDocumentLinkService';
import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';
import { getLedgerVAT201 } from '@/modules/accounting/services/reports/vat201LedgerFields';
import { evaluateEfilingGate } from '@/modules/accounting/services/reports/sarsEfilingSubmissionService';
import type { GLEntrySource, JournalLineInput } from '@/modules/accounting/types/gl.types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLateFixture, seedLateFixture, type LateFixture } from './helpers/vatLateClaimFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: LateFixture;

async function post(date: string, source: GLEntrySource, lines: JournalLineInput[]) {
  return inTx(fx, async () => {
    const je = await createJournalEntry(fx.companyId, {
      entryDate: date, description: `break2 ${source}`, source, lines,
    }, fx.userId);
    await postJournalEntry(fx.companyId, je.id, fx.userId);
    return je.id;
  });
}
const claim = (vat: number) => [
  { glAccountId: fx.expenseId, debit: r(vat / 0.15), credit: 0, description: 'cost', vatType: 'standard' as const },
  { glAccountId: fx.vatInputId, debit: vat, credit: 0, description: 'VAT', vatType: 'standard' as const },
  { glAccountId: fx.bankAccountId, debit: 0, credit: r(vat / 0.15 + vat), description: 'paid' },
];
function r(n: number) { return Math.round(n * 100) / 100; }
const report = (s: string, e: string) => inTx(fx, () => getVatExceptions(fx.companyId, s, e));
const ledger = (s: string, e: string) => inTx(fx, () => getLedgerVAT201(fx.companyId, s, e));

describeIfDb('VAT input-support control: unlink/relink double-claim (round 2)', () => {
  beforeAll(async () => {
    assertNotProductionDb('breaker-round2');
    fx = await seedLateFixture('BRK2', DATABASE_URL!);
    // linkDocumentToJournal/unlinkDocumentFromJournal audit-log the actor —
    // needs a real users row (audit_log.user_id FK), unlike plain postings.
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${fx.userId}, ${`brk2-${fx.userId}@isaflow.test`}, 'admin', true)`;
  }, 240000);

  afterAll(async () => {
    if (!fx) return;
    await sql`DELETE FROM audit_log WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM gl_journal_document_links WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM captured_documents WHERE company_id = ${fx.companyId}::UUID`;
    await dropLateFixture(fx);
    await sql`DELETE FROM users WHERE id = ${fx.userId}`;
  }, 120000);

  it('CORRECT BEHAVIOUR (expected to be RED at e8bfc38db): one document cannot ' +
    'support more than its own VAT summed across every journal ever linked to it, ' +
    'even after an unlink and a relink to a different journal in a later period', async () => {
    const S1 = '2028-01-01'; const E1 = '2028-02-28';
    const S2 = '2028-03-01'; const E2 = '2028-04-30';

    const doc = randomUUID();
    await sql`INSERT INTO captured_documents (id, company_id, file_name, file_type, extracted_data, status)
      VALUES (${doc}::UUID, ${fx.companyId}::UUID, 'reused-invoice.pdf', 'application/pdf',
        ${JSON.stringify({ vatAmount: 1000, totalAmount: 7666.67 })}::JSONB, 'processed')`;

    // Journal A: manual journal (no source_document_id) claims R1000 input VAT
    // in period 1, linked to the ONE document. Correctly fully supported.
    const jA = await post('2028-01-10', 'manual', claim(1000));
    await inTx(fx, () => linkDocumentToJournal(fx.companyId, jA, doc, fx.userId, 'tax invoice for January claim'));

    const repA_before = await report(S1, E1);
    expect(repA_before.unsupportedInputVat).toEqual([]);
    expect(evaluateEfilingGate(repA_before).allowed).toBe(true);
    // In real life period 1 is now filed/locked on this basis.

    // Unlink the document from A — A's journal entry is untouched: still
    // posted, still status='posted', still claiming R1000 in the ledger.
    await inTx(fx, () => unlinkDocumentFromJournal(fx.companyId, jA, doc, fx.userId, 'reassigning evidence'));
    // Link the SAME document to a brand-new journal B, claiming ANOTHER R1000
    // in period 2.
    const jB = await post('2028-03-10', 'manual', claim(1000));
    await inTx(fx, () => linkDocumentToJournal(fx.companyId, jB, doc, fx.userId, 'tax invoice for March claim'));

    const repB = await report(S2, E2);
    const ledgerA_after = await ledger(S1, E1);
    const ledgerB = await ledger(S2, E2);

    // The GL never moved: two real, still-posted claims total R2000 against
    // ONE R1000 document.
    expect(ledgerA_after.field10_totalInputVAT).toBe(1000);
    expect(ledgerB.field10_totalInputVAT).toBe(1000);
    expect(ledgerA_after.field10_totalInputVAT + ledgerB.field10_totalInputVAT).toBe(2000);

    // CORRECT: the document's R1000 cannot support R2000 across the two
    // claims that have EVER carried an active link to it — journal B's claim
    // must be flagged (over-claimed against the document) and period 2 must
    // not file clean on this basis, regardless of what unlinking did to A's
    // OWN report (A's own re-run is a separate, correct concern — this
    // asserts the cross-claim ceiling holds looking forward from B).
    expect(repB.unsupportedInputVat.map((u) => u.journalEntryId)).toContain(jB);
    expect(evaluateEfilingGate(repB).allowed).toBe(false);
  }, 60000);
});

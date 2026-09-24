// R-107 — the provisional evidence attach under contention, and the release of
// the claim it takes. Companion to r107-provisional-attach-claim.int.test.ts
// (which explains the defect); same fixture, own companies.
import { describe, expect, it } from 'vitest';
import { releaseCapturedDocumentPostingClaim } from '@/modules/accounting/services/capture/capturePostingClaimRelease';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import {
  attach, btStatus, captureAction, company, docPostedAt, holding, inTx, jeState, seedDoc, seedProvisional,
  useR107Fixture, user,
} from './r107-provisional-attach.helpers';

useR107Fixture();

describe('R-107: attach under contention', () => {
  it('two slips raced onto a journal with no bank line: the journal lock alone decides it', async () => {
    const { je } = await seedProvisional({ noBankLine: true });
    const d1 = await seedDoc(company);
    const d2 = await seedDoc(company);

    const [x, y] = await Promise.all([attach(je, d1), attach(je, d2)]);

    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 400]);
    const winner = (await jeState(je)).source_document_id;
    const loser = winner === d1 ? d2 : d1;
    expect(await docPostedAt(loser)).toBeNull();
  });

  it('answers 409 while another request holds the bank line, and claims nothing', async () => {
    const { je, bt } = await seedProvisional();
    const doc = await seedDoc(company);

    const out = await holding('SELECT 1 FROM bank_transactions WHERE id=$1 FOR UPDATE', bt, () => attach(je, doc));

    expect(out.statusCode, JSON.stringify(out.body)).toBe(409);
    expect(await docPostedAt(doc)).toBeNull();
  }, 30_000);

  it('answers 409 while another request holds the journal, and claims nothing', async () => {
    const { je } = await seedProvisional({ noBankLine: true });
    const doc = await seedDoc(company);

    const out = await holding('SELECT 1 FROM gl_journal_entries WHERE id=$1 FOR UPDATE', je, () => attach(je, doc));

    expect(out.statusCode, JSON.stringify(out.body)).toBe(409);
    expect(await docPostedAt(doc)).toBeNull();
  }, 30_000);

  it('answers 409 while another request holds the document, and evidences nothing', async () => {
    const { je, bt } = await seedProvisional();
    const doc = await seedDoc(company);

    const out = await holding('SELECT 1 FROM captured_documents WHERE id=$1 FOR UPDATE', doc, () => attach(je, doc));

    expect(out.statusCode, JSON.stringify(out.body)).toBe(409);
    expect((await jeState(je)).needs_evidence).toBe(true);
    expect(await btStatus(bt)).toBe('provisional');
  }, 30_000);

  it('drops an extraction confidence outside [0, 1] rather than overflowing the journal column', async () => {
    const { je } = await seedProvisional();
    const doc = await seedDoc(company, { confidence: 93 });

    const out = await attach(je, doc);

    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    expect(await docPostedAt(doc)).not.toBeNull();
  });
});

describe('R-107: the claim is released only when the provisional journal is', () => {
  it('confirm and reject in the capture inbox do not release a slip evidencing a live provisional journal', async () => {
    const { je } = await seedProvisional();
    const doc = await seedDoc(company);
    expect((await attach(je, doc)).statusCode).toBe(200);

    const confirm = await captureAction(doc, 'confirm');
    const reject = await captureAction(doc, 'reject');

    expect(confirm.statusCode, JSON.stringify(confirm.body)).toBe(400);
    expect(reject.statusCode, JSON.stringify(reject.body)).toBe(400);
    expect(await docPostedAt(doc)).not.toBeNull();
    expect((await jeState(je)).source_document_id).toBe(doc);
  });

  it('a generic release (e.g. a cancelled invoice on the same slip) keeps it claimed while the provisional journal stands', async () => {
    const { je } = await seedProvisional();
    const doc = await seedDoc(company);
    expect((await attach(je, doc)).statusCode).toBe(200);

    const released = await inTx(() => releaseCapturedDocumentPostingClaim(company, doc));

    expect(released).toBe(false);
    expect(await docPostedAt(doc)).not.toBeNull();
  });

  it('reversing the provisional journal releases the slip', async () => {
    const { je } = await seedProvisional();
    const doc = await seedDoc(company);
    expect((await attach(je, doc)).statusCode).toBe(200);

    await inTx(() => reverseJournalEntry(company, je, user));

    expect(await docPostedAt(doc)).toBeNull();
  });
});

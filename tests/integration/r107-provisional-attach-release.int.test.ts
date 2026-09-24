// R-107 — the provisional evidence attach under contention, and the release of
// the claim it takes. Companion to r107-provisional-attach-claim.int.test.ts
// (which explains the defect); same fixture, own companies.
import { describe, expect, it } from 'vitest';
import { releaseCapturedDocumentPostingClaim } from '@/modules/accounting/services/capture/capturePostingClaimRelease';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import {
  attach, btStatus, captureAction, company, docPostedAt, holding, inTx, jeState, pool, seedDoc, seedProvisional,
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

  it('the inbox refuses BEFORE it discards drafts: a draft journal on the slip survives the refused confirm', async () => {
    const { je } = await seedProvisional();
    const doc = await seedDoc(company);
    expect((await attach(je, doc)).statusCode).toBe(200);
    // Not reachable through the product today (a claimed slip cannot be posted again); seeded by
    // hand to pin the ORDER: the refusal must be decided before the DELETE, because the route's
    // 400 is COMMITted by withAuth and would carry the discard with it.
    const draft = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_journal_entries(id,company_id,entry_date,description,source,status,created_by,source_document_id)
       VALUES($1,$2,CURRENT_DATE,'R107 receipt draft','auto_expense_receipt','draft',$3,$4)`,
      [draft, company, user, doc]);

    const confirm = await captureAction(doc, 'confirm');

    expect(confirm.statusCode, JSON.stringify(confirm.body)).toBe(400);
    expect((await pool.query('SELECT 1 FROM gl_journal_entries WHERE id=$1', [draft])).rowCount).toBe(1);
    expect(await docPostedAt(doc)).not.toBeNull();
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

describe('R-107: a reversal racing an attach', () => {
  it('releases the slip an attach committed while the reversal waited on the journal', async () => {
    const { je } = await seedProvisional();
    const doc = await seedDoc(company);
    // The attach, by hand and uncommitted: it holds the journal row.
    const attacher = await pool.connect();
    let reversal: Promise<unknown> | undefined;
    try {
      await attacher.query('BEGIN');
      await attacher.query(
        `UPDATE gl_journal_entries SET source_document_id=$2, needs_evidence=false, evidenced_at=NOW() WHERE id=$1`,
        [je, doc]);
      await attacher.query('UPDATE captured_documents SET posted_at=NOW() WHERE id=$1', [doc]);
      const pid = (await attacher.query('SELECT pg_backend_pid() AS p')).rows[0].p as number;
      // The reversal reads the journal (no document yet) and then waits on its claim.
      reversal = inTx(() => reverseJournalEntry(company, je, user));
      for (let i = 0; i < 200; i += 1) {
        const rows = (await pool.query(
          'SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows;
        if (rows.length > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await attacher.query('COMMIT');
    } finally {
      await attacher.query('ROLLBACK').catch(() => undefined);
      attacher.release();
    }
    await reversal;

    expect(await docPostedAt(doc)).toBeNull();
  }, 30_000);
});


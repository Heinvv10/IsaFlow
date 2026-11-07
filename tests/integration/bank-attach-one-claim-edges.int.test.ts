/**
 * Bank-attach VAT guard (captureBankTxAttachService / bankAttachClaimConflict): each condition of "a different VAT
 * claim", one case at a time, plus the relink that moves a document and the tenant boundary.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { unlinkDocumentFromJournal } from '@/modules/accounting/services/gl/journalDocumentLinkService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx, runOn } from './helpers/l1FifoFixture';
import { attachCapturedDocToBankTx } from '@/modules/accounting/services/capture/captureBankTxAttachService';
import {
  attach, billFor, claim, expenseClaimFor, line, lineJournal, linkedTo, setUpAttachGuard, slip, tearDownAttachGuard,
  type AttachGuard,
} from './helpers/attachGuardFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Bank-attach VAT guard: what counts as a different VAT claim', () => {
  let h: AttachGuard;
  let other: AttachGuard;
  beforeAll(async () => {
    assertNotProductionDb('This test posts journals, allocates bank lines and attaches documents.');
    h = await setUpAttachGuard('ATTACHEDGE', DATABASE_URL!);
    other = await setUpAttachGuard('ATTACHOTHER', DATABASE_URL!);
  }, 120000);
  afterAll(async () => { await tearDownAttachGuard(h); await tearDownAttachGuard(other); }, 120000);

  it('an unlinked document link is no claim', async () => {
    const d = await slip(h);
    const j1 = await claim(h, d, 'link');
    await inTx(h.fx, () => unlinkDocumentFromJournal(h.fx.companyId, j1, d, h.fx.userId, 'Wrong journal'));
    expect((await attach(h, d, await line(h, 'vat'))).ok).toBe(true);
  });

  it('a draft journal naming the document is no claim yet', async () => {
    const d = await slip(h);
    await claim(h, d, 'source', { draft: true });
    expect((await attach(h, d, await line(h, 'vat'))).ok).toBe(true);
  });

  it('a journal that credits input VAT (a reduction) is no claim', async () => {
    const d = await slip(h);
    await claim(h, d, 'source', { vat: -15 });
    expect((await attach(h, d, await line(h, 'vat'))).ok).toBe(true);
  });

  it('a draft bill is no claim yet; one pending approval is', async () => {
    const d = await slip(h);
    await billFor(h, d, { status: 'draft' });
    expect((await attach(h, d, await line(h, 'vat'))).ok).toBe(true);
    const d2 = await slip(h);
    const pending = await billFor(h, d2, { status: 'pending_approval' });
    expect(await attach(h, d2, await line(h, 'vat'))).toMatchObject({ ok: false, otherClaim: { kind: 'bill', id: pending } });
  });

  it('a draft or cancelled expense claim is no claim; a posted one is', async () => {
    for (const status of ['draft', 'cancelled']) {
      const d = await slip(h);
      await expenseClaimFor(h, d, status);
      expect((await attach(h, d, await line(h, 'vat'))).ok).toBe(true);
    }
    const d = await slip(h);
    const posted = await expenseClaimFor(h, d, 'posted', await claim(h));
    expect(await attach(h, d, await line(h, 'vat'))).toMatchObject({ ok: false, otherClaim: { kind: 'expense_claim', id: posted } });
  });

  it('a bill or expense claim whose own journal IS the line\'s journal is the same claim, not another', async () => {
    const d = await slip(h);
    const txId = await line(h, 'vat');
    await billFor(h, d, { journalId: await lineJournal(txId) });
    expect((await attach(h, d, txId)).ok).toBe(true);
    const d2 = await slip(h);
    const tx2 = await line(h, 'vat');
    await expenseClaimFor(h, d2, 'posted', await lineJournal(tx2));
    expect((await attach(h, d2, tx2)).ok).toBe(true);
  });

  it('relinking moves the document: it is never on two lines at once', async () => {
    const d = await slip(h);
    const first = await line(h, 'vat');
    const second = await line(h, 'vat');
    expect((await attach(h, d, first)).ok).toBe(true);
    expect((await attach(h, d, second)).ok).toBe(true);
    expect(await linkedTo(d)).toBe(second);
  });

  it('two attaches racing to different lines: the later one still removes the copy the first left behind', async () => {
    const d = await slip(h);
    const a = await line(h, 'none');
    const b = await line(h, 'none');
    // First attach (to A) holds its transaction open, writing its copy itself (the fixture has no stored bytes).
    const c1 = await h.fx.pool.connect();
    await c1.query('BEGIN');
    await runOn(h.fx, c1, () => attachCapturedDocToBankTx(h.fx.companyId, d, a, h.fx.userId));
    await c1.query(`INSERT INTO bank_transaction_attachments (bank_transaction_id, file_name, file_url)
      VALUES ($1, $2, 'data:application/pdf;base64,JVBERi0=')`, [a, `${d}_slip.pdf`]);
    const second = attach(h, d, b); // waits on the document lock
    await new Promise((r) => setTimeout(r, 300));
    await c1.query('COMMIT');
    c1.release();
    expect((await second).ok).toBe(true);
    expect(await linkedTo(d)).toBe(b);
    expect(((await sql`SELECT COUNT(*)::INT AS n FROM bank_transaction_attachments WHERE bank_transaction_id = ${a}::UUID`) as { n: number }[])[0]!.n).toBe(0);
  });

  it('another company\'s records never count, even when they name this document', async () => {
    const d = await slip(h);
    // Forged rows in the other company pointing at this company's document id.
    const bill = await billFor(other, await slip(other), {});
    await sql`UPDATE supplier_invoices SET source_document_id = ${d}::UUID WHERE id = ${bill}::UUID`;
    const theirs = await claim(other);
    await sql`UPDATE gl_journal_entries SET source_document_id = ${d}::UUID WHERE id = ${theirs}::UUID`;
    expect((await attach(h, d, await line(h, 'vat'))).ok).toBe(true);
  });
});

/**
 * One tax invoice, one VAT claim, at the moment a captured document is attached to a bank line (Hein, 2026-11-07).
 *
 * Refused: the line's journal claims input VAT and the document already backs a DIFFERENT VAT claim — a posted,
 * standing journal (source_document_id or an active link), a live bill with VAT, a live expense claim line with VAT.
 * Allowed: proof of payment (the line claims no VAT, or is not allocated yet), the line's OWN journal (a receipt
 * matched to its payment, a provisional journal), and a claim that no longer stands (reversed, cancelled, rejected).
 * Edge cases: bank-attach-one-claim-edges.int.test.ts; late claims and the audit script: -late-audit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import {
  attach, billFor, claim, expenseClaimFor, line, linkedTo, matchLineTo, setUpAttachGuard, slip, tearDownAttachGuard,
  type AttachGuard, type Row,
} from './helpers/attachGuardFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Attaching a captured document to a bank line: one tax invoice, one VAT claim', () => {
  let h: AttachGuard;
  beforeAll(async () => {
    assertNotProductionDb('This test posts journals, allocates bank lines and attaches documents.');
    h = await setUpAttachGuard('ATTACHONE', DATABASE_URL!);
  }, 120000);
  afterAll(async () => { await tearDownAttachGuard(h); }, 120000);

  for (const by of ['link', 'source'] as const) {
    it(`refuses a slip that backs J1 (${by}) on a line whose own journal claims VAT, writing nothing`, async () => {
      const d = await slip(h);
      const j1 = await claim(h, d, by);
      const txId = await line(h, 'vat');
      const r = await attach(h, d, txId);
      expect(r).toMatchObject({ ok: false, reason: 'document_backs_other_claim', otherClaim: { kind: 'journal', id: j1 } });
      expect(await linkedTo(d)).toBeNull();
      expect(((await sql`SELECT COUNT(*)::INT AS n FROM bank_transaction_attachments WHERE bank_transaction_id = ${txId}::UUID`) as Row[])[0]!.n).toBe(0);
    });
  }

  it('allows it as proof of payment: a line claiming no VAT, or not allocated yet', async () => {
    const d = await slip(h);
    await claim(h, d);
    expect((await attach(h, d, await line(h, 'plain'))).ok).toBe(true);
    const d2 = await slip(h);
    await claim(h, d2);
    expect((await attach(h, d2, await line(h, 'none'))).ok).toBe(true);
  });

  it('allows the line\'s OWN journal: a receipt matched to its payment, and a provisional journal', async () => {
    const d = await slip(h);
    const matched = await line(h, 'none');
    await matchLineTo(matched, await claim(h, d, 'source'));
    expect((await attach(h, d, matched)).ok).toBe(true);
    const d2 = await slip(h);
    const provisional = await line(h, 'none');
    await sql`UPDATE bank_transactions SET provisional_je_id = ${await claim(h, d2, 'source')}::UUID WHERE id = ${provisional}::UUID`;
    expect((await attach(h, d2, provisional)).ok).toBe(true);
  });

  it('refuses on a provisional line whose journal claims VAT when the slip backs ANOTHER journal', async () => {
    const d = await slip(h);
    const j1 = await claim(h, d);
    const provisional = await line(h, 'none');
    await sql`UPDATE bank_transactions SET provisional_je_id = ${await claim(h)}::UUID WHERE id = ${provisional}::UUID`;
    expect(await attach(h, d, provisional)).toMatchObject({ ok: false, otherClaim: { kind: 'journal', id: j1 } });
  });

  it('allows a slip whose other claim was reversed', async () => {
    const d = await slip(h);
    const j1 = await claim(h, d);
    await inTx(h.fx, () => reverseJournalEntry(h.fx.companyId, j1, h.fx.userId));
    expect((await attach(h, d, await line(h, 'vat'))).ok).toBe(true);
  });

  for (const by of ['source', 'matched'] as const) {
    it(`refuses a live bill's slip (${by}) with VAT, and allows it once the bill is cancelled`, async () => {
      const d = await slip(h);
      const bill = await billFor(h, d, { by });
      const txId = await line(h, 'vat');
      expect(await attach(h, d, txId)).toMatchObject({ ok: false, otherClaim: { kind: 'bill', id: bill } });
      await sql`UPDATE supplier_invoices SET status = 'cancelled' WHERE id = ${bill}::UUID`;
      expect((await attach(h, d, txId)).ok).toBe(true);
    });
  }

  it('allows a bill\'s slip with no VAT on the bill', async () => {
    const d = await slip(h);
    await billFor(h, d, { tax: 0 });
    expect((await attach(h, d, await line(h, 'vat'))).ok).toBe(true);
  });

  it('refuses an expense claim line\'s slip with VAT, and allows it once the claim is rejected', async () => {
    const d = await slip(h);
    const claimId = await expenseClaimFor(h, d);
    const txId = await line(h, 'vat');
    expect(await attach(h, d, txId)).toMatchObject({ ok: false, otherClaim: { kind: 'expense_claim', id: claimId } });
    await sql`UPDATE expense_claims SET status = 'rejected' WHERE id = ${claimId}::UUID`;
    expect((await attach(h, d, txId)).ok).toBe(true);
  });

  it('a slip with no other claim attaches to a VAT line as before', async () => {
    expect((await attach(h, await slip(h), await line(h, 'vat'))).ok).toBe(true);
  });
});

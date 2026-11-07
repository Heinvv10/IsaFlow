/**
 * One tax invoice backs one claim's worth of VAT (Hein, 2026-11-07): bills, expense claim lines, split payments,
 * several documents on one line, the document's own VAT, and the period edges.
 *
 * Every use of a captured document adds to its claimed total: a bill (supplier_invoices.source_document_id or the
 * capture's matched_invoice_id) adds its journal's claim; an expense claim line adds that LINE's VAT. The cap is the
 * document's VAT, so one invoice paid from two bank lines is fine and the same invoice claimed twice is not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import {
  bankClaim, billOn, claim, expenseClaimOn, linkToLine, setUpOneClaim, slip, tearDownOneClaim, verdict, type OneClaim,
} from './helpers/oneClaimFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const OVER = 'block:document_over_claimed';

describeIfDb('VAT input support: one tax invoice, one claim (every use of a document)', () => {
  let h: OneClaim;
  beforeAll(async () => {
    assertNotProductionDb('This test posts journals, allocates bank lines and links documents.');
    h = await setUpOneClaim('DOCUSES', DATABASE_URL!);
  }, 120000);
  afterAll(async () => { await tearDownOneClaim(h); }, 120000);

  for (const by of ['source', 'matched'] as const) {
    it(`a bill's slip (${by}) on another journal's bank line over-claims that journal`, async () => {
      const { txId, journalId } = await bankClaim(h);
      const d = await slip(h);
      await billOn(h, await claim(h), d, by);
      expect(await verdict(h, journalId)).toBe('warn:no_tax_invoice');
      await linkToLine(d, txId);
      expect(await verdict(h, journalId)).toBe(OVER);
    });
  }

  it('a bill\'s slip also linked to a hand journal over-claims the hand journal', async () => {
    const d = await slip(h);
    await billOn(h, await claim(h), d, 'source');
    expect(await verdict(h, await claim(h, { doc: d, by: 'link' }))).toBe(OVER);
  });

  it('an expense claim line\'s slip on a bank line over-claims both the bank journal and the claim', async () => {
    const { txId, journalId } = await bankClaim(h);
    const d = await slip(h);
    const other = await slip(h);
    const claimJe = await claim(h, { vat: 30 });
    await expenseClaimOn(h, claimJe, [{ doc: d, vat: 15 }, { doc: other, vat: 15 }]);
    expect(await verdict(h, claimJe)).toBe('ok');
    await linkToLine(d, txId);
    expect(await verdict(h, journalId)).toBe(OVER);
    expect(await verdict(h, claimJe)).toBe(OVER);
  });

  it('a reversed expense claim no longer uses its slips', async () => {
    const { txId, journalId } = await bankClaim(h);
    const d = await slip(h);
    const claimJe = await claim(h);
    await expenseClaimOn(h, claimJe, [{ doc: d, vat: 15 }]);
    await linkToLine(d, txId);
    expect(await verdict(h, journalId)).toBe(OVER);
    await inTx(h.fx, () => reverseJournalEntry(h.fx.companyId, claimJe, h.fx.userId));
    expect(await verdict(h, journalId)).toBe('ok');
  });

  it('an expense claim adds only its line\'s VAT: the claim\'s other lines do not count against the slip', async () => {
    const d = await slip(h, { vat: 30 });
    const claimJe = await claim(h, { vat: 45 });
    await expenseClaimOn(h, claimJe, [{ doc: d, vat: 15 }, { doc: null, vat: 30 }]);
    const { txId, journalId } = await bankClaim(h); // 15 more on the same R30 invoice: 30 in all
    await linkToLine(d, txId);
    expect(await verdict(h, journalId)).toBe('ok');
    expect(await verdict(h, claimJe)).toBe('ok');
  });

  it('one R30 invoice behind two R15 claims is one claim\'s worth, not two; a third R15 tips it over', async () => {
    const d = await slip(h, { vat: 30 });
    const { txId, journalId } = await bankClaim(h);
    await linkToLine(d, txId);
    const j1 = await claim(h, { doc: d, by: 'link' });
    expect(await verdict(h, journalId)).toBe('ok');
    expect(await verdict(h, j1)).toBe('ok');
    await billOn(h, await claim(h), d, 'source'); // the write guards refuse a second journal tie; a bill is not checked
    expect(await verdict(h, journalId)).toBe(OVER);
    expect(await verdict(h, j1)).toBe(OVER);
  });

  it('two slips on one line: the free one supports the claim the used one cannot', async () => {
    const { txId, journalId } = await bankClaim(h);
    const used = await slip(h);
    await claim(h, { doc: used, by: 'link' });
    await linkToLine(used, txId);
    expect(await verdict(h, journalId)).toBe(OVER);
    await linkToLine(await slip(h), txId);
    expect(await verdict(h, journalId)).toBe('ok');
  });

  it('the slip\'s own VAT caps the bank claim; a slip with no VAT read is presence only; unreadable VAT warns', async () => {
    const low = await bankClaim(h);
    await linkToLine(await slip(h, { vat: 10 }), low.txId);
    expect(await verdict(h, low.journalId)).toBe('block:amount_mismatch');
    const none = await bankClaim(h);
    await linkToLine(await slip(h, { vat: null }), none.txId);
    expect(await verdict(h, none.journalId)).toBe('ok');
    const unreadable = await bankClaim(h);
    await linkToLine(await slip(h, { vat: 'R fifteen' }), unreadable.txId);
    expect(await verdict(h, unreadable.journalId)).toBe('warn:unreadable_document_vat');
  });

  it('a claim on the slip from an EARLIER period still counts (claimed to date, not in the period)', async () => {
    const { txId, journalId } = await bankClaim(h);
    const d = await slip(h);
    await claim(h, { doc: d, by: 'link', entryDate: '2026-06-10' });
    await linkToLine(d, txId);
    expect(await verdict(h, journalId)).toBe(OVER);
  });

  it('a reuse dated AFTER the period is flagged in its own period, not retroactively', async () => {
    const { txId, journalId } = await bankClaim(h);
    const d = await slip(h);
    await linkToLine(d, txId);
    const late = await claim(h, { doc: d, by: 'link', entryDate: '2026-09-05' });
    expect(await verdict(h, journalId)).toBe('ok');
    expect(await verdict(h, late, '2026-09-01', '2026-09-30')).toBe(OVER);
  });
});

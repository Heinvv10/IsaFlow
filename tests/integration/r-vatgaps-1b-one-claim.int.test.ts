/**
 * One tax invoice backs one claim's worth of VAT (Hein, 2026-11-07): journal ties against bank lines.
 *
 * A captured document D is USED by every claim tied to it: a journal through source_document_id or a link (active
 * or unlinked), and the journal on any bank line D sits on (linked, or as its copy). The claims of every use, to the
 * period end, may not exceed D's VAT: when they do, every chain judged on D is `document_over_claimed`, in both
 * directions. A plain upload is presence only. A late-claim companion's claims add to its original's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { linkDocumentToJournal, unlinkDocumentFromJournal } from '@/modules/accounting/services/gl/journalDocumentLinkService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import {
  bankClaim, claim, copyOnLine, linkToLine, setUpOneClaim, slip, tearDownOneClaim, verdict, type OneClaim,
} from './helpers/oneClaimFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const OVER = 'block:document_over_claimed';

describeIfDb('VAT input support: one tax invoice, one claim (journal ties and bank lines)', () => {
  let h: OneClaim;
  beforeAll(async () => {
    assertNotProductionDb('This test posts journals, allocates bank lines and links documents.');
    h = await setUpOneClaim('ONECLAIM', DATABASE_URL!);
  }, 120000);
  afterAll(async () => { await tearDownOneClaim(h); }, 120000);

  for (const by of ['link', 'source'] as const) {
    it(`a slip on the line that also backs J1 (${by}) over-claims both, until J1 is reversed`, async () => {
      const { txId, journalId } = await bankClaim(h);
      const d = await slip(h);
      const j1 = await claim(h, { doc: d, by });
      expect(await verdict(h, journalId)).toBe('warn:no_tax_invoice'); // not on the line yet
      expect(await verdict(h, j1)).toBe('ok');
      await linkToLine(d, txId);
      expect(await verdict(h, journalId)).toBe(OVER);
      expect(await verdict(h, j1)).toBe(OVER);
      await inTx(h.fx, () => reverseJournalEntry(h.fx.companyId, j1, h.fx.userId));
      expect(await verdict(h, journalId)).toBe('ok');
    });
  }

  it('a slip\'s copy on the line is the same use (a slip with no stored bytes counts only through its copy)', async () => {
    const { txId, journalId } = await bankClaim(h);
    const d = await slip(h, { stored: false });
    const j1 = await claim(h, { doc: d, by: 'link' });
    await linkToLine(d, txId);
    expect(await verdict(h, journalId)).toBe('warn:no_tax_invoice'); // no bytes, no copy: not on the line
    await copyOnLine(d, txId);
    expect(await verdict(h, journalId)).toBe(OVER);
    await inTx(h.fx, () => reverseJournalEntry(h.fx.companyId, j1, h.fx.userId));
    expect(await verdict(h, journalId)).toBe('ok');
  });

  it('the copy of a rejected slip supports nothing, as the slip itself would not', async () => {
    const { txId, journalId } = await bankClaim(h);
    const d = await slip(h, { stored: false });
    await linkToLine(d, txId);
    await copyOnLine(d, txId);
    expect(await verdict(h, journalId)).toBe('ok');
    await sql`UPDATE captured_documents SET status = 'rejected' WHERE id = ${d}::UUID`;
    expect(await verdict(h, journalId)).toBe('warn:no_tax_invoice');
  });

  it('an unlinked link row on J1 still counts: J1\'s claim stands on the slip it once had', async () => {
    const { txId, journalId } = await bankClaim(h);
    const d = await slip(h);
    const j1 = await claim(h, { doc: d, by: 'link' });
    await inTx(h.fx, () => unlinkDocumentFromJournal(h.fx.companyId, j1, d, h.fx.userId, 'Moved'));
    await linkToLine(d, txId);
    expect(await verdict(h, journalId)).toBe(OVER);
  });

  for (const via of ['link', 'copy'] as const) {
    it(`a slip once linked to the bank line's OWN journal is one use, not two (${via})`, async () => {
      const { txId, journalId } = await bankClaim(h);
      const d = await slip(h, { stored: via === 'link' });
      await inTx(h.fx, () => linkDocumentToJournal(h.fx.companyId, journalId, d, h.fx.userId, 'Slip for J2'));
      await inTx(h.fx, () => unlinkDocumentFromJournal(h.fx.companyId, journalId, d, h.fx.userId, 'Moved to the bank line'));
      await linkToLine(d, txId);
      if (via === 'copy') await copyOnLine(d, txId);
      expect(await verdict(h, journalId)).toBe('ok');
    });
  }

  for (const [docVat, expected] of [[20, 'ok'], [15, OVER]] as const) {
    it(`a late-claim companion's claim adds to its original's on the same slip (slip VAT ${docVat})`, async () => {
      const { txId, journalId } = await bankClaim(h);
      const d = await slip(h, { vat: docVat });
      await linkToLine(d, txId);
      const companion = await inTx(h.fx, async () => {
        const je = await createJournalEntry(h.fx.companyId, {
          entryDate: '2026-07-20', description: 'late claim of J2', source: 'manual',
          lines: [{ glAccountId: h.vatAcc, debit: 5, credit: 0 }, { glAccountId: h.expenseAcc, debit: 0, credit: 5 }],
        }, h.fx.userId);
        await postJournalEntry(h.fx.companyId, je.id, h.fx.userId);
        return je.id;
      });
      await sql`UPDATE gl_journal_entries SET late_claim_of_id = ${journalId}::UUID WHERE id = ${companion}::UUID`;
      expect(await verdict(h, journalId)).toBe(expected);
    });
  }

  it('a plain upload is presence only, even beside a slip that backs another claim', async () => {
    const { txId, journalId } = await bankClaim(h);
    expect(await verdict(h, journalId)).toBe('warn:no_tax_invoice');
    await sql`INSERT INTO bank_transaction_attachments (bank_transaction_id, file_name, file_url)
      VALUES (${txId}::UUID, 'till-slip.png', 'data:image/png;base64,iVBORw0KGgo=')`;
    expect(await verdict(h, journalId)).toBe('ok');
    const d = await slip(h);
    await claim(h, { doc: d, by: 'link' });
    await linkToLine(d, txId);
    expect(await verdict(h, journalId)).toBe(OVER);
  });
});

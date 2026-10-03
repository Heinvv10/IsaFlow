/**
 * D8 round 6 (adversarial pass 2, brk-d8b F3): the PERMITTING guards — document link, automatic and manual
 * evidence attach — read `journalStandsUnbrokenFragment`, which sees a broken ROOT only (stamped reversed with
 * no posted contra). A chain broken further down (the head of O <- R <- R2 stamped with no contra) or a
 * three-entry loop passed, and evidence landed on a journal every reversal flow refuses as broken. Each
 * service now walks the chain and refuses a broken one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { linkDocumentToJournal } from '@/modules/accounting/services/gl/journalDocumentLinkService';
import { attachEvidenceToProvisional } from '@/modules/accounting/services/capture/evidenceAttachmentService';
import { attachDocumentToProvisional } from '@/modules/accounting/services/capture/provisionalEvidenceAttach';
import { findJournalChainHead } from '@/modules/accounting/services/shared/journalChainHead';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import { buildChain, provisional, settle, setup, teardown, type Ctx } from './d8-r4-helpers';

let c: Ctx;
type Row = Record<string, unknown>;
const documentId = async () => String(((await sql`
  INSERT INTO captured_documents (company_id, file_name, file_type, status, document_type)
  VALUES (${c.fx.companyId}::UUID, ${`d8r6-p-${++c.seq}.pdf`}, 'application/pdf', 'reviewed', 'supplier_invoice')
  RETURNING id`) as Row[])[0]!.id);

const shapes: Record<string, (x: string) => Promise<void>> = {
  'orphan stamp on the head of a re-reversed chain': async (x) => {
    const ch = await buildChain(c, x, 2);
    await sql`UPDATE gl_journal_entries SET reversed_at = NOW() WHERE id = ${ch[2]!}::UUID`;
  },
  'three-entry loop': async (x) => {
    const ch = await buildChain(c, x, 2);
    await sql`UPDATE gl_journal_entries SET reversal_of_id = ${ch[2]!}::UUID WHERE id = ${x}::UUID`;
    await sql`UPDATE gl_journal_entries SET reversed_at = NOW() WHERE id = ${ch[2]!}::UUID`;
  },
};

/** A provisional on a predicted supplier, its chain forged into `shape`. */
async function brokenProvisional(shape: string, amount: number) {
  const pv = await provisional(c, amount);
  await sql`UPDATE bank_transactions SET predicted_supplier_id = ${c.fx.supplierId}::UUID WHERE id = ${pv.bt}::UUID`;
  await shapes[shape]!(pv.je);
  expect((await findJournalChainHead(c.fx.companyId, pv.je))?.kind).toBe('broken');
  return pv;
}
const needsEvidence = async (je: string) => ((await sql`
  SELECT needs_evidence FROM gl_journal_entries WHERE id = ${je}::UUID`) as Row[])[0]!.needs_evidence;

describe.skipIf(!process.env.DATABASE_URL)('D8 round 6: the permitting guards refuse a chain broken below its root', () => {
  beforeAll(async () => {
    assertNotProductionDb('D8 round 6 broken permit');
    c = await setup('D8R6P');
  }, 120000);
  afterAll(async () => { await teardown(c); }, 120000);

  for (const shape of Object.keys(shapes)) {
    it(`${shape}: the document link refuses, naming the reversal chain`, async () => {
      const pv = await brokenProvisional(shape, 500 + (++c.seq));
      const r = await settle(inTx(c.fx, async () =>
        linkDocumentToJournal(c.fx.companyId, pv.je, await documentId(), c.fx.userId, 'd8 r6')));
      expect(JSON.stringify(r)).toMatch(/JournalDocumentLinkRefusal.*reversal chain/);
    });

    it(`${shape}: the automatic attach evidences nothing`, async () => {
      const amount = 1500 + (++c.seq);
      const pv = await brokenProvisional(shape, amount);
      const r = await inTx(c.fx, async () => attachEvidenceToProvisional(
        c.fx.companyId, await documentId(), c.fx.supplierId, amount, '2026-05-15'));
      expect(r.attachedJeId).toBeNull();
      expect(await needsEvidence(pv.je)).toBe(true);
      expect(((await sql`SELECT status FROM bank_transactions WHERE id = ${pv.bt}::UUID`) as Row[])[0]!.status).toBe('provisional');
    });

    it(`${shape}: the manual attach refuses, naming the reversal chain`, async () => {
      const pv = await brokenProvisional(shape, 2500 + (++c.seq));
      const r = await inTx(c.fx, async () => attachDocumentToProvisional(c.fx.companyId, pv.je, await documentId()));
      expect(r).toMatchObject({ kind: 'refused' });
      expect(JSON.stringify(r)).toMatch(/reversal chain/);
      expect(await needsEvidence(pv.je)).toBe(true);
    });
  }
});

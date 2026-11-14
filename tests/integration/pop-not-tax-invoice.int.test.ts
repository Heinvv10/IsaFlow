/**
 * A proof of payment attached to a bank line is evidence a person sees (the paperclip counts it), but it is not a
 * tax invoice (bank/bankLineDocumentSql.hasBankLineDocumentSql): a line whose journal claims input VAT and whose
 * only document is a POP still reads `no_tax_invoice` in VAT input support and stays on the unsupported-transactions
 * list, whether the POP is linked with a copy on the line or linked only. A supplier slip on the same kind of line
 * is the control: it supports the line.
 *
 * Fixture route: isaflow_test (assertNotProductionDb).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import { attach, line, lineJournal, setUpAttachGuard, slip, tearDownAttachGuard, type AttachGuard, type Row } from './helpers/attachGuardFixture';

vi.mock('@/lib/documentStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documentStorage')>()),
  fetchRawBytes: vi.fn(async () => {
    const buffer = Buffer.from('%PDF-1.4 stub');
    return { buffer, hash: 'h', storedHash: 'h', size: buffer.length, fileType: 'application/pdf' };
  }),
}));

import { findInputVatSupport } from '@/modules/accounting/services/reports/vatInputSupport';
import { listTransactionsWithoutDocuments } from '@/modules/accounting/services/core/documentQueryService';
import { attachmentCountSql } from '@/modules/accounting/services/bank/bankLineDocumentSql';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('A proof of payment on a bank line is not a tax invoice', () => {
  let h: AttachGuard;
  beforeAll(async () => {
    assertNotProductionDb('This test posts journals, allocates bank lines and attaches documents.');
    h = await setUpAttachGuard('POPNOTTAX', DATABASE_URL!);
  }, 120000);
  afterAll(async () => { await tearDownAttachGuard(h); }, 120000);

  const pop = async (): Promise<string> => String(((await sql`
    INSERT INTO captured_documents (company_id, file_name, file_type, status, document_type, storage_bucket, storage_path)
    VALUES (${h.fx.companyId}::UUID, 'ABSA POP 80X.pdf', 'application/pdf', 'processed', 'proof_of_payment',
      'captured-documents', ${`${h.fx.companyId}/pop-${randomUUID()}.pdf`})
    RETURNING id`) as Row[])[0]!.id);

  const verdict = async (txId: string) => {
    const je = await lineJournal(txId);
    const support = await inTx(h.fx, () => findInputVatSupport(h.fx.companyId, '2026-07-01', '2026-07-31'));
    const unsupported = await inTx(h.fx, () => listTransactionsWithoutDocuments(h.fx.companyId,
      { from: '2026-07-01', to: '2026-07-31', minAmount: 0, limit: 500 }));
    const [count] = (await sql`SELECT ${sql.unsafe(attachmentCountSql('bt'))} AS n FROM bank_transactions bt WHERE bt.id = ${txId}::UUID`) as Row[];
    return {
      noTaxInvoice: support.withoutTaxInvoice.some((l) => l.journalEntryId === je && l.reason === 'no_tax_invoice'),
      blocking: support.unsupported.some((l) => l.journalEntryId === je),
      onUnsupportedList: unsupported.rows.some((r) => r.id === txId),
      paperclip: Number(count!.n),
    };
  };

  it('a POP with its copy on the line, and then linked only, leaves the line unsupported but on the paperclip', async () => {
    const txId = await line(h, 'vat');
    expect(await verdict(txId)).toEqual({ noTaxInvoice: true, blocking: false, onUnsupportedList: true, paperclip: 0 });

    const d = await pop();
    expect(await attach(h, d, txId)).toEqual({ ok: true, mirrored: true });
    expect(await verdict(txId)).toEqual({ noTaxInvoice: true, blocking: false, onUnsupportedList: true, paperclip: 1 });

    // Linked only (as a POP over the 2 MB copy cap would be): still not support, still counted once.
    await sql`DELETE FROM bank_transaction_attachments WHERE bank_transaction_id = ${txId}::UUID`;
    expect(await verdict(txId)).toEqual({ noTaxInvoice: true, blocking: false, onUnsupportedList: true, paperclip: 1 });
  });

  it('control: a supplier slip on the same kind of line supports it', async () => {
    const txId = await line(h, 'vat');
    expect((await attach(h, await slip(h), txId)).ok).toBe(true);
    expect(await verdict(txId)).toEqual({ noTaxInvoice: false, blocking: false, onUnsupportedList: false, paperclip: 1 });
    await sql`DELETE FROM bank_transaction_attachments WHERE bank_transaction_id = ${txId}::UUID`;
    expect(await verdict(txId)).toMatchObject({ noTaxInvoice: false, onUnsupportedList: false });
  });
});

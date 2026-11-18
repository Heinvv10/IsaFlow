// Settled-document evidence on bank lines (bank/settledDocumentSql, bank/settledDocumentService), against real
// Postgres: full, partial, multi-bill, credit-note offset, unapplied payment, expense-coded, hand match off the bank
// account, cancelled payment, customer receipt with a source capture, and the other company's line.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { isSettledCapturedDocument, listSettledDocuments } from '@/modules/accounting/services/bank/settledDocumentService';
import { listTransactionsWithoutDocuments } from '@/modules/accounting/services/core/documentQueryService';
import { dropSettledFixture, seedSettledFixture, type SettledFixture } from './bank-settled-evidence.helpers';

const url = process.env.DATABASE_URL ?? '';
const describeIfDb = url && !url.includes('dummy') ? describe : describe.skip;
const pool = new Pool({ connectionString: url });
let f: SettledFixture;

const ids = (rows: { documentId: string }[]) => rows.map((r) => r.documentId).sort();

describeIfDb('bank line settled-document evidence', () => {
  beforeAll(async () => { f = await seedSettledFixture(pool); });
  afterAll(async () => {
    try { if (f) await dropSettledFixture(pool, f); } finally { await pool.end(); }
  });

  it('multi-bill full payment: both bills\' PDFs, via the payment, not part-paid, PO paperwork excluded', async () => {
    const rows = await listSettledDocuments(f.company, f.lines.full);
    expect(ids(rows)).toEqual([f.docs.b1, f.docs.b2].sort());
    const b1 = rows.find((r) => r.documentId === f.docs.b1)!;
    expect(b1).toMatchObject({
      source: 'settled_document', store: 'entity', fileName: 'SIV-1.pdf', fileUrl: 'https://files.test/SIV-1.pdf',
      via: { kind: 'supplier_payment', paymentNumber: 'SP-1' },
      settles: { entityType: 'supplier_invoice', entityId: f.bills.b1, number: 'SIV-1', total: 1000, applied: 1000, partial: false },
    });
  });

  it('partial payment: the bill, marked part-paid R300 of R1,000', async () => {
    const [row, ...rest] = await listSettledDocuments(f.company, f.lines.partial);
    expect(rest).toEqual([]); // the inactive SIV-3-old.pdf is not listed
    expect(row!.documentId).toBe(f.docs.b3);
    expect(row!.settles).toMatchObject({ number: 'SIV-3', total: 1000, applied: 300, partial: true, outstanding: 700 });
  });

  it('credit-note offset: the bill and the approved credit note applied to it, never a draft one', async () => {
    const rows = await listSettledDocuments(f.company, f.lines.credit);
    expect(ids(rows)).toEqual([f.docs.b4, f.docs.cn1].sort());
    expect(rows.map((r) => r.settles.entityType)).toEqual(['supplier_invoice', 'credit_note']);
    expect(rows[1]!.settles).toMatchObject({
      entityId: f.creditNote, number: 'SCN-1', applied: 200, partial: false, invoiceId: f.bills.b4, invoiceNumber: 'SIV-4',
    });
  });

  it('customer receipt: the invoice\'s uploaded PDF and its source capture', async () => {
    const rows = await listSettledDocuments(f.company, f.lines.receipt);
    expect(ids(rows)).toEqual([f.docs.inv1, f.docs.inv1Capture].sort());
    const capture = rows.find((r) => r.store === 'captured')!;
    expect(capture).toMatchObject({ fileUrl: `/api/accounting/captured-document-file?id=${f.docs.inv1Capture}`,
      mimeType: 'application/pdf', via: { kind: 'customer_payment', paymentNumber: 'CP-1' } });
    expect(await isSettledCapturedDocument(f.company, f.docs.inv1Capture)).toBe(true);
    expect(await isSettledCapturedDocument(f.other, f.docs.inv1Capture)).toBe(false);
  });

  it('a rejected source capture is neither listed nor served', async () => {
    await pool.query("UPDATE captured_documents SET status='rejected' WHERE id=$1", [f.docs.inv1Capture]);
    try {
      expect(ids(await listSettledDocuments(f.company, f.lines.receipt))).toEqual([f.docs.inv1]);
      expect(await isSettledCapturedDocument(f.company, f.docs.inv1Capture)).toBe(false);
    } finally {
      await pool.query("UPDATE captured_documents SET status='matched' WHERE id=$1", [f.docs.inv1Capture]);
    }
  });

  it('shows nothing for an unapplied payment, an expense-coded line, a hand match off the bank, a cancelled payment', async () => {
    for (const line of [f.lines.unapplied, f.lines.expense, f.lines.handMatch, f.lines.cancelled, f.lines.transfer]) {
      expect(await listSettledDocuments(f.company, line)).toEqual([]);
    }
  });

  it('never crosses companies', async () => {
    expect(await listSettledDocuments(f.other, f.lines.full)).toEqual([]);
    expect(await listSettledDocuments(f.company, f.lines.foreign)).toEqual([]);
    expect(ids(await listSettledDocuments(f.other, f.lines.foreign))).toEqual([f.docs.foreign]);
  });

  describe('list_unsupported_transactions evidence', () => {
    const window = { from: '2026-11-01', to: '2026-11-17', minAmount: 0, limit: 50 };
    const byId = (rows: { id: string; evidence: string }[]) => Object.fromEntries(rows.map((r) => [r.id, r.evidence]));

    it('default: unsupported = no evidence of either kind, with the three totals', async () => {
      const page = await listTransactionsWithoutDocuments(f.company, window);
      expect(page).toMatchObject({ universeTotal: 11, withOwnDocument: 1, withSettledDocument: 4, noEvidence: 6, rowsTotal: 6 });
      const { unapplied, expense, handMatch, cancelled, transfer, toOwnBank } = f.lines;
      expect(byId(page.rows)).toEqual(Object.fromEntries(
        [unapplied, expense, handMatch, cancelled, transfer, toOwnBank].map((id) => [id, 'none'])));
    });

    it('strict: today\'s behaviour, own attachment only, each row saying what it settles', async () => {
      const page = await listTransactionsWithoutDocuments(f.company, { ...window, strict: true });
      expect(page.rowsTotal).toBe(10);
      const ev = byId(page.rows);
      expect(ev[f.lines.full]).toBe('settled_document');
      expect(ev[f.lines.receipt]).toBe('settled_document');
      expect(ev[f.lines.ownDoc]).toBeUndefined();
    });

    it('exclude_transfers drops own-bank transfers itself, and clearing accounts the caller names', async () => {
      const own = await listTransactionsWithoutDocuments(f.company, { ...window, excludeTransfers: true });
      expect(own).toMatchObject({ universeTotal: 10, noEvidence: 5 });
      expect(byId(own.rows)[f.lines.toOwnBank]).toBeUndefined();
      const named = await listTransactionsWithoutDocuments(f.company,
        { ...window, excludeTransfers: true, transferAccountCodes: ['1560731'] });
      expect(named).toMatchObject({ universeTotal: 9, noEvidence: 4, withSettledDocument: 4 });
    });

    it('counts only the company\'s own lines', async () => {
      expect(await listTransactionsWithoutDocuments(f.other, window)).toMatchObject({ universeTotal: 1, withSettledDocument: 1 });
    });
  });
});

// Settled evidence is an audit read only: a payment journal that carries input VAT stays blocked for VAT although the
// bill it settles has its PDF (brief 2026-11-17 Part 1 item 6). The grid's paperclip counts both kinds.
describeIfDb('settled evidence leaves VAT input support alone; the grid counts it', () => {
  const vatPool = new Pool({ connectionString: url });
  let g: SettledFixture;
  let vatJe: string;
  beforeAll(async () => {
    g = await seedSettledFixture(vatPool);
    vatJe = crypto.randomUUID();
    const vat = crypto.randomUUID();
    await vatPool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
      VALUES($1,$2,'SEVAT','SE VAT input','asset','vat_input','debit')`, [vat, g.company]);
    const { rows: [line] } = await vatPool.query(
      'SELECT matched_journal_line_id AS leg FROM bank_transactions WHERE id=$1', [g.lines.full]);
    const { rows: [leg] } = await vatPool.query('SELECT journal_entry_id AS je FROM gl_journal_lines WHERE id=$1', [line.leg]);
    vatJe = leg.je;
    // The full line's journal: credit bank 1,500 / debit AP 1,500 → add input VAT 150 against a further 150 bank credit.
    // Back to draft to edit it, then posted again (the balance trigger checks it on that status change).
    await vatPool.query(`UPDATE gl_journal_entries SET status='draft' WHERE id=$1`, [vatJe]);
    await vatPool.query(`UPDATE gl_journal_lines SET credit = 1650 WHERE id=$1`, [line.leg]);
    await vatPool.query(`INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit)
      VALUES($1,$2,$3,150,0)`, [vatJe, g.company, vat]);
    await vatPool.query(`UPDATE gl_journal_entries SET status='posted' WHERE id=$1`, [vatJe]);
  });
  afterAll(async () => {
    try {
      if (g) {
        await vatPool.query(`UPDATE gl_journal_entries SET status='draft' WHERE id=$1`, [vatJe]).catch(() => undefined);
        await dropSettledFixture(vatPool, g);
      }
    } finally { await vatPool.end(); }
  });

  it('still flags the payment journal\'s input VAT as having no tax invoice: settled evidence does not clear it', async () => {
    const { findInputVatSupport } = await import('@/modules/accounting/services/reports/vatInputSupport');
    expect((await listSettledDocuments(g.company, g.lines.full)).length).toBe(2);
    const res = await findInputVatSupport(g.company, '2026-11-01', '2026-11-30');
    const flagged = [...res.unsupported, ...res.withoutTaxInvoice].find((l) => l.journalEntryId === vatJe);
    expect(flagged).toMatchObject({ reason: 'no_tax_invoice' });
  });

  it('counts own and settled documents in the grid row\'s attachmentCount', async () => {
    const { getBankTransactions } = await import('@/modules/accounting/services/bank/bankTransactionQueryService');
    const page = await getBankTransactions(g.company, {});
    const row = (id: string) => page.transactions.find((t) => t.id === id)!;
    expect(row(g.lines.full)).toMatchObject({ attachmentCount: 2, settledDocumentCount: 2 });
    expect(row(g.lines.ownDoc)).toMatchObject({ attachmentCount: 1, settledDocumentCount: 0 });
    expect(row(g.lines.expense)).toMatchObject({ attachmentCount: 0, settledDocumentCount: 0 });
  });
});

/**
 * list_missing_documents' service (core/missingDocumentsService) against real Postgres: which bills, customer invoices,
 * credit notes, bank spend lines and input-VAT journals have no supporting document, COMPUTED from the document tables.
 * Proves the population rules, that bill and VAT answers agree with the surfaces that share the predicate (the
 * hasDocument flag, list_unsupported_transactions, the pre-filing VAT check), keyset paging with ties, company
 * scoping (including a forged cross-company captured document) and the same answer as app_user under RLS.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { als } from '@/lib/als';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { getSupplierInvoices } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { listTransactionsWithoutDocuments } from '@/modules/accounting/services/core/documentQueryService';
import { findInputVatSupport } from '@/modules/accounting/services/reports/vatInputSupport';
import { listMissingDocuments } from '@/modules/accounting/services/core/missingDocumentsService';
import {
  MISSING_DOCUMENT_TYPES, type MissingDocumentFilters, type MissingDocumentRow,
} from '@/modules/accounting/services/core/missingDocumentsTypes';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx, seedBankTx, seedBill, seedInvoice } from './helpers/l1FifoFixture';
import { dropLateFixture, seedLateFixture, type LateFixture } from './helpers/vatLateClaimFixture';
import { bankUpload, capturedDoc, crossLink, dropDocuments, procDoc } from './helpers/documentFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
const W = { from: '2026-06-01', to: '2026-06-30' };

describeIfDb('list_missing_documents service', () => {
  let fx: LateFixture;
  let other: LateFixture;
  const id: Record<string, string> = {};
  const n = () => randomUUID().slice(0, 8);

  const filters = (over: Partial<MissingDocumentFilters> = {}): MissingDocumentFilters => ({
    companyId: fx.companyId, types: MISSING_DOCUMENT_TYPES, ...W, minAmount: 0, limit: 200, after: null, ...over,
  });
  const list = (over: Partial<MissingDocumentFilters> = {}) => inTx(fx, () => listMissingDocuments(filters(over)));
  const keys = (rows: MissingDocumentRow[]) => rows.map((r) => `${r.entityType}:${r.entityId}`);

  async function creditNote(f: LateFixture, key: string, total: number, status: string, date = '2026-06-12') {
    id[key] = String(((await sql`
      INSERT INTO credit_notes (company_id, credit_note_number, type, client_id, credit_date, subtotal, total_amount, status, created_by)
      VALUES (${f.companyId}::UUID, ${`CN-${n()}`}, 'customer', ${f.customerId}::UUID, ${date}::DATE, ${total}, ${total}, ${status}, ${f.userId}::UUID)
      RETURNING id`) as Row[])[0]!.id);
  }
  async function vatJournal(key: string, date: string, sourceDoc: string | null) {
    id[key] = await inTx(fx, async () => {
      const je = await createJournalEntry(fx.companyId, {
        entryDate: date, description: `VAT ${key}`, source: 'manual',
        ...(sourceDoc ? { sourceDocumentId: sourceDoc } : {}),
        lines: [{ glAccountId: fx.vatInputId, debit: 15, credit: 0 }, { glAccountId: fx.expenseId, debit: 100, credit: 0 },
          { glAccountId: fx.apId, debit: 0, credit: 115 }],
      }, fx.userId);
      await postJournalEntry(fx.companyId, je.id, fx.userId);
      return je.id;
    });
  }

  beforeAll(async () => {
    assertNotProductionDb('This test seeds companies, documents and posted journals.');
    fx = await seedLateFixture('MISSDOC', DATABASE_URL!);
    other = await seedLateFixture('MISSDOCB', DATABASE_URL!);
    const bill = async (key: string, total: number, date: string, status = 'approved') => {
      id[key] = await seedBill(fx, { number: `B-${n()}`, date, total, status });
    };
    await bill('billMissing', 1150, '2026-06-10');
    await bill('billSmall', 50, '2026-06-11');
    await bill('billUpload', 500, '2026-06-12');
    await bill('billCaptured', 300, '2026-06-13');
    await bill('billDraft', 200, '2026-06-14', 'draft');
    await bill('billCancelled', 90, '2026-06-15', 'cancelled');
    await bill('billOutside', 2000, '2026-05-10');
    await bill('billPoOnly', 40, '2026-06-18');
    await crossLink(await procDoc('purchase_order', randomUUID()), 'supplier_invoice', id.billPoOnly!, 'po_invoice_link');
    await procDoc('supplier_invoice', id.billUpload!);
    await sql`UPDATE supplier_invoices SET source_document_id = ${await capturedDoc(fx.companyId)}::UUID WHERE id = ${id.billCaptured!}::UUID`;
    await bill('otherCompanyBill', 9999, '2026-06-10');
    await sql`UPDATE supplier_invoices SET company_id = ${other.companyId}::UUID, supplier_id = ${other.supplierId}::UUID WHERE id = ${id.otherCompanyBill!}::UUID`;

    // The other company's undocumented rows of every SQL type: none may ever surface for fx.
    await creditNote(other, 'otherCn', 777, 'approved');
    id.otherInv = await seedInvoice(other, { number: `I-${n()}`, date: '2026-06-10', total: 888 });
    id.otherTx = await seedBankTx(other, { date: '2026-06-15', amount: -999, description: 'theirs' });

    id.invMissing = await seedInvoice(fx, { number: `I-${n()}`, date: '2026-06-10', total: 575 });
    id.invDoc = await seedInvoice(fx, { number: `I-${n()}`, date: '2026-06-10', total: 400 });
    await procDoc('customer_invoice', id.invDoc!);
    await creditNote(fx, 'cnMissing', 100, 'approved');
    await creditNote(fx, 'cnDoc', 120, 'approved');
    await creditNote(fx, 'cnDraft', 130, 'draft');
    await procDoc('credit_note', id.cnDoc!);

    const tx = async (key: string, amount: number, date = '2026-06-15') => { id[key] = await seedBankTx(fx, { date, amount, description: key }); };
    await tx('txMissing', -800);
    await tx('txTie', -575); // same cents as invMissing: the tie-break
    await tx('txUpload', -900);
    await tx('txCaptured', -700);
    await tx('txIncome', 5000);
    await tx('txExcluded', -600);
    await tx('txTransfer', -400);
    await tx('txOutside', -3000, '2026-05-20');
    await tx('txForged', -333);
    await tx('txNullStatusDoc', -222); // its linked capture has a NULL status: not a rejection, so it documents the line
    await bankUpload(id.txUpload!);
    await capturedDoc(fx.companyId, { matchedBankTx: id.txNullStatusDoc!, status: null });
    await capturedDoc(fx.companyId, { matchedBankTx: id.txCaptured! });
    await capturedDoc(other.companyId, { matchedBankTx: id.txForged! }); // another company's document, forged onto our line
    await sql`UPDATE bank_transactions SET status = 'excluded', excluded_reason = 'test' WHERE id = ${id.txExcluded!}::UUID`;
    await sql`UPDATE bank_transactions SET allocation_type = 'transfer' WHERE id = ${id.txTransfer!}::UUID`;

    await vatJournal('vatMissing', '2026-06-16', null);
    const vatSlip = String(((await sql`
      INSERT INTO captured_documents (company_id, file_name, file_type, status, document_type, extracted_data, storage_bucket, storage_path)
      VALUES (${fx.companyId}::UUID, 'slip.pdf', 'application/pdf', 'reviewed', 'supplier_invoice', '{"vatAmount":15}'::JSONB,
        'captured-documents', ${`${fx.companyId}/vat-${randomUUID()}.pdf`})
      RETURNING id`) as Row[])[0]!.id);
    await vatJournal('vatDoc', '2026-06-17', vatSlip);
    await vatJournal('vatOutside', '2026-05-16', null);
  }, 180000);

  afterAll(async () => {
    for (const f of [fx, other]) {
      if (!f) continue;
      await dropDocuments(f);
      await sql`DELETE FROM credit_notes WHERE company_id = ${f.companyId}::UUID`;
      await dropLateFixture(f);
    }
  }, 180000);

  const named = (rows: MissingDocumentRow[]) => rows.map((r) => {
    const key = Object.entries(id).find(([, v]) => v === r.entityId)?.[0] ?? r.entityId;
    return `${r.entityType}:${key}`;
  });

  it('lists exactly the undocumented rows, largest first, ties by entity type then id', async () => {
    const page = await list();
    expect(named(page.rows)).toEqual([
      'supplier_invoice:billMissing', // R1150
      'bank_transaction:txMissing', // R800
      'bank_transaction:txTie', // R575 — ties with the invoice; bank_transaction sorts before customer_invoice
      'customer_invoice:invMissing', // R575
      'bank_transaction:txForged', // R333 — its only "document" is another company's
      'credit_note:cnMissing', // R100
      'supplier_invoice:billSmall', // R50
      'supplier_invoice:billPoOnly', // R40 — only its PO's paperwork is linked
      'vat_journal:vatMissing', // R15 input VAT
    ]);
    expect(page.rows.map((r) => r.cents)).toEqual([115000, 80000, 57500, 57500, 33300, 10000, 5000, 4000, 1500]);
    expect(page.next).toBeNull();
  });

  it('applies the population rules: no drafts, cancelled, income, excluded, transfers, out-of-window or documented rows', async () => {
    const got = named((await list()).rows);
    for (const k of ['billUpload', 'billCaptured', 'billDraft', 'billCancelled', 'billOutside', 'otherCompanyBill',
      'invDoc', 'cnDoc', 'cnDraft', 'txUpload', 'txCaptured', 'txIncome', 'txExcluded', 'txTransfer', 'txOutside',
      'vatDoc', 'vatOutside', 'txNullStatusDoc']) {
      expect(got.filter((g) => g.endsWith(`:${k}`)), k).toEqual([]);
    }
  });

  it('summarises every type over the whole range with candidates, documented and missing amounts', async () => {
    const { summary } = await list({ limit: 1 });
    const by = Object.fromEntries(summary.map((s) => [s.entityType, s]));
    expect(by.supplier_invoice).toEqual({ entityType: 'supplier_invoice', candidates: 5, withDocument: 2, missing: 3, missingAmount: 1240 });
    expect(by.customer_invoice).toEqual({ entityType: 'customer_invoice', candidates: 2, withDocument: 1, missing: 1, missingAmount: 575 });
    expect(by.credit_note).toEqual({ entityType: 'credit_note', candidates: 2, withDocument: 1, missing: 1, missingAmount: 100 });
    expect(by.bank_transaction).toEqual({ entityType: 'bank_transaction', candidates: 6, withDocument: 3, missing: 3, missingAmount: 1708 });
    expect(by.vat_journal).toEqual({ entityType: 'vat_journal', candidates: null, withDocument: null, missing: 1, missingAmount: 15 });
  });

  it('agrees with the bill flag, list_unsupported_transactions and the pre-filing VAT check', async () => {
    const page = await list();
    const flagged = await getSupplierInvoices(fx.companyId, { limit: 200, fromDate: W.from, toDate: W.to });
    const flagMissing = flagged.invoices.filter((b) => !b.hasDocument && !['draft', 'cancelled'].includes(b.status)).map((b) => b.id).sort();
    expect(page.rows.filter((r) => r.entityType === 'supplier_invoice').map((r) => r.entityId).sort()).toEqual(flagMissing);

    const unsupported = await listTransactionsWithoutDocuments(fx.companyId, { ...{ from: W.from, to: W.to }, minAmount: 0, limit: 200 });
    const unsupportedIds = new Set(unsupported.rows.map((r) => r.id));
    const bank = page.rows.filter((r) => r.entityType === 'bank_transaction').map((r) => r.entityId);
    expect(bank.length).toBe(3);
    for (const b of bank) expect(unsupportedIds.has(b)).toBe(true);

    const vat = await findInputVatSupport(fx.companyId, W.from, W.to);
    const vatNoDoc = [...vat.unsupported, ...vat.withoutTaxInvoice].filter((l) => l.reason === 'no_document').map((l) => l.journalEntryId);
    expect(page.rows.filter((r) => r.entityType === 'vat_journal').map((r) => r.entityId)).toEqual(vatNoDoc);
    expect(page.rows.find((r) => r.entityType === 'vat_journal')?.reason).toBe('no_document');
  });

  it('min_amount is a threshold on the absolute amount, for rows and summary candidates alike', async () => {
    const page = await list({ minAmount: 700 });
    expect(named(page.rows)).toEqual(['supplier_invoice:billMissing', 'bank_transaction:txMissing']);
    expect(page.summary.find((s) => s.entityType === 'bank_transaction')).toMatchObject({ candidates: 3, missing: 1 });
  });

  it('walks the keyset one row at a time and sees every row once, in the unpaged order', async () => {
    const all = (await list()).rows;
    const seen: MissingDocumentRow[] = [];
    let after = null as MissingDocumentFilters['after'];
    for (let i = 0; i < 20; i++) {
      const page = await list({ limit: 1, after });
      seen.push(...page.rows);
      if (page.next === null) break;
      after = page.next;
    }
    expect(keys(seen)).toEqual(keys(all));
    // And in threes, across the tie between the invoice and the bank line.
    const threes: MissingDocumentRow[] = [];
    after = null;
    for (let i = 0; i < 20; i++) {
      const page = await list({ limit: 3, after });
      threes.push(...page.rows);
      if (page.next === null) break;
      after = page.next;
    }
    expect(keys(threes)).toEqual(keys(all));
    // After the very last row nothing follows — including the VAT journal, which is merged in JS, not SQL.
    const last = all[all.length - 1]!;
    const tail = await list({ after: { cents: last.cents, entityType: last.entityType, id: last.entityId } });
    expect(tail.rows).toEqual([]);
    expect(tail.next).toBeNull();
  });

  it('answers from the document tables live: attaching a document drops the row, no cached flag involved', async () => {
    const before = named((await list()).rows);
    expect(before).toContain('supplier_invoice:billMissing');
    await procDoc('supplier_invoice', id.billMissing!);
    await bankUpload(id.txMissing!);
    const after = named((await list()).rows);
    expect(after).not.toContain('supplier_invoice:billMissing');
    expect(after).not.toContain('bank_transaction:txMissing');
  });

  it('can be limited to chosen types, and never returns another company\'s rows', async () => {
    const bankOnly = await list({ types: ['bank_transaction'] });
    expect(bankOnly.rows.every((r) => r.entityType === 'bank_transaction')).toBe(true);
    expect(bankOnly.summary.map((s) => s.entityType)).toEqual(['bank_transaction']);
    const vatOnly = await list({ types: ['vat_journal'] });
    expect(named(vatOnly.rows)).toEqual(['vat_journal:vatMissing']);
    const theirs = await inTx(other, () => listMissingDocuments({ ...filters(), companyId: other.companyId }));
    expect(theirs.rows.map((r) => r.entityId)).toEqual([id.otherCompanyBill, id.otherTx, id.otherInv, id.otherCn]);
  });

  it('gives the same answer as app_user under RLS', async () => {
    const expected = keys((await list()).rows);
    const client = await fx.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO users(id,email,role,is_active) VALUES($1,$2,\'admin\',true) ON CONFLICT (id) DO NOTHING', [fx.userId, `${fx.userId}@test.local`]);
      await client.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,\'owner\')', [fx.companyId, fx.userId]);
      await client.query('SET LOCAL ROLE app_user');
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: fx.userId })]);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [fx.companyId]);
      const ctx = { client, userId: fx.userId, companyId: fx.companyId, claims: {} } as unknown as Parameters<typeof als.run>[0];
      const page = await als.run(ctx, () => listMissingDocuments(filters()));
      expect(keys(page.rows)).toEqual(expected);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});

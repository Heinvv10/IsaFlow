// Edges of settled-document evidence found by the review breaker (PR #1558): count grain, a capture linked to the
// line and settled, partial from the whole bill, unposted journals, refunds, unprocessed payments, cancelled bills,
// direction, supplier payment batches, and the evidence totals' partition. Real Postgres, own company.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { listSettledDocuments } from '@/modules/accounting/services/bank/settledDocumentService';
import { listTransactionsWithoutDocuments } from '@/modules/accounting/services/core/documentQueryService';

const url = process.env.DATABASE_URL ?? '';
const describeIfDb = url && !url.includes('dummy') ? describe : describe.skip;
const pool = new Pool({ connectionString: url });
const uuid = () => crypto.randomUUID();
const q = (t: string, v: unknown[] = []) => pool.query(t, v);
const co = uuid(); const user = uuid(); const bank = uuid(); const ap = uuid(); const supplier = uuid(); const bankB = uuid();
const W = { from: '2026-11-01', to: '2026-11-17', minAmount: 0, limit: 100 };

async function line(amount: number, status = 'allocated', jeStatus = 'posted', bankAcct = bank) {
  const id = uuid(); const je = uuid(); const leg = uuid();
  await q('INSERT INTO gl_journal_entries(id,company_id,entry_date,created_by,status) VALUES($1,$2,$3,$4,$5)', [je, co, '2026-11-02', user, jeStatus]);
  await q(`INSERT INTO gl_journal_lines(id,journal_entry_id,company_id,gl_account_id,debit,credit) VALUES($1,$2,$3,$4,$5,$6),($7,$2,$3,$8,$6,$5)`,
    [leg, je, co, bankAcct, Math.max(amount, 0), Math.max(-amount, 0), uuid(), ap]);
  await q(`INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status,matched_journal_line_id)
    VALUES($1,$2,$3,'2026-11-02',$4,'brk',$5,$6)`, [id, co, bankAcct, amount, status, leg]);
  return { id, je, leg };
}
const bill = async (num: string, total: number) => { const id = uuid();
  await q(`INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,total_amount,created_by,status) VALUES($1,$2,$3,$4,'2026-10-20',$5,$6,'approved')`, [id, co, supplier, num, total, user]); return id; };
const pay = async (je: string, num: string, total: number, method = 'eft') => { const id = uuid();
  await q(`INSERT INTO supplier_payments(id,company_id,supplier_id,payment_number,payment_date,total_amount,status,gl_journal_entry_id,created_by,payment_method) VALUES($1,$2,$3,$4,'2026-11-02',$5,'processed',$6,$7,$8)`, [id, co, supplier, num, total, je, user, method]); return id; };
const alloc = (p: string, i: string, a: number) => q('INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,$3)', [p, i, a]);
const doc = (id: string, entity: string, name: string, type = 'supplier_invoice') => q(`INSERT INTO procurement_documents(id,entity_type,entity_id,document_name,file_url,file_size,mime_type) VALUES($1,$2,$3,$4,$5,1,'application/pdf')`, [id, type, entity, name, 'https://x/' + name]);

describeIfDb('bank line settled evidence: edges', () => {
  beforeAll(async () => {
    await q("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@t.local`]);
    await q('INSERT INTO companies(id,name) VALUES($1,$2)', [co, 'Settled evidence edges']);
    await q(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance) VALUES($1,$3,'B1','Bank','asset','bank','debit'),($2,$3,'AP','AP','liability',NULL,'credit'),($4,$3,'B2','Bank2','asset','bank','debit')`, [bank, ap, co, bankB]);
    await q('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [supplier, co, 'S']);
  });
  afterAll(async () => {
    try {
      await q('DELETE FROM bank_transaction_attachments WHERE bank_transaction_id IN (SELECT id FROM bank_transactions WHERE company_id=$1)', [co]);
      await q('DELETE FROM bank_transactions WHERE company_id=$1', [co]);
      await q(`DELETE FROM document_links WHERE linked_entity_id IN (SELECT id FROM supplier_invoices WHERE company_id=$1)`, [co]);
      await q(`DELETE FROM procurement_documents WHERE entity_id IN (SELECT id FROM supplier_invoices WHERE company_id=$1)`, [co]);
      await q('DELETE FROM credit_note_allocations WHERE company_id=$1', [co]);
      await q('DELETE FROM credit_notes WHERE company_id=$1', [co]);
      await q('DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id=$1)', [co]);
      await q('DELETE FROM supplier_payments WHERE company_id=$1', [co]);
      await q('DELETE FROM supplier_payment_batches WHERE company_id=$1', [co]);
      await q('DELETE FROM supplier_invoices WHERE company_id=$1', [co]);
      await q('DELETE FROM captured_documents WHERE company_id=$1', [co]);
      await q('DELETE FROM gl_journal_lines WHERE company_id=$1', [co]);
      await q('DELETE FROM gl_journal_entries WHERE company_id=$1', [co]);
      await q('DELETE FROM suppliers WHERE company_id=$1', [co]);
      await q('DELETE FROM gl_accounts WHERE company_id=$1', [co]);
      await q('DELETE FROM companies WHERE id=$1', [co]);
      await q('DELETE FROM users WHERE id=$1', [user]);
    } finally { await pool.end(); }
  });

  it('the paperclip counts the list\'s own rows: one document cross-linked to two bills paid by one payment', async () => {
    const l = await line(-1000); const b1 = await bill('R1-A', 500); const b2 = await bill('R1-B', 500);
    const p = await pay(l.je, 'R1P', 1000); await alloc(p, b1, 500); await alloc(p, b2, 500);
    const d = uuid(); await doc(d, b1, 'shared.pdf');
    await q(`INSERT INTO document_links(document_id,linked_entity_type,linked_entity_id,link_reason) VALUES($1,'supplier_invoice',$2,'manual')`, [d, b2]);
    const list = await listSettledDocuments(co, l.id);
    const { getBankTransactions } = await import('@/modules/accounting/services/bank/bankTransactionQueryService');
    const page = await getBankTransactions(co, {});
    const row = page.transactions.find((t) => t.id === l.id)!;
    expect({ listRows: list.length, count: row.settledDocumentCount }).toEqual({ listRows: 2, count: 2 });
  });

  it('a capture linked to the line AND the settled bill\'s source counts once, as the line\'s own', async () => {
    const l = await line(-400); const b = await bill('R2-A', 400); const p = await pay(l.je, 'R2P', 400); await alloc(p, b, 400);
    const cd = uuid();
    await q(`INSERT INTO captured_documents(id,company_id,file_name,file_type,file_size,storage_path,status,matched_bank_tx_id,document_type)
      VALUES($1,$2,'inv.pdf','pdf',10,'co/x.pdf','matched',$3,'supplier_invoice')`, [cd, co, l.id]);
    await q('UPDATE supplier_invoices SET source_document_id=$1 WHERE id=$2', [cd, b]);
    const { getBankTransactions } = await import('@/modules/accounting/services/bank/bankTransactionQueryService');
    const row = (await getBankTransactions(co, {})).transactions.find((t) => t.id === l.id)!;
    expect({ a: row.attachmentCount, s: row.settledDocumentCount }).toEqual({ a: 1, s: 0 });
    expect(await listSettledDocuments(co, l.id)).toEqual([]);
  });

  it('a bill settled by cash plus a credit note is not part-paid', async () => {
    const l = await line(-600); const b = await bill('R3-A', 1000); const p = await pay(l.je, 'R3P', 600); await alloc(p, b, 600);
    const cn = uuid();
    await q(`INSERT INTO credit_notes(id,company_id,type,supplier_id,supplier_invoice_id,credit_note_number,credit_date,total_amount,status,created_by) VALUES($1,$2,'supplier',$3,$4,'R3CN','2026-10-25',400,'applied',$5)`, [cn, co, supplier, b, user]);
    await q('INSERT INTO credit_note_allocations(company_id,credit_note_id,invoice_id,amount_allocated) VALUES($1,$2,$3,400)', [co, cn, b]);
    await doc(uuid(), b, 'r3.pdf');
    const list = await listSettledDocuments(co, l.id);
    const bd = list.find((x) => x.settles.entityType === 'supplier_invoice')!;
    expect(bd.settles).toMatchObject({ applied: 600, total: 1000, partial: false, outstanding: 0 });
  });

  it('partial follows the whole bill: open after one of two payments, settled after both', async () => {
    const l1 = await line(-300); const l2 = await line(-700); const b = await bill('R4-A', 1000);
    const p1 = await pay(l1.je, 'R4P1', 300); await alloc(p1, b, 300);
    await doc(uuid(), b, 'r4.pdf');
    expect((await listSettledDocuments(co, l1.id))[0]!.settles).toMatchObject({ applied: 300, partial: true, outstanding: 700 });
    const p2 = await pay(l2.je, 'R4P2', 700); await alloc(p2, b, 700);
    expect((await listSettledDocuments(co, l1.id))[0]!.settles).toMatchObject({ applied: 300, partial: false, outstanding: 0 });
    expect((await listSettledDocuments(co, l2.id))[0]!.settles).toMatchObject({ applied: 700, partial: false });
  });

  it('an unposted (reversed) journal yields no evidence', async () => {
    const l = await line(-250, 'allocated', 'reversed'); const b = await bill('R5-A', 250); const p = await pay(l.je, 'R5P', 250); await alloc(p, b, 250);
    await doc(uuid(), b, 'r5.pdf');
    expect((await listSettledDocuments(co, l.id)).length).toBe(0);
  });

  it('a supplier refund does not claim the bill\'s document', async () => {
    const l = await line(250); const b = await bill('R6-A', 250); const p = await pay(l.je, 'R6P', -250, 'refund'); await alloc(p, b, 250);
    await doc(uuid(), b, 'r6.pdf');
    expect((await listSettledDocuments(co, l.id)).length).toBe(0);
  });

  it('an unprocessed payment yields no evidence', async () => {
    const l = await line(-90); const b = await bill('R7-A', 90); const p = await pay(l.je, 'R7P', 90); await alloc(p, b, 90);
    await q("UPDATE supplier_payments SET status='draft' WHERE id=$1", [p]);
    await doc(uuid(), b, 'r7.pdf');
    expect((await listSettledDocuments(co, l.id)).length).toBe(0);
  });

  it('a cancelled bill yields no evidence', async () => {
    const l = await line(-91); const b = await bill('R8-A', 91); const p = await pay(l.je, 'R8P', 91); await alloc(p, b, 91);
    await q("UPDATE supplier_invoices SET status='cancelled' WHERE id=$1", [b]);
    await doc(uuid(), b, 'r8.pdf');
    expect((await listSettledDocuments(co, l.id)).length).toBe(0);
  });

  it('a money-in line matched to a supplier payment\'s leg yields no evidence', async () => {
    const l = await line(-92); const b = await bill('R9-A', 92); const p = await pay(l.je, 'R9P', 92); await alloc(p, b, 92);
    await doc(uuid(), b, 'r9.pdf');
    await q('UPDATE bank_transactions SET amount=92 WHERE id=$1', [l.id]);
    expect((await listSettledDocuments(co, l.id)).length).toBe(0);
  });

  it('a supplier payment batch: the batch journal reaches its member payments\' bills', async () => {
    const l = await line(-500); const b1 = await bill('BAT-A', 200); const b2 = await bill('BAT-B', 300);
    const sb = uuid();
    await q(`INSERT INTO supplier_payment_batches(id,company_id,batch_number,total_amount,payment_count,status,gl_journal_entry_id,created_by)
      VALUES($1,$2,'BAT-1',500,2,'processed',$3,$4)`, [sb, co, l.je, user]);
    for (const [num, inv, amt] of [['BATP1', b1, 200], ['BATP2', b2, 300]] as const) {
      const p = uuid();
      await q(`INSERT INTO supplier_payments(id,company_id,supplier_id,payment_number,payment_date,total_amount,status,batch_id,created_by)
        VALUES($1,$2,$3,$4,'2026-11-02',$5,'processed',$6,$7)`, [p, co, supplier, num, amt, sb, user]);
      await alloc(p, inv, amt);
    }
    const [d1, d2] = [uuid(), uuid()]; await doc(d1, b1, 'bat-a.pdf'); await doc(d2, b2, 'bat-b.pdf');
    expect((await listSettledDocuments(co, l.id)).map((r) => r.documentId).sort()).toEqual([d1, d2].sort());
    const page = await listTransactionsWithoutDocuments(co, { ...W, strict: true });
    expect(page.rows.find((r) => r.id === l.id)?.evidence).toBe('settled_document');
    await q("UPDATE supplier_payment_batches SET status='cancelled' WHERE id=$1", [sb]);
    expect(await listSettledDocuments(co, l.id)).toEqual([]);
  });

  it('the evidence totals partition the scope, and exclude_transfers keeps real supplier payments', async () => {
    // real supplier payment, bank leg + AP leg, plus a fee line coded to an account that "holds statement lines"? use bankB leg = a real transfer
    const page = await listTransactionsWithoutDocuments(co, W);
    expect(page.withOwnDocument + page.withSettledDocument + page.noEvidence).toBe(page.universeTotal);
    const ex = await listTransactionsWithoutDocuments(co, { ...W, excludeTransfers: true });
    expect(ex.universeTotal).toBe(page.universeTotal);
  });

  it('strict counts no-own-document lines, default counts no-evidence lines', async () => {
    const s = await listTransactionsWithoutDocuments(co, { ...W, strict: true });
    const d = await listTransactionsWithoutDocuments(co, W);
    expect(s.rowsTotal).toBe(d.withSettledDocument + d.noEvidence);
    expect(d.rowsTotal).toBe(d.noEvidence);
  });
});

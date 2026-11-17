// Fixture for bank-settled-evidence.int.test.ts: two companies, bank lines settling bills / invoices through payments,
// every shape the settled-document evidence must tell apart. Journals stay draft: the evidence path reads the bank
// leg's journal id, never its status, and a draft journal fires no balance trigger.
import type { Pool } from 'pg';

const uuid = () => crypto.randomUUID();

export interface SettledFixture {
  company: string; other: string; user: string; bank: string; bankB: string;
  lines: Record<'full' | 'partial' | 'credit' | 'unapplied' | 'expense' | 'handMatch' | 'cancelled' | 'receipt' | 'foreign'
    | 'transfer' | 'toOwnBank' | 'ownDoc', string>;
  bills: Record<'b1' | 'b2' | 'b3' | 'b4', string>;
  docs: Record<'b1' | 'b2' | 'b2Order' | 'b3' | 'b4' | 'cn1' | 'cnDraft' | 'inv1' | 'inv1Capture' | 'foreign', string>;
  creditNote: string; invoice: string;
}

export async function seedSettledFixture(pool: Pool): Promise<SettledFixture> {
  const f: SettledFixture = {
    company: uuid(), other: uuid(), user: uuid(), bank: uuid(), bankB: uuid(),
    lines: { full: uuid(), partial: uuid(), credit: uuid(), unapplied: uuid(), expense: uuid(), handMatch: uuid(),
      cancelled: uuid(), receipt: uuid(), foreign: uuid(), transfer: uuid(), toOwnBank: uuid(), ownDoc: uuid() },
    bills: { b1: uuid(), b2: uuid(), b3: uuid(), b4: uuid() },
    docs: { b1: uuid(), b2: uuid(), b2Order: uuid(), b3: uuid(), b4: uuid(), cn1: uuid(), cnDraft: uuid(), inv1: uuid(),
      inv1Capture: uuid(), foreign: uuid() },
    creditNote: uuid(), invoice: uuid(),
  };
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  const { company: co, other, user } = f;
  await q("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  for (const [id, name] of [[co, 'Settled evidence A'], [other, 'Settled evidence B']]) {
    await q('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
  }
  const [ap, ar, expense, otherBank, clearing] = [uuid(), uuid(), uuid(), uuid(), uuid()];
  await q(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance) VALUES
    ($1,$7,'SEB','SE Bank','asset','bank','debit'), ($2,$7,'SEAP','SE AP','liability',NULL,'credit'),
    ($3,$7,'SEAR','SE AR','asset',NULL,'debit'), ($4,$7,'SEX','SE Expense','expense',NULL,'debit'),
    ($5,$7,'SEB2','SE Bank 2','asset','bank','debit'), ($6,$7,'1560731','SE card clearing','asset',NULL,'debit'),
    ($8,$9,'SEB','SE Bank B','asset','bank','debit')`,
  [f.bank, ap, ar, expense, otherBank, clearing, co, f.bankB, other]);
  const supplier = uuid(); const customer = uuid(); const supplierB = uuid();
  await q('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3),($4,$5,$6)',
    [supplier, co, 'CFS', supplierB, other, 'Other CFS']);
  await q('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, co, 'Fibertime']);

  /** A bank line with its own bank-leg journal: line `id` matched to the leg on `legAccount` (the bank, normally). */
  async function line(id: string, company: string, bankAcct: string, amount: number, contra: string, legAccount = bankAcct) {
    const je = uuid(); const leg = uuid();
    await q('INSERT INTO gl_journal_entries(id,company_id,entry_date,created_by,status) VALUES($1,$2,$3,$4,$5)',
      [je, company, '2026-11-02', user, 'draft']);
    await q(`INSERT INTO gl_journal_lines(id,journal_entry_id,company_id,gl_account_id,debit,credit) VALUES
      ($1,$2,$3,$4,$5,$6), ($7,$2,$3,$8,$6,$5)`,
    [leg, je, company, legAccount, Math.max(amount, 0), Math.max(-amount, 0), uuid(), contra]);
    await q(`INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status,
      matched_journal_line_id) VALUES($1,$2,$3,'2026-11-02',$4,'settled evidence fixture','allocated',$5)`,
    [id, company, bankAcct, amount, leg]);
    return je;
  }
  const bill = (id: string, company: string, sup: string, num: string, total: number) =>
    q(`INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,total_amount,created_by,status)
       VALUES($1,$2,$3,$4,'2026-10-20',$5,$6,'approved')`, [id, company, sup, num, total, user]);
  const supPayment = async (je: string, company: string, sup: string, num: string, total: number, status = 'processed') => {
    const id = uuid();
    await q(`INSERT INTO supplier_payments(id,company_id,supplier_id,payment_number,payment_date,total_amount,status,
      gl_journal_entry_id,created_by) VALUES($1,$2,$3,$4,'2026-11-02',$5,$6,$7,$8)`, [id, company, sup, num, total, status, je, user]);
    return id;
  };
  const alloc = (payment: string, invoice: string, amount: number) =>
    q('INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,$3)', [payment, invoice, amount]);
  const doc = (id: string, type: string, entity: string, name: string) =>
    q(`INSERT INTO procurement_documents(id,entity_type,entity_id,document_name,file_url,file_size,mime_type)
       VALUES($1,$2,$3,$4,$5,100,'application/pdf')`, [id, type, entity, name, `https://files.test/${name}`]);

  // full + multi-bill: one payment pays B1 and B2 in full.
  for (const [id, num, total] of [[f.bills.b1, 'SIV-1', 1000], [f.bills.b2, 'SIV-2', 500], [f.bills.b3, 'SIV-3', 1000],
    [f.bills.b4, 'SIV-4', 1000]] as const) await bill(id, co, supplier, num, total);
  const p1 = await supPayment(await line(f.lines.full, co, f.bank, -1500, ap), co, supplier, 'SP-1', 1500);
  await alloc(p1, f.bills.b1, 1000); await alloc(p1, f.bills.b2, 500);
  await doc(f.docs.b1, 'supplier_invoice', f.bills.b1, 'SIV-1.pdf');
  await doc(f.docs.b2, 'supplier_invoice', f.bills.b2, 'SIV-2.pdf');
  // B2 is also cross-linked to its purchase order's paperwork: not the bill's own document, so never shown.
  const po = uuid();
  await doc(f.docs.b2Order, 'purchase_order', po, 'PO-2.pdf');
  await q(`INSERT INTO document_links(document_id,linked_entity_type,linked_entity_id,link_reason)
    VALUES($1,'supplier_invoice',$2,'po_invoice_link')`, [f.docs.b2Order, f.bills.b2]);
  // partial: R300 of B3's R1,000.
  const p2 = await supPayment(await line(f.lines.partial, co, f.bank, -300, ap), co, supplier, 'SP-2', 300);
  await alloc(p2, f.bills.b3, 300); await doc(f.docs.b3, 'supplier_invoice', f.bills.b3, 'SIV-3.pdf');
  // credit-note offset: R800 cash + an approved R200 credit note settle B4; a draft credit note is not shown.
  const p3 = await supPayment(await line(f.lines.credit, co, f.bank, -800, ap), co, supplier, 'SP-3', 800);
  await alloc(p3, f.bills.b4, 800); await doc(f.docs.b4, 'supplier_invoice', f.bills.b4, 'SIV-4.pdf');
  const cnDraft = uuid();
  await q(`INSERT INTO credit_notes(id,company_id,type,supplier_id,supplier_invoice_id,credit_note_number,credit_date,
    total_amount,status,created_by) VALUES($1,$3,'supplier',$4,$5,'SCN-1','2026-10-25',200,'applied',$6),
    ($2,$3,'supplier',$4,$5,'SCN-D','2026-10-25',50,'draft',$6)`, [f.creditNote, cnDraft, co, supplier, f.bills.b4, user]);
  await q(`INSERT INTO credit_note_allocations(company_id,credit_note_id,invoice_id,amount_allocated)
    VALUES($1,$2,$3,200),($1,$4,$3,50)`, [co, f.creditNote, f.bills.b4, cnDraft]);
  await doc(f.docs.cn1, 'credit_note', f.creditNote, 'SCN-1.pdf');
  await doc(f.docs.cnDraft, 'credit_note', cnDraft, 'SCN-D.pdf');
  // unapplied: a payment with no applications.
  await supPayment(await line(f.lines.unapplied, co, f.bank, -250, ap), co, supplier, 'SP-4', 250);
  // expense-coded, no payment at all.
  await line(f.lines.expense, co, f.bank, -1200, expense);
  // hand match to a journal line NOT on the bank account: the gate refuses it even though its journal pays B1.
  const hmJe = await line(f.lines.handMatch, co, f.bank, -1000, ap, ap);
  const p5 = await supPayment(hmJe, co, supplier, 'SP-5', 1000); await alloc(p5, f.bills.b1, 1000);
  // cancelled payment.
  const p6 = await supPayment(await line(f.lines.cancelled, co, f.bank, -1000, ap), co, supplier, 'SP-6', 1000, 'cancelled');
  await alloc(p6, f.bills.b1, 1000);
  // customer receipt: INV-1 has an uploaded PDF and a usable source captured document (the issued PDF snapshot).
  const cpJe = await line(f.lines.receipt, co, f.bank, 2300, ar);
  await q(`INSERT INTO captured_documents(id,company_id,file_name,file_type,file_size,storage_path,status)
    VALUES($1,$2,'INV-1 issued.pdf','pdf',200,'co/inv-1.pdf','matched')`, [f.docs.inv1Capture, co]);
  await q(`INSERT INTO customer_invoices(id,company_id,customer_id,invoice_number,total_amount,created_by,status,
    source_document_id) VALUES($1,$2,$3,'INV-1',2300,$4,'paid',$5)`, [f.invoice, co, customer, user, f.docs.inv1Capture]);
  const cp = uuid();
  await q(`INSERT INTO customer_payments(id,company_id,client_id,payment_number,payment_date,total_amount,status,
    gl_journal_entry_id,created_by) VALUES($1,$2,$3,'CP-1','2026-11-02',2300,'confirmed',$4,$5)`, [cp, co, customer, cpJe, user]);
  await q('INSERT INTO customer_payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,2300)', [cp, f.invoice]);
  await doc(f.docs.inv1, 'customer_invoice', f.invoice, 'INV-1.pdf');
  // transfer: coded to the card clearing account, no evidence of either kind.
  await line(f.lines.transfer, co, f.bank, -5000, clearing);
  // transfer to the company's own other bank account: a money account, found without any code list.
  await line(f.lines.toOwnBank, co, f.bank, -7000, otherBank);
  // own document only: expense-coded line with its own slip.
  await line(f.lines.ownDoc, co, f.bank, -2000, expense);
  await q(`INSERT INTO bank_transaction_attachments(bank_transaction_id,file_url,file_name,file_size)
    VALUES($1,'data:application/pdf;base64,JVBERi0=','slip.pdf',5)`, [f.lines.ownDoc]);
  // company B: its own paid bill with a document.
  const bB = uuid(); const apB = uuid();
  await q(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance)
    VALUES($1,$2,'SEAP','SE AP B','liability','credit')`, [apB, other]);
  await bill(bB, other, supplierB, 'SIV-B', 100);
  const pB = await supPayment(await line(f.lines.foreign, other, f.bankB, -100, apB), other, supplierB, 'SP-B', 100);
  await alloc(pB, bB, 100); await doc(f.docs.foreign, 'supplier_invoice', bB, 'SIV-B.pdf');
  return f;
}

export async function dropSettledFixture(pool: Pool, f: SettledFixture): Promise<void> {
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  for (const co of [f.company, f.other]) {
    await q('DELETE FROM bank_transaction_attachments WHERE bank_transaction_id IN (SELECT id FROM bank_transactions WHERE company_id=$1)', [co]);
    await q('DELETE FROM bank_transactions WHERE company_id=$1', [co]);
    await q(`DELETE FROM document_links WHERE linked_entity_id IN (SELECT id FROM supplier_invoices WHERE company_id=$1)`, [co]);
    await q(`DELETE FROM procurement_documents WHERE entity_id IN (SELECT id FROM supplier_invoices WHERE company_id=$1
      UNION SELECT id FROM customer_invoices WHERE company_id=$1 UNION SELECT id FROM credit_notes WHERE company_id=$1)
      OR id = ANY($2::uuid[])`, [co, Object.values(f.docs)]);
    await q('DELETE FROM credit_note_allocations WHERE company_id=$1', [co]);
    await q('DELETE FROM credit_notes WHERE company_id=$1', [co]);
    await q('DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id=$1)', [co]);
    await q('DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE company_id=$1)', [co]);
    await q('DELETE FROM supplier_payments WHERE company_id=$1', [co]);
    await q('DELETE FROM customer_payments WHERE company_id=$1', [co]);
    await q('DELETE FROM supplier_invoices WHERE company_id=$1', [co]);
    await q('DELETE FROM customer_invoices WHERE company_id=$1', [co]);
    await q('DELETE FROM captured_documents WHERE company_id=$1', [co]);
    await q('DELETE FROM gl_journal_lines WHERE company_id=$1', [co]);
    await q('DELETE FROM gl_journal_entries WHERE company_id=$1', [co]);
    await q('DELETE FROM suppliers WHERE company_id=$1', [co]);
    await q('DELETE FROM customers WHERE company_id=$1', [co]);
    await q('DELETE FROM gl_accounts WHERE company_id=$1', [co]);
    await q('DELETE FROM companies WHERE id=$1', [co]);
  }
  await q('DELETE FROM users WHERE id=$1', [f.user]);
}

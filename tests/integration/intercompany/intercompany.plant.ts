/** Rows the intercompany (1000 + 1002) suites plant: through the guards where the guards are what is tested, with one off where a fixture needs it. */
import type { Pool } from 'pg';
import { U, plantDocument } from './intercompany.fixture';
import { asAppUser, asOwner, pairOf, withoutTrigger } from './intercompany.session';

/** A group connection as a session that may create one does (the guard triggers run). */
export async function plantConnection(pool: Pool, x: string, y: string, by = U.ab): Promise<string> {
  const [low, high] = pairOf(x, y);
  return asAppUser(pool, by, low, async (q) => (await q.query(
    `INSERT INTO intercompany_connections(company_low_id, company_high_id, kind, status, invited_by_company_id)
     VALUES ($1, $2, 'group', 'active', $1) RETURNING id`, [low, high])).rows[0].id as string, true);
}

/**
 * An EXTERNAL connection: the database refuses to create one until P6, so a superuser plants it with the
 * connections guard off. `active` = accepted by the high company; `revoked` = revoked by it afterwards.
 */
export async function plantExternal(pool: Pool, x: string, y: string, status: 'pending' | 'active' | 'revoked' = 'pending', by = U.ab): Promise<string> {
  const [low, high] = pairOf(x, y);
  const t = 'trg_intercompany_connections_guard';
  const id = await withoutTrigger(pool, 'intercompany_connections', t, async (q) => {
    await q.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: by })]);
    const r = await q.query(
      `INSERT INTO intercompany_connections(company_low_id, company_high_id, kind, status, invited_by_company_id, invited_by, accepted_by, accepted_at, revoked_by, revoked_at)
       VALUES ($1, $2, 'external', $3, $1, $4, $5, $6, $7, $6) RETURNING id`,
      [low, high, status, by, status === 'pending' ? null : by, status === 'pending' ? null : new Date(), status === 'revoked' ? by : null]);
    return r.rows[0].id as string;
  });
  return id;
}

/** A side as a session of its company writes it (the guard runs). */
export async function plantSide(pool: Pool, connection: string, company: string, partner: string, over: Record<string, unknown> = {}, by = U.ab): Promise<void> {
  const cols = ['connection_id', 'company_id', 'partner_company_id', ...Object.keys(over)];
  await asAppUser(pool, by, company, (q) => q.query(
    `INSERT INTO intercompany_connection_sides(${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    [connection, company, partner, ...Object.values(over)]), true);
}

/** A company's connection key row, as a session of that company writes it. */
export async function plantKey(pool: Pool, company: string, hash: string, by = U.ab): Promise<void> {
  await asAppUser(pool, by, company, (q) => q.query('INSERT INTO company_connection_keys(company_id, key_hash) VALUES ($1, $2)', [company, hash]), true);
}


/** A link row with the links guard off (a superuser's DDL for the transaction): a fixture for tests of what is READ. */
export async function plantLink(pool: Pool, connection: string, over: Partial<{ doc_a: string; doc_b: string; status: string }> = {}): Promise<string> {
  const [low, high] = (await pool.query('SELECT company_low_id, company_high_id FROM intercompany_connections WHERE id = $1', [connection])).rows
    .map((r) => [r.company_low_id, r.company_high_id])[0] as [string, string];
  return withoutTrigger(pool, 'intercompany_document_links', 'trg_intercompany_links_guard', async (q) => (await q.query(
    `INSERT INTO intercompany_document_links(connection_id, company_a_id, doc_a_type, doc_a_id, company_b_id, doc_b_type, doc_b_id, origin, status, created_by)
     VALUES ($1, $2, 'customer_invoice', $4, $3, 'supplier_invoice', $5, 'manual_pairing', $6, $7) RETURNING id`,
    [connection, low, high, over.doc_a ?? crypto.randomUUID(), over.doc_b ?? crypto.randomUUID(), over.status ?? 'pending_confirmation', U.ab])).rows[0].id as string);
}

/**
 * A payload for an invoice / credit_note message a fixture plants (the DATABASE builds the real one, `intercompany_send_for_source`): the sender's
 * document as its books have it. Approves the planted document. `'{}'` when the document is not `company`'s customer document.
 */
export async function payloadFor(pool: Pool, kind: string, doc: string, company: string): Promise<string> {
  const credit = kind === 'credit_note';
  if (kind !== 'invoice' && !credit) return '{}';
  const found = (await pool.query(credit
    ? "UPDATE credit_notes SET status = 'approved' WHERE id = $1 AND company_id = $2 AND type = 'customer' RETURNING credit_note_number AS num, credit_date::text AS dt, currency AS cur, subtotal, tax_amount, total_amount"
    : "UPDATE customer_invoices SET status = 'approved' WHERE id = $1 AND company_id = $2 RETURNING invoice_number AS num, invoice_date::text AS dt, currency_code AS cur, subtotal, tax_amount, total_amount",
  [doc, company])).rows[0];
  if (!found) return '{}';
  const c = (await pool.query('SELECT name, vat_number FROM companies WHERE id = $1', [company])).rows[0];
  const n = (v: unknown) => Number(v ?? 0);
  return JSON.stringify({
    version: 1, kind, number: found.num, date: found.dt, dueDate: null, currency: found.cur, subtotal: n(found.subtotal), taxAmount: n(found.tax_amount),
    total: n(found.total_amount), senderName: String(c.name).slice(0, 200), senderVatNumber: c.vat_number ? String(c.vat_number).slice(0, 50) : null,
    notes: null, pdf: null, creditsInvoiceNumber: null, groupTransactionId: null,
    lines: credit ? [{ description: 'x', quantity: 1, unitPrice: n(found.subtotal), taxRate: 0, taxAmount: 0, lineTotal: n(found.subtotal) }] : [],
  });
}

/** The kinds whose source document is an invoice / credit note of the sender (the others name a payment or allocation row). */
export const DOCUMENT_KINDS = ['invoice', 'credit_note', 'interest_invoice'];

/**
 * A message as a session of the sender sends it (the guard runs). A document kind names a real source document of the sender
 * (planted unless `doc` is given): customer_invoice for invoice and interest_invoice, a customer credit note for credit_note.
 */
export async function plantMessage(pool: Pool, connection: string, from: string, to: string, over: { kind?: string; doc?: string; user?: string } = {}): Promise<string> {
  const kind = over.kind ?? 'invoice';
  const sourceType = kind === 'credit_note' ? 'credit_note' : DOCUMENT_KINDS.includes(kind) ? 'customer_invoice' : 'payment';
  const doc = over.doc ?? (DOCUMENT_KINDS.includes(kind) ? await plantDocument(pool, sourceType as 'credit_note' | 'customer_invoice', from) : crypto.randomUUID());
  const payload = DOCUMENT_KINDS.includes(kind) ? await payloadFor(pool, kind, doc, from) : '{"number":"INV-1"}';
  // A message is written by the database (1013): app_user cannot INSERT one of any kind, so a fixture plants it as the table owner with the
  // sender's claims (the guard's other rules - connection, group, write role, source document - all run).
  return asOwner(pool, over.user ?? U.ab, from, async (q) => (await q.query(
    `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING id`,
    [connection, from, to, kind, sourceType, doc, payload])).rows[0].id as string, true);
}

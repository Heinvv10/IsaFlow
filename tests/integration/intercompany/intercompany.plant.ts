/** Rows the intercompany (1000 + 1002) suites plant: through the guards where the guards are what is tested, with one off where a fixture needs it. */
import type { Pool } from 'pg';
import { U } from './intercompany.fixture';
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

/** A message as superuser plants it (the guard still runs, with the sender's claims). */
export async function plantMessage(pool: Pool, connection: string, from: string, to: string, over: { kind?: string; doc?: string; user?: string } = {}): Promise<string> {
  return asAppUser(pool, over.user ?? U.ab, from, async (q) => (await q.query(
    `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
     VALUES ($1, $2, $3, $4, 'customer_invoice', $5, '{"number":"INV-1"}') RETURNING id`,
    [connection, from, to, over.kind ?? 'invoice', over.doc ?? crypto.randomUUID()])).rows[0].id as string, true);
}


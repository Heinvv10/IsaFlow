/** Shared by the intercompany link suites: the INSERT, the pair's order, accepted messages and the link columns for a mirror or a pairing. */
import type { Pool } from 'pg';
import { asAppUser, co, pairOf, plantDocument, plantMessage, U } from './intercompany.helpers';

export const low = () => pairOf(co.A, co.B)[0];
export const high = () => pairOf(co.A, co.B)[1];
/** The writer of A (user a) or of B (user b) for the given company. */
export const ownerOf = (company: string) => (company === co.A ? U.a : U.b);

export const LINK = `INSERT INTO intercompany_document_links(connection_id, message_id, company_a_id, doc_a_type, doc_a_id, company_b_id, doc_b_type, doc_b_id, origin)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`;

export const linkRow = async (pool: Pool, l: string) => (await pool.query('SELECT * FROM intercompany_document_links WHERE id = $1', [l])).rows[0];

/** An accepted invoice message from `from` to `to`, with its source (sender's) and target (receiver's) documents. */
export async function acceptedMessage(pool: Pool, id: string, from: string, to: string, over: { src?: string; tgt?: string; kind?: string } = {}) {
  const src = over.src ?? (await plantDocument(pool, 'customer_invoice', from));
  const tgt = over.tgt ?? (await plantDocument(pool, 'supplier_invoice', to));
  const m = await plantMessage(pool, id, from, to, { doc: src, kind: over.kind, user: ownerOf(from) });
  await asAppUser(pool, ownerOf(to), to, (q) => q.query(
    "UPDATE intercompany_messages SET status = 'accepted', target_doc_type = 'supplier_invoice', target_doc_id = $2 WHERE id = $1", [m, tgt]), true);
  return { m, src, tgt };
}

/** The link's columns for a mirror of a message from `from` (source customer_invoice) to the other (target supplier_invoice). */
export function mirrorArgs(id: string, from: string, m: string, src: string, tgt: string) {
  return from === low()
    ? [id, m, low(), 'customer_invoice', src, high(), 'supplier_invoice', tgt, 'mirror']
    : [id, m, low(), 'supplier_invoice', tgt, high(), 'customer_invoice', src, 'mirror'];
}

/** The link's columns for a manual pairing of the low company's document `a` with the high company's `b`. */
export const pairing = (id: string, a: string, b: string, aType = 'customer_invoice', bType = 'supplier_invoice') =>
  [id, null, low(), aType, a, high(), bType, b, 'manual_pairing'];

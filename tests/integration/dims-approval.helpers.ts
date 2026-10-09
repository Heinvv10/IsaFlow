/**
 * Fixture for the CC1 / CC2 / BU approval tests (migration 873): two FNOs, a
 * project under each, two business units, and the gate planted for one
 * document type — enforcement, an owner rule, and an APPROVED request bound to
 * the document's digest as it stands.
 */
import type { Pool, PoolClient } from 'pg';
import { plantRule } from './r035-approval.helpers';

export interface Dims { fno1: string; fno2: string; proj1: string; proj2: string; bu1: string; bu2: string }

export type GatedType = 'customer_invoice' | 'supplier_invoice' | 'customer_credit_note' | 'supplier_credit_note';

export async function plantDims(pool: Pool | PoolClient, company: string): Promise<Dims> {
  const tag = company.slice(0, 6);
  const cc = async (code: string, type: 'cc1' | 'cc2', parent: string | null) => (await pool.query(
    `INSERT INTO cost_centres(company_id, code, name, cc_type, parent_id) VALUES($1,$2,$2,$3,$4) RETURNING id`,
    [company, `${code}-${tag}`, type, parent])).rows[0].id as string;
  const bu = async (code: string) => (await pool.query(
    'INSERT INTO business_units(company_id, code, name) VALUES($1,$2,$2) RETURNING id',
    [company, `${code}${tag}`])).rows[0].id as string;
  const fno1 = await cc('F1', 'cc1', null);
  const fno2 = await cc('F2', 'cc1', null);
  return { fno1, fno2, proj1: await cc('P1', 'cc2', fno1), proj2: await cc('P2', 'cc2', fno2), bu1: await bu('B1'), bu2: await bu('B2') };
}

/** Enforcement and an owner rule for `type`, then an approved request bound to the CURRENT digest. */
export async function approvedFor(pool: Pool, company: string, type: GatedType, id: string,
  requester: string, approver: string): Promise<string> {
  await pool.query(
    `INSERT INTO approval_enforcement(company_id, document_type, enabled_by, enabled_at)
     VALUES($1,$2,$3, now() - INTERVAL '1 hour') ON CONFLICT DO NOTHING`, [company, type, approver]);
  await plantRule(pool, company, 'owner', { documentType: type });
  return (await pool.query(
    `INSERT INTO approval_requests(company_id, document_type, document_id, status, requested_by, required_role,
       decided_by, decided_at, document_digest)
     VALUES($1,$2,$3,'approved',$4,'owner',$5, now(), approval_document_digest($1,$2,$3)) RETURNING id`,
    [company, type, id, requester, approver])).rows[0].id as string;
}

export const digestOf = async (pool: Pool | PoolClient, company: string, type: GatedType, id: string) => (await pool.query(
  'SELECT approval_document_digest($1,$2,$3) AS d', [company, type, id])).rows[0].d as string | null;

/** The dimension slots go first: they RESTRICT the masters, and business_units does not cascade. */
export async function cleanupDims(pool: Pool, companies: string[]): Promise<void> {
  await pool.query(
    `UPDATE customer_invoice_items SET cc1_id = NULL, cc2_id = NULL, bu_id = NULL
     WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = ANY($1))`, [companies]);
  await pool.query(
    `UPDATE supplier_invoice_items SET cc1_id = NULL, cc2_id = NULL, bu_id = NULL
     WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = ANY($1))`, [companies]);
  await pool.query('UPDATE credit_notes SET cc1_id = NULL, cc2_id = NULL, bu_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('UPDATE customers SET default_cc1_id = NULL WHERE company_id = ANY($1)', [companies]);
  // Journal and bank lines RESTRICT the masters too since migrations 878 (bank) and 882 (journal).
  await pool.query('UPDATE gl_journal_lines SET cc1_id = NULL, cc2_id = NULL, bu_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('UPDATE bank_transactions SET cc1_id = NULL, cc2_id = NULL, bu_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM business_units WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM cost_centres WHERE company_id = ANY($1)', [companies]);
}

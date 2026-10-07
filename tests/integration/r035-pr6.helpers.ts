/**
 * R-035 PR6 fixture: a company whose journals can POST (two expense accounts,
 * a bank, and an open 2026), DRAFT journals planted with two lines, enforcement
 * planted for `manual_journal`, and the real routes a person drives — post and
 * reverse (journal-entries-action), read (journal-entries-detail), raise and
 * decide (approval-requests).
 */
import type { Pool, PoolClient } from 'pg';
import journalEntriesAction from '../../pages/api/accounting/journal-entries-action';
import journalEntriesDetail from '../../pages/api/accounting/journal-entries-detail';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';
import { callRoute, newCompany } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { cleanupPr5 } from './r035-pr5.helpers';

type Tokens = Record<string, string>;
type Db = Pool | PoolClient;

export interface JournalCompany { c: string; expA: string; expB: string; bank: string }

/** newCompany plus two expense accounts, a bank and an open 2026. */
export async function journalCompany(pool: Pool, members: [string, string][], companies: string[]): Promise<JournalCompany> {
  const c = await newCompany(pool, members, companies);
  const tag = c.slice(0, 6);
  const ids: string[] = [];
  for (const [code, type, normal, subtype] of [['EA', 'expense', 'debit', null], ['EB', 'expense', 'debit', null],
    ['BK', 'asset', 'debit', 'bank']] as const) {
    const { rows } = await pool.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,account_subtype)
       VALUES ($1,$2,$3,$4,$5,true,$6) RETURNING id`, [c, `${code}${tag}`, `R035 ${code}`, type, normal, subtype]);
    ids.push(String(rows[0].id));
  }
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'R035 2026',1,2026,'2026-01-01','2026-12-31','open')`, [c]);
  clearSystemAccountCache(c);
  return { c, expA: ids[0]!, expB: ids[1]!, bank: ids[2]! };
}

export async function enforceJournals(db: Db, company: string, by: string, enabledAt?: string): Promise<void> {
  await db.query(
    `INSERT INTO approval_enforcement(company_id, document_type, enabled_by, enabled_at)
     VALUES($1,'manual_journal',$2,COALESCE($3::TIMESTAMPTZ, now()))`, [company, by, enabledAt ?? null]);
}

/** An owner rule over R1 000 on manual journals (`value`/`operator` override it). */
export const journalRule = (plant: (db: Db, c: string, role: string, o: Record<string, unknown>) => Promise<string>,
  db: Db, c: string, opts: { value?: number; role?: string; operator?: string } = {}) =>
  plant(db, c, opts.role ?? 'owner', {
    documentType: 'manual_journal', operator: opts.operator ?? 'greater_than', value: opts.value ?? 1000, name: 'Journals sign',
  });

/**
 * A DRAFT journal: DR expA / CR bank of `amount` (default R1 500), dated
 * 2026-09-01, created by `createdBy`, with source `source` (default manual).
 */
export async function plantJournal(db: Db, f: JournalCompany, createdBy: string, opts: {
  amount?: number; source?: string; status?: string; marked?: boolean;
} = {}): Promise<string> {
  const id = crypto.randomUUID();
  const amount = opts.amount ?? 1500;
  await db.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,source,status,created_by)
     VALUES($1,$2,$3,DATE '2026-09-01','R035 journal',$4,'draft',$5)`,
    [id, f.c, `JE-${id.slice(0, 8)}`, opts.source ?? 'manual', createdBy]);
  await db.query(
    `INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description)
     VALUES($1,$2,$3,$5,0,'dr'),($1,$2,$4,0,$5,'cr')`, [f.c, id, f.expA, f.bank, amount]);
  if (opts.marked) await db.query("UPDATE gl_journal_entries SET approval_document_type = 'manual_journal' WHERE id = $1", [id]);
  if (opts.status && opts.status !== 'draft') await db.query('UPDATE gl_journal_entries SET status = $2 WHERE id = $1', [id, opts.status]);
  return id;
}

/** The journal's status, marker, authors, and what posted to the expense account (the balance cache). */
export async function journalState(pool: Pool, id: string) {
  const { rows } = await pool.query(
    `SELECT je.status, je.approval_document_type AS marker, je.content_authors::TEXT[] AS authors,
            COALESCE((SELECT SUM(b.debit_total) FROM gl_account_balances b
                      JOIN gl_journal_lines l ON l.gl_account_id = b.gl_account_id AND l.journal_entry_id = je.id
                      WHERE l.debit > 0), 0)::FLOAT AS posted_debit
     FROM gl_journal_entries je WHERE je.id = $1`, [id]);
  return rows[0] as { status: string; marker: string | null; authors: string[]; posted_debit: number };
}

export const journalDigest = async (db: Db, company: string, id: string) => (await db.query(
  "SELECT approval_document_digest($1,'manual_journal',$2) AS d", [company, id])).rows[0].d as string | null;

export function journalRoutes(tokens: Tokens) {
  const as = (user: string) => tokens[user]!;
  const requestDigest = async (pool: Pool, requestId: string) => (await pool.query(
    'SELECT document_digest FROM approval_requests WHERE id = $1', [requestId])).rows[0]?.document_digest as string;
  const r = {
    post: (user: string, company: string, id: string) => callRoute(
      journalEntriesAction, as(user), company, 'POST', { id, action: 'post' }, '/api/accounting/journal-entries-action'),
    reverse: (user: string, company: string, id: string) => callRoute(
      journalEntriesAction, as(user), company, 'POST', { id, action: 'reverse' }, '/api/accounting/journal-entries-action'),
    get: (user: string, company: string, id: string) => callRoute(
      journalEntriesDetail, as(user), company, 'GET', undefined, '/api/accounting/journal-entries-detail', { id }),
    raise: (user: string, company: string, documentId: string) => callRoute(
      approvalRequests, as(user), company, 'POST', { action: 'request', documentType: 'manual_journal', documentId },
      '/api/accounting/approval-requests'),
    decide: async (pool: Pool, user: string, company: string, requestId: string, action: 'approve' | 'reject' = 'approve') =>
      callRoute(approvalRequests, as(user), company, 'POST',
        { action, requestId, expectedDigest: await requestDigest(pool, requestId) }, '/api/accounting/approval-requests'),
    /** `requester` raises, `approver` approves; both must answer 200. Returns the request id. */
    approvedBy: async (pool: Pool, requester: string, approver: string, company: string, id: string): Promise<string> => {
      const raised = await r.raise(requester, company, id);
      if (raised.state.statusCode !== 200) throw new Error(`raise: ${JSON.stringify(raised.state.body)}`);
      const requestId = dataOf<{ id: string }>(raised).id;
      const decided = await r.decide(pool, approver, company, requestId);
      if (decided.state.statusCode !== 200) throw new Error(`decide: ${JSON.stringify(decided.state.body)}`);
      return requestId;
    },
  };
  return r;
}

/** Everything a journal test drags in, then PR5's teardown (payments … journals, periods, accounts, companies, users). */
export async function cleanupPr6(pool: Pool, companies: string[], users: string[]): Promise<void> {
  await pool.query('DELETE FROM recurring_journals WHERE company_id = ANY($1)', [companies]);
  await pool.query(
    'DELETE FROM reclassification_batch_lines WHERE batch_id IN (SELECT id FROM reclassification_batches WHERE company_id = ANY($1))',
    [companies]);
  await pool.query('DELETE FROM reclassification_batches WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM captured_documents WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM vat_period_locks WHERE company_id = ANY($1)', [companies]);
  await cleanupPr5(pool, companies, users);
}

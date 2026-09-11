/**
 * R-079 fixture: an auto-posted provisional journal of E1 60 + E2 40 against
 * bank 100 — the shape the K-071 round-22 fixer measured — plus the helpers
 * to post journals, drive the route the way withAuth runs it, and read the net
 * a GL account carries over POSTED journals.
 */
import type { Pool } from 'pg';
import type { NextApiRequest } from 'next';
import { response } from '../mfa-impersonation-postgres.helpers';
import { DAY, seedBankLine, seedK074, type K074Fixture } from './k074Fixture';

export interface R079Fixture extends K074Fixture {
  e1: string;
  e2: string;
  e3: string;
}

export interface JournalLine { glAccountId: string; debit: number; credit: number }

export async function seedR079(pool: Pool): Promise<R079Fixture> {
  const fx = await seedK074(pool);
  const expense = async (code: string): Promise<string> => {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active)
       VALUES($1,$2,$3,$4,'expense','other','debit',true)`,
      [id, fx.company, code, `R079 ${code}`],
    );
    return id;
  };
  return { ...fx, e1: await expense('R79E1'), e2: await expense('R79E2'), e3: await expense('R79E3') };
}

/** One transaction on an ALS-bound client, COMMIT below 500 — withAuth's shape. */
export async function inRequest<T>(pool: Pool, fx: K074Fixture, fn: () => Promise<T>): Promise<T> {
  const { als } = await import('@/lib/als');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: fx.user, companyId: fx.company, claims: {} }, fn);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}

/** A posted journal, made the way a person makes one (source 'manual') unless told otherwise. */
export async function postJournal(
  pool: Pool, fx: K074Fixture, lines: JournalLine[],
  opts: { companyId?: string; source?: string; draft?: boolean; postingAgent?: string } = {},
): Promise<{ id: string; entryNumber: string }> {
  const { createJournalEntry, postJournalEntry } = await import('@/modules/accounting/services/gl/journalEntryService');
  const companyId = opts.companyId ?? fx.company;
  return inRequest(pool, { ...fx, company: companyId }, async () => {
    const entry = await createJournalEntry(companyId, {
      entryDate: DAY, description: 'R079 journal', lines,
      ...(opts.source ? { source: opts.source as 'manual' } : {}),
    }, fx.user);
    if (!opts.draft) await postJournalEntry(companyId, entry.id, fx.user);
    return { id: entry.id, entryNumber: String(entry.entryNumber) };
  }).then(async (je) => {
    if (opts.postingAgent) {
      await pool.query('UPDATE gl_journal_entries SET posting_agent=$1 WHERE id=$2', [opts.postingAgent, je.id]);
    }
    return je;
  });
}

/**
 * An auto-post run of one line whose provisional journal is E1 60 + E2 40 /
 * bank 100, tagged exactly as the gate tags it.
 */
export async function seedAutoPostedLine(
  pool: Pool, fx: R079Fixture,
): Promise<{ line: string; je: string; runId: string }> {
  const line = await seedBankLine(pool, fx, -100);
  const { id: je } = await postJournal(pool, fx, [
    { glAccountId: fx.e1, debit: 60, credit: 0 },
    { glAccountId: fx.e2, debit: 40, credit: 0 },
    { glAccountId: fx.bankAccount, debit: 0, credit: 100 },
  ], { source: 'auto_bank_recon' });
  const { rows } = await pool.query(
    `INSERT INTO bank_auto_post_runs(company_id,source,min_confidence,amount_cap,posted_count,total_amount)
     VALUES($1,'import',0.9,1000,1,100) RETURNING id`, [fx.company]);
  const runId = String(rows[0].id);
  await pool.query(
    "UPDATE bank_transactions SET status='provisional', provisional_je_id=$1, auto_post_run_id=$2 WHERE id=$3",
    [je, runId, line]);
  return { line, je, runId };
}

/** The measured hand offset: credit E1 60, debit bank 60 — one leg of the posting. */
export function measuredHandOffset(fx: R079Fixture): JournalLine[] {
  return [
    { glAccountId: fx.e1, debit: 0, credit: 60 },
    { glAccountId: fx.bankAccount, debit: 60, credit: 0 },
  ];
}

/**
 * The correction the net check accepts: the whole posting reclassed to E3.
 * With the posting it brings E1 and E2 back to zero; the bank stands.
 */
export function fullReclass(fx: R079Fixture): JournalLine[] {
  return [
    { glAccountId: fx.e1, debit: 0, credit: 60 },
    { glAccountId: fx.e2, debit: 0, credit: 40 },
    { glAccountId: fx.e3, debit: 100, credit: 0 },
  ];
}

export async function postViaRoute(
  pool: Pool, fx: K074Fixture, body: Record<string, unknown>,
): Promise<{ status: number; body: { data?: Record<string, unknown>; error?: { message?: string } } }> {
  const handler = (await import('../../../pages/api/accounting/bank-auto-post')).default as
    (req: NextApiRequest, res: unknown) => Promise<unknown>;
  const result = response();
  await inRequest(pool, fx, () => handler(
    { method: 'POST', body, query: {}, companyId: fx.company, user: { id: fx.user } } as unknown as NextApiRequest,
    result.res,
  ));
  return { status: result.state.statusCode, body: result.state.body as { data?: Record<string, unknown> } };
}

/** Net SUM(debit - credit) over POSTED journals for one account: is the money on the books. */
export async function netOn(pool: Pool, fx: K074Fixture, accountId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::float8 AS net
       FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.gl_account_id = $1 AND jl.company_id = $2 AND je.status = 'posted'`,
    [accountId, fx.company],
  );
  return Number(rows[0].net);
}

export async function nets(pool: Pool, fx: R079Fixture): Promise<Record<string, number>> {
  return {
    e1: await netOn(pool, fx, fx.e1), e2: await netOn(pool, fx, fx.e2),
    e3: await netOn(pool, fx, fx.e3), bank: await netOn(pool, fx, fx.bankAccount),
  };
}

export async function cleanupR079(pool: Pool, fx: K074Fixture): Promise<void> {
  const { cleanupK074 } = await import('./k074Fixture');
  await pool.query('DELETE FROM audit_log WHERE company_id=$1', [fx.company]);
  await pool.query('UPDATE bank_transactions SET auto_post_run_id=NULL, provisional_je_id=NULL, matched_journal_line_id=NULL WHERE company_id=$1', [fx.company]);
  await pool.query('DELETE FROM bank_auto_post_runs WHERE company_id=$1', [fx.company]);
  await cleanupK074(pool, fx);
}

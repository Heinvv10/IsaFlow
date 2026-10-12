/**
 * Fixture for the audit-snapshot suites (forensic-controls step 4, migration
 * 890): members with signed tokens, one company per case, a small ledger
 * planted as the table owner (accounts, posted journals with chosen dates and
 * timestamps, fiscal periods), and the writers called the way the service
 * calls them — app_user, the person's claims, the company GUC.
 */
import type { Pool, PoolClient } from 'pg';
import { as } from './entity-changes.helpers';

export type Db = Pool | PoolClient;

export interface Ledger { bank: string; sales: string; expense: string }

/** Three accounts: a bank asset, a revenue and an expense. */
export async function plantLedger(db: Db, companyId: string): Promise<Ledger> {
  const ids = { bank: crypto.randomUUID(), sales: crypto.randomUUID(), expense: crypto.randomUUID() };
  const tag = companyId.slice(0, 6);
  for (const [id, code, type, normal] of [
    [ids.bank, `1000-${tag}`, 'asset', 'debit'], [ids.sales, `4000-${tag}`, 'revenue', 'credit'],
    [ids.expense, `6000-${tag}`, 'expense', 'debit'],
  ] as const) {
    await db.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance)
       VALUES($1,$2,$3,$3,$4,$5)`, [id, companyId, code, type, normal]);
  }
  return ids;
}

export interface JournalOpts {
  date: string; amount: number; debit: string; credit: string; by: string;
  createdAt?: string; postedAt?: string; status?: string; source?: string; reversalOf?: string;
  reversedAt?: string; description?: string;
}

/** A balanced two-line journal, inserted as the table owner with the given timestamps. */
export async function plantJournal(db: Db, companyId: string, o: JournalOpts): Promise<string> {
  const id = crypto.randomUUID();
  const created = o.createdAt ?? `${o.date}T10:00:00+02:00`;
  await db.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,source,status,created_by,created_at,
       posted_by,posted_at,reversal_of_id,reversed_at,reversed_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$10,$11,$12,CASE WHEN $12::timestamptz IS NULL THEN NULL ELSE $8::uuid END)`,
    [id, companyId, `JE-${id.slice(0, 8)}`, o.date, o.description ?? 'planted', o.source ?? 'manual',
      o.status ?? 'posted', o.by, created, (o.status ?? 'posted') === 'posted' ? (o.postedAt ?? created) : null,
      o.reversalOf ?? null, o.reversedAt ?? null]);
  await db.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit,description,created_at)
     VALUES($1,$2,$3,$5,0,'dr',$6),($1,$2,$4,0,$5,'cr',$6)`, [id, companyId, o.debit, o.credit, o.amount, created]);
  return id;
}

/** One fiscal year of twelve monthly periods starting `start` (YYYY-MM-01). */
export async function plantFiscalYear(db: Db, companyId: string, year: number, start: string): Promise<string[]> {
  const ids: string[] = [];
  const [y0, m0] = start.split('-').map(Number) as [number, number];
  for (let i = 0; i < 12; i++) {
    const id = crypto.randomUUID();
    const first = new Date(Date.UTC(y0, m0 - 1 + i, 1));
    const last = new Date(Date.UTC(y0, m0 + i, 0));
    await db.query(
      `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,'open')`,
      [id, companyId, `P${i + 1} ${year}`, i + 1, year, first.toISOString().slice(0, 10), last.toISOString().slice(0, 10)]);
    ids.push(id);
  }
  return ids;
}

export interface SnapshotPayload {
  id: string; company_id: string; cutoff: string; taken_at: string; taken_by: string; trigger: string;
  status: string; failure_reason: string | null; canonical_hash: string | null; hmac: string | null;
  key_id: string | null; master_data_high_water: string | null; totals: Record<string, unknown>;
  caveat: string; check_run_id: string | null;
  /** Filled in by recordSnapshot for a sealed payload when absent: the next link of the company's chain. */
  seq?: number; prev_hmac?: string | null;
}

/** A sealed-looking payload (the writer cannot tell a real seal from a made-up one; verification can). */
export function payload(companyId: string, user: string, takenAt: string, extra: Partial<SnapshotPayload> = {}): SnapshotPayload {
  return {
    id: crypto.randomUUID(), company_id: companyId, cutoff: '2026-06-30', taken_at: takenAt, taken_by: user,
    trigger: 'manual', status: 'sealed', failure_reason: null, canonical_hash: 'a'.repeat(64), hmac: 'b'.repeat(64),
    key_id: 'k1', master_data_high_water: null, totals: {}, caveat: 'c', check_run_id: null, ...extra,
  };
}

/** Calls the snapshot writer as app_user with `user`'s claims in `company`; `fill` may rewrite the payload once now() is known. */
export async function recordSnapshot(pool: Pool, user: string, company: string,
  fill: (takenAt: string) => SnapshotPayload, rows: { tb?: unknown[]; journals?: unknown[]; lines?: unknown[] } = {},
  claims?: Record<string, unknown> | null): Promise<string> {
  const { rows: [prev] } = await pool.query<{ seq: number; hmac: string }>(
    "SELECT seq, hmac FROM audit_snapshots WHERE company_id = $1 AND status = 'sealed' ORDER BY seq DESC LIMIT 1", [company]);
  return as(pool, user, { company, ...(claims === undefined ? {} : { claims }) }, async (db) => {
    const { rows: [now] } = await db.query<{ t: string }>(
      `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`);
    const body = fill(now!.t);
    if (body.status === 'sealed' && body.seq === undefined) {
      body.seq = (prev?.seq ?? 0) + 1;
      body.prev_hmac = prev?.hmac ?? null;
    }
    const { rows: [out] } = await db.query<{ id: string }>(
      'SELECT public.audit_snapshot_record($1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb) AS id',
      [JSON.stringify(body), JSON.stringify(rows.tb ?? []), JSON.stringify(rows.journals ?? []),
        JSON.stringify(rows.lines ?? [])]);
    return out!.id;
  });
}

/** Removes everything the suites planted; the snapshots go with their companies (the purge path). */
export async function cleanupAudit(pool: Pool, companies: string[], users: string[]): Promise<void> {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1)', [companies]);
    // audit_trail_exports go with their companies: a ready pack is deleted only on the purge path.
    await pool.query('DELETE FROM vat_period_locks WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM customers WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM gl_account_balances WHERE fiscal_period_id IN (SELECT id FROM fiscal_periods WHERE company_id = ANY($1))', [companies]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM approval_rules WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM suppliers WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [companies]);
    await pool.query('DELETE FROM impersonation_sessions WHERE target_user_id = ANY($1::text[])', [users]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [users]);
  } finally {
    await pool.end();
  }
}

/** Polls until `company` has `n` snapshot rows (the automatic ones land after the request commits). */
export async function waitForSnapshots(pool: Pool, company: string, n: number, timeoutMs = 30_000): Promise<Record<string, unknown>[]> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT id, trigger, status, cutoff::text AS cutoff, failure_reason, channel, taken_by, check_run_id::text AS check_run_id FROM audit_snapshots
       WHERE company_id = $1 ORDER BY taken_at`, [company]);
    if (rows.length >= n || Date.now() > until) return rows;
    await new Promise((r) => setTimeout(r, 200));
  }
}

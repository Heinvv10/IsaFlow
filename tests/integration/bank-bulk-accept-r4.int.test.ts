/**
 * WP6 round 4 (review LOWs): a month with no period is judged by the same window the single accept uses, even for a
 * non-calendar fiscal year (L3); a scan stopped by the held-line cap with lines already postable continues after the last
 * row it actually screened (L5).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { log } from '../../src/lib/logger';
import { writePreviewToken } from '../../src/modules/accounting/services/bank/bankBulkAcceptPreview';
import { Pool } from 'pg';
import bulkAccept from '../../pages/api/accounting/bank-bulk-accept';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { bankCompany, cleanupBankControlsA, enforce, type BankCompany } from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let b = '';
const URL = '/api/accounting/bank-bulk-accept';

beforeAll(async () => { a = await createUser(pool, tokens); b = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('UPDATE bank_transactions SET auto_post_run_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_import_batches WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a, b]);
});

async function fixture(): Promise<BankCompany> {
  const f = await bankCompany(pool, [[a, 'admin'], [b, 'admin']], companies);
  await pool.query(
    `INSERT INTO bank_auto_post_settings(company_id, enabled, min_confidence, amount_cap, llm_enabled, llm_min_confidence, llm_amount_cap)
     VALUES($1, true, 0.50, 0, false, 0.95, 0)`, [f.c]);
  return f;
}
type Preview = {
  lines: { id: string }[]; scanTruncated: boolean; truncated: boolean; nextScanAfter: string | null; excluded: { noPeriod: number; badTarget: number }; previewToken: string | null;
};
type Confirmed = { posted: { txId: string }[]; refused: { txId: string; reason: string }[] };
const confirm = async (f: BankCompany, token: string) => dataOf<Confirmed>(
  await callRoute(bulkAccept, tokens[a]!, f.c, 'POST', { action: 'confirm', previewToken: token }, URL));
const preview = async (f: BankCompany, query: Record<string, string> = {}) => dataOf<Preview>(await callRoute(bulkAccept, tokens[a]!, f.c, 'GET', undefined, URL, { bankAccountId: f.bank, ...query }));
const insert = (f: BankCompany, count: number, idPrefix: string, date: string, batch: string | null = null, extra = '') => pool.query(
  `INSERT INTO bank_transactions(id, company_id, bank_account_id, transaction_date, amount, description, status, suggested_gl_account_id, suggested_confidence, suggested_strategy, import_batch_id)
   SELECT ($1 || lpad(g::TEXT, 12, '0'))::UUID, $2, $3, $6::DATE, -1, 'BULK4 line', 'imported', $4, 0.97, 'history', $5 FROM generate_series(1, $7) g ${extra}`,
  [idPrefix, f.c, f.bank, f.expA, batch, date, count]);

describe('round 4', () => {
  it('L3: a date one calendar year below the auto-create window is let through, the window being the single accept\'s', async () => {
    const f = await fixture();
    const year = new Date().getFullYear() - 11; // below isAutoCreatableYear, but a year chained from the next one can hold it
    await insert(f, 1, '33333333-3333-4333-8333-', `${year}-12-15`);
    await insert(f, 1, '44444444-4444-4444-8444-', `${year - 5}-12-15`); // far below: no year can place it
    const p = await preview(f);
    expect(p.lines.map((l) => l.id)).toEqual(['33333333-3333-4333-8333-000000000001']);
    expect(p.excluded.noPeriod).toBe(1);
  });

  it('L5: stopped by the held-line cap with more than 25 postable lines, the cursor is the last row screened, not the page end', async () => {
    const f = await fixture();
    await enforce(pool, f.c, a, ['manual_journal']);
    const batch = (await pool.query(
      `INSERT INTO bank_import_batches(company_id, bank_account_id, statement_date, transaction_count, imported_by, import_channel) VALUES($1,$2,DATE '2026-09-30',60,$3,'upload') RETURNING id`, [f.c, f.bank, a])).rows[0].id;
    await insert(f, 60, '22222222-2222-4222-8222-', '2026-09-01', batch); // held (imported by the caller), ids first
    await insert(f, 40, '55555555-5555-4555-8555-', '2026-09-01');        // postable
    const p = await preview(f);
    expect(p.lines).toHaveLength(25);
    expect(p.scanTruncated).toBe(true);
    expect(p.nextScanAfter).toBe('55555555-5555-4555-8555-000000000025'); // the last LISTED line (a cut list continues after it)
  }, 60_000);

  it('L1/L2: a refused head of 25 can be paged past: the cursor is the last listed line, and following it reaches the rest', async () => {
    const f = await fixture();
    const cc = (await pool.query("INSERT INTO cost_centres(company_id, code, name, cc_type) VALUES($1,'R4-CC','Retired','cc1') RETURNING id", [f.c])).rows[0].id;
    await pool.query(
      `INSERT INTO bank_transactions(id, company_id, bank_account_id, transaction_date, amount, description, status, suggested_gl_account_id, suggested_confidence, suggested_strategy, cc1_id)
       SELECT ('66666666-6666-4666-8666-' || lpad(g::TEXT, 12, '0'))::UUID, $1, $2, DATE '2026-09-01', -1, 'BULK4 head', 'imported', $3, 0.97, 'history', $4 FROM generate_series(1, 25) g`, [f.c, f.bank, f.expA, cc]);
    await pool.query("UPDATE cost_centres SET is_active = false WHERE id = $1", [cc]);
    await insert(f, 5, '77777777-7777-4777-8777-', '2026-09-01');
    const first = await preview(f);
    expect(first.truncated).toBe(true);
    expect(first.nextScanAfter).toBe('66666666-6666-4666-8666-000000000025');
    const out = await confirm(f, first.previewToken!);
    expect(out.posted).toHaveLength(0);
    expect(out.refused).toHaveLength(25);
    expect(out.refused[0]!.reason).toMatch(/CC1 must name an active CC1 cost centre/); // the writer's typed error, no pre-check
    const second = await preview(f, { scanAfter: first.nextScanAfter! });
    expect(second.lines).toHaveLength(5);
    expect(second.truncated).toBe(false);
    expect(second.nextScanAfter).toBeNull();
  }, 60_000);

  it('L3: a ledger-busy year stops only that year\'s lines; lines of another year keep posting', async () => {
    const f = await fixture();
    await insert(f, 2, '88888888-8888-4888-8888-', '2026-09-01');
    await insert(f, 2, '99999999-9999-4999-8999-', '2025-05-15'); // inside the window; the confirm creates its period
    const token = (await preview(f)).previewToken!;
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || 2026, 857))", [f.c]);
      const out = await confirm(f, token);
      expect(out.posted.map((p) => p.txId).sort()).toEqual(['99999999-9999-4999-8999-000000000001', '99999999-9999-4999-8999-000000000002']);
      expect(out.refused.map((r) => r.reason)).toEqual(Array(2).fill('the ledger is busy posting another batch - retry in a moment'));
    } finally { await holder.query('ROLLBACK'); holder.release(); }
  }, 30_000);

  it('L4: a company with no VAT system account reads as that, logged at warn, not as an internal error', async () => {
    const f = await fixture();
    await insert(f, 1, 'aaaaaaaa-aaaa-4aaa-8aaa-', '2026-09-01', null, '');
    await pool.query("UPDATE bank_transactions SET suggested_vat_code = 'standard' WHERE company_id = $1", [f.c]);
    const token = (await preview(f)).previewToken!;
    const warn = vi.spyOn(log, 'warn');
    try {
      const out = await confirm(f, token);
      expect(out.posted).toHaveLength(0);
      expect(out.refused[0]!.reason).toMatch(/VAT Input system account not found/);
      expect(warn.mock.calls.some((c) => /no VAT system account/.test(String(c[0])))).toBe(true);
    } finally { warn.mockRestore(); }
  }, 30_000);

  it('L6: an empty preview has no token', async () => {
    const f = await fixture();
    const p = await preview(f);
    expect(p.lines).toHaveLength(0);
    expect(p.previewToken).toBeNull();
  });

  describe('round 6: targets the writer refuses outright', () => {
    const header = async (f: BankCompany) => {
      const h = (await pool.query(
        `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,level)
         VALUES ($1,'R6HDR','R6 header','asset','debit',true,2) RETURNING id`, [f.c])).rows[0].id as string;
      await pool.query(
        `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,level,parent_account_id)
         VALUES ($1,'R6HDR1','R6 child','asset','debit',true,3,$2)`, [f.c, h]);
      return h;
    };
    const clearing = async (f: BankCompany) => (await pool.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,account_subtype)
       VALUES ($1,'R6CLR','R6 clearing','asset','debit',true,'vat_input_late_claim') RETURNING id`, [f.c])).rows[0].id as string;
    const onAccount = async (f: BankCompany, gl: string) => {
      const id = (await pool.query(
        `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status, suggested_gl_account_id, suggested_confidence, suggested_strategy)
         VALUES($1,$2,DATE '2026-09-01',-5,'BULK4 target','imported',$3,0.97,'history') RETURNING id::TEXT AS id`, [f.c, f.bank, gl])).rows[0].id as string;
      const version = (await pool.query(`SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS v FROM bank_transactions WHERE id = $1`, [id])).rows[0].v as string;
      const forced = writePreviewToken({ v: 1, a: f.bank, t: 0.8, l: [{ i: id, g: gl, x: null, s: version, m: -5, d: '2026-09-01' }] });
      return { id, forced };
    };
    for (const [name, make, text] of [['a header account with sub-accounts', header, /header/i], ['the late-claim clearing account', clearing, /clearing account/i]] as const) {
      it(`${name}: the preview leaves it out, and a forced confirm reads as its own refusal, not an internal error`, async () => {
        const f = await fixture();
        const { forced } = await onAccount(f, await make(f));
        const p = await preview(f);
        expect(p.lines).toHaveLength(0);
        expect(p.excluded).toMatchObject({ badTarget: 1 });
        const out = await confirm(f, forced);
        expect(out.posted).toHaveLength(0);
        expect(out.refused[0]!.reason).not.toMatch(/internal error/);
        expect(out.refused[0]!.reason).toMatch(text);
      }, 30_000);
    }
  });
});

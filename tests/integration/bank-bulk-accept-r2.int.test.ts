/**
 * WP6 round 2: the bulk accept keeps a line's saved dimensions, resolves its confidence floor server-side, previews only
 * what can post (and says what is held), reports refusals without echoing internals, bounds its lock waits, and a
 * person's batch is not "auto-coded". Faults go through the real route and withAuth (bank-bulk-accept.helpers).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

vi.mock('@/lib/logger', async (orig) => (await import('./bank-bulk-accept.helpers')).loggerWithFault(await orig()));
vi.mock('@/lib/neon', async (orig) => (await import('./bank-bulk-accept.helpers')).neonWithFault(await orig()));

import bulkAccept from '../../pages/api/accounting/bank-bulk-accept';
import { loadCodingCounts } from '../../src/modules/accounting/services/bank/codingMetricsService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { enforceJournals, journalRule } from './r035-pr6.helpers';
import { bankCompany, cleanupBankControlsA, enforce, type BankCompany } from './bank-controls-a.helpers';
import { faults, resetFaults } from './bank-bulk-accept.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let b = '';
const URL = '/api/accounting/bank-bulk-accept';

beforeAll(async () => { a = await createUser(pool, tokens); b = await createUser(pool, tokens); });
beforeEach(() => resetFaults());
afterAll(async () => {
  await pool.query('UPDATE bank_transactions SET auto_post_run_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [companies]);
  await pool.query('UPDATE bank_transactions SET reconciliation_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_reconciliations WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM vat_period_locks WHERE company_id = ANY($1)', [companies]);
  await pool.query('UPDATE gl_journal_lines SET cc1_id = NULL, cc2_id = NULL, bu_id = NULL WHERE company_id = ANY($1) AND (cc1_id IS NOT NULL OR bu_id IS NOT NULL)', [companies]);
  await pool.query('DELETE FROM cost_centres WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM business_units WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_import_batches WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a, b]); // ends the pool
});

async function fixture(): Promise<BankCompany> {
  const f = await bankCompany(pool, [[a, 'admin'], [b, 'admin']], companies);
  await pool.query(
    `INSERT INTO bank_auto_post_settings(company_id, enabled, min_confidence, amount_cap, llm_enabled, llm_min_confidence, llm_amount_cap)
     VALUES($1, false, 0.90, 0, false, 0.95, 0)`, [f.c]);
  return f;
}
type O = { id?: string; amount?: number; confidence?: number; date?: string; gl?: string; vat?: string | null; bank?: string; batch?: string | null; dims?: Record<string, string> };
async function suggested(f: BankCompany, o: O = {}) {
  const cols = ['company_id', 'bank_account_id', 'transaction_date', 'amount', 'description', 'status', 'suggested_gl_account_id', 'suggested_confidence', 'suggested_strategy', 'suggested_vat_code', 'import_batch_id'];
  const vals: unknown[] = [f.c, o.bank ?? f.bank, o.date ?? '2026-09-01', o.amount ?? -100, 'BULK2 line', 'imported', o.gl ?? f.expA, o.confidence ?? 0.97, 'history', o.vat ?? null, o.batch ?? null];
  if (o.id) { cols.push('id'); vals.push(o.id); }
  for (const [k, v] of Object.entries(o.dims ?? {})) { cols.push(k); vals.push(v); }
  return (await pool.query(`INSERT INTO bank_transactions(${cols.join(',')}) VALUES(${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, vals)).rows[0].id as string;
}
const preview = (f: BankCompany, query: Record<string, string> = {}, user = a) => callRoute(bulkAccept, tokens[user]!, f.c, 'GET', undefined, URL, { bankAccountId: f.bank, ...query });
const post = (f: BankCompany, body: Record<string, unknown>, user = a) => callRoute(bulkAccept, tokens[user]!, f.c, 'POST', body, URL);
type Prev = { previewToken: string; lines: { id: string; effectiveVatCode: string; vatAmount: number; cc1Code: string | null; cc1Id: string | null }[];
  needsAttention: { id: string; kind: string }[]; excluded: Record<string, number> };
const previewOf = async (f: BankCompany, query: Record<string, string> = {}) => dataOf<Prev>(await preview(f, query));
type Confirmed = { runId: string | null; posted: { txId: string; journalEntryId: string }[]; refused: { txId: string; reason: string }[]; totalPosted: number };
const confirm = async (f: BankCompany, token: string) => post(f, { action: 'confirm', previewToken: token });
const version = async (id: string) => (await pool.query(`SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS v FROM bank_transactions WHERE id = $1`, [id])).rows[0].v as string;
/** A token line for a real row, pinned as the preview would. */
const tline = async (id: string, gl: string) => {
  const r = (await pool.query('SELECT amount::FLOAT AS m, transaction_date::TEXT AS d FROM bank_transactions WHERE id = $1', [id])).rows[0];
  return { i: id, g: gl, x: null, s: await version(id), m: r.m as number, d: r.d as string };
};
const forged = (o: Record<string, unknown>) => Buffer.from(JSON.stringify({ v: 1, ...o })).toString('base64url');
const statusOf = async (id: string) => (await pool.query('SELECT status, auto_post_run_id FROM bank_transactions WHERE id = $1', [id])).rows[0] as { status: string; auto_post_run_id: string | null };
const journals = async (c: string) => (await pool.query('SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1', [c])).rows[0].n as number;
const runs = async (c: string) => (await pool.query('SELECT COUNT(*)::INT AS n FROM bank_auto_post_runs WHERE company_id = $1', [c])).rows[0].n as number;

describe('H1: the line\'s saved dimensions post', () => {
  it('cc1 / cc2 / bu on the bank line reach the journal\'s contra line and stay on the line; the preview shows them', async () => {
    const f = await fixture();
    const cc1 = (await pool.query("INSERT INTO cost_centres(company_id, code, name, cc_type) VALUES($1,'CC-ONE','One','cc1') RETURNING id", [f.c])).rows[0].id;
    const bu = (await pool.query("INSERT INTO business_units(company_id, code, name) VALUES($1,'BU-ONE','Unit One') RETURNING id", [f.c])).rows[0].id;
    const id = await suggested(f, { dims: { cc1_id: cc1, bu_id: bu } });
    const p = await previewOf(f);
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0]).toMatchObject({ cc1Id: cc1, cc1Code: 'CC-ONE' });
    const out = dataOf<Confirmed>(await confirm(f, p.previewToken));
    expect(out.posted, JSON.stringify(out.refused)).toHaveLength(1);
    const contra = (await pool.query(
      'SELECT cc1_id::TEXT AS cc1, bu_id::TEXT AS bu FROM gl_journal_lines WHERE journal_entry_id = $1 AND gl_account_id = $2', [out.posted[0]!.journalEntryId, f.expA])).rows[0];
    expect(contra).toEqual({ cc1, bu });
    const line = (await pool.query('SELECT cc1_id::TEXT AS cc1, bu_id::TEXT AS bu FROM bank_transactions WHERE id = $1', [id])).rows[0];
    expect(line).toEqual({ cc1, bu });
  });
});

describe('M1: the floor is the server\'s', () => {
  it('a forged t=0 does not post a 0.5-confidence line; t=1e999 is a 400; the run stores the resolved floor', async () => {
    const f = await fixture();
    const low = await suggested(f, { confidence: 0.5 });
    const res = await confirm(f, forged({ a: f.bank, t: 0, l: [await tline(low, f.expA)] }));
    const out = dataOf<Confirmed>(res);
    expect(out.posted).toHaveLength(0);
    expect(out.refused[0]!.reason).toMatch(/confidence too low/);
    const raw = Buffer.from(`{"v":1,"a":"${f.bank}","t":1e999,"l":[{"i":"${low}","g":"${f.expA}","x":null,"s":"x","m":-100,"d":"2026-09-01"}]}`).toString('base64url');
    expect((await confirm(f, raw)).state.statusCode).toBe(400);
    const ok = await suggested(f);
    const done = dataOf<Confirmed>(await confirm(f, (await previewOf(f)).previewToken));
    expect(done.posted.map((p) => p.txId)).toEqual([ok]);
    expect((await pool.query('SELECT min_confidence::FLOAT AS m FROM bank_auto_post_runs WHERE id = $1', [done.runId])).rows[0].m).toBe(0.9);
  });
});

describe('M2: the preview lists only what can post, and says what is held', () => {
  it('each predictable refusal is absent from the postable lines and counted', async () => {
    const f = await fixture();
    const good = await suggested(f);
    const dead = (await pool.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active) VALUES($1,'ZZDEAD','Retired','expense','debit',false) RETURNING id`, [f.c])).rows[0].id;
    const ap = (await pool.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'payable'", [f.c])).rows[0].id;
    await suggested(f, { gl: dead });                               // inactive target
    await suggested(f, { gl: ap });                                 // AP control
    await suggested(f, { gl: f.bank2 });                            // another bank account: a transfer, row 5's
    await suggested(f, { gl: f.bank });                             // the line's own bank
    await suggested(f, { date: '2025-05-01' });                     // no fiscal period
    await suggested(f, { vat: 'bogus' });                           // a VAT code the allocation refuses
    const rec = (await pool.query(`INSERT INTO bank_reconciliations(company_id, bank_account_id, statement_date, started_by) VALUES($1,$2,DATE '2026-09-30',$3) RETURNING id`, [f.c, f.bank, a])).rows[0].id;
    const held = await suggested(f);
    await pool.query('UPDATE bank_transactions SET reconciliation_id = $2 WHERE id = $1', [held, rec]);
    await pool.query(`INSERT INTO vat_period_locks(company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by) VALUES($1,'2026-08-01','2026-08-31',0,0,0,now(),$2)`, [f.c, a]);
    await suggested(f, { date: '2026-08-15', vat: 'standard' });   // standard-rated in a locked VAT period
    const p = await previewOf(f);
    expect(p.lines.map((l) => l.id)).toEqual([good]);
    expect(p.excluded).toEqual({ badTarget: 3, reconciliationHeld: 1, periodClosed: 1, vatLocked: 1, vatCode: 1 });
  });

  it('shows the EFFECTIVE VAT: a denied account previews and posts as none', async () => {
    const f = await fixture();
    await pool.query('UPDATE gl_accounts SET vat_input_denied = true WHERE id = $1', [f.expB]);
    const id = await suggested(f, { gl: f.expB, vat: 'standard', amount: -115 });
    const p = await previewOf(f);
    expect(p.lines[0]).toMatchObject({ id, effectiveVatCode: 'none', vatAmount: 0 });
    const out = dataOf<Confirmed>(await confirm(f, p.previewToken));
    expect(out.posted, JSON.stringify(out.refused)).toHaveLength(1);
    expect((await pool.query('SELECT COUNT(*)::INT AS n FROM gl_journal_lines WHERE journal_entry_id = $1', [out.posted[0]!.journalEntryId])).rows[0].n).toBe(2); // bank + contra, no VAT leg
  });

  it('a hand-keyed line a manual-journal rule holds, and a line the caller imported, are listed apart, not as postable', async () => {
    const f = await fixture();
    await journalRule(plantRule, pool, f.c, { role: 'owner' });
    await enforceJournals(pool, f.c, a);
    await enforce(pool, f.c, a, ['manual_journal']);
    const small = await suggested(f, { amount: -500 });            // below the R1 000 rule
    const big = await suggested(f, { amount: -1500 });             // hand-keyed past the rule: needs approval
    const batch = (await pool.query(
      `INSERT INTO bank_import_batches(company_id, bank_account_id, statement_date, transaction_count, imported_by, import_channel) VALUES($1,$2,DATE '2026-09-30',1,$3,'upload') RETURNING id`, [f.c, f.bank, a])).rows[0].id;
    const mine = await suggested(f, { amount: -400, batch });      // a's own import: someone else must allocate
    const p = await previewOf(f);
    expect(p.lines.map((l) => l.id).sort()).toEqual([small].sort());
    expect(p.needsAttention.map((n) => [n.id, n.kind]).sort()).toEqual([[big, 'approval'], [mine, 'importer']].sort());
  });
});

describe('M3: refusals, faults and bounds', () => {
  it('a real line of ANOTHER bank account named in the token is refused', async () => {
    const f = await fixture();
    const other = await suggested(f, { bank: f.bank2 });
    const res = dataOf<Confirmed>(await confirm(f, forged({ a: f.bank, t: 0.9, l: [await tline(other, f.expA)] })));
    expect(res.posted).toHaveLength(0);
    expect(res.refused[0]!.reason).toMatch(/not on the previewed bank account/);
    expect((await statusOf(other)).status).toBe('imported');
  });

  it('the amount cap changing between preview and confirm refuses the line over it', async () => {
    const f = await fixture();
    const small = await suggested(f, { amount: -40 });
    const big = await suggested(f, { amount: -400 });
    const token = (await previewOf(f)).previewToken;
    await pool.query('UPDATE bank_auto_post_settings SET amount_cap = 100 WHERE company_id = $1', [f.c]);
    const out = dataOf<Confirmed>(await confirm(f, token));
    expect(out.posted.map((p) => p.txId)).toEqual([small]);
    expect(out.refused).toEqual([{ txId: big, reason: expect.stringMatching(/over amount cap/) }]);
  });

  it('a failure AFTER the journal posts takes the journal and the run tag back; the first line failing leaves no stray run, and the next line mints it', async () => {
    const f = await fixture();
    const ids = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a3'];
    for (const id of ids) await suggested(f, { id, amount: -20 });
    const token = (await previewOf(f)).previewToken;
    faults.afterSql = /UPDATE bank_transactions SET auto_post_run_id/;
    const out = dataOf<Confirmed>(await confirm(f, token));
    expect(faults.fired).toHaveLength(1);
    expect(out.posted.map((p) => p.txId)).toEqual([ids[1], ids[2]]);
    expect(out.refused).toEqual([{ txId: ids[0], reason: 'could not post (internal error)' }]); // no raw message
    expect(await statusOf(ids[0]!)).toEqual({ status: 'imported', auto_post_run_id: null });
    expect(await journals(f.c)).toBe(2);
    expect(await runs(f.c)).toBe(1);
    expect(out.runId).not.toBeNull();
    expect((await statusOf(ids[1]!)).auto_post_run_id).toBe(out.runId);
    expect((await pool.query('SELECT posted_count FROM bank_auto_post_runs WHERE id = $1', [out.runId])).rows[0].posted_count).toBe(2);
  });

  it('F3: four of six lines are held by another request: the confirm finishes at once, posts the two free ones, refuses four as busy', async () => {
    const f = await fixture();
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) ids.push(await suggested(f, { id: `00000000-0000-4000-8000-0000000000b${i}`, amount: -10 - i }));
    const token = (await previewOf(f)).previewToken;
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM bank_transactions WHERE id = ANY($1) ORDER BY id FOR UPDATE', [ids.slice(0, 4)]);
      const t0 = Date.now();
      const out = dataOf<Confirmed>(await confirm(f, token));
      expect(Date.now() - t0).toBeLessThan(2_000);
      expect(out.posted.map((p) => p.txId)).toEqual([ids[4], ids[5]]);
      expect(out.refused.map((r) => r.txId)).toEqual(ids.slice(0, 4));
      for (const r of out.refused) expect(r.reason).toMatch(/busy - retry/);
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    expect(await journals(f.c)).toBe(2);
  }, 20_000);
});

describe('totals and the lock key', () => {
  it('totalPosted is summed in cents: R0.10 + R0.20 + R0.07 is R0.37 exactly', async () => {
    const f = await fixture();
    for (const amount of [-0.1, -0.2, -0.07]) await suggested(f, { amount });
    const out = dataOf<Confirmed>(await confirm(f, (await previewOf(f)).previewToken));
    expect(out.posted).toHaveLength(3);
    expect(out.totalPosted).toBe(0.37);
    expect((await pool.query('SELECT total_amount::FLOAT AS t FROM bank_auto_post_runs WHERE id = $1', [out.runId])).rows[0].t).toBe(0.37);
  });

  it('the per-account lock key is the lower-cased account id: an upper-cased token is turned away by the same lock', async () => {
    const f = await fixture();
    const id = await suggested(f);
    const token = forged({ a: f.bank.toUpperCase(), t: 0.9, l: [await tline(id, f.expA)] });
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`bulk-accept:${f.c}:${f.bank.toLowerCase()}`]);
      expect((await confirm(f, token)).state.statusCode).toBe(409);
    } finally { await holder.query('ROLLBACK'); holder.release(); }
  });
});

describe('undo with a reconciled line, and the coding metric', () => {
  it('a reconciled line is skipped and reported; the batch stays open (undone: false) and a repeat reverses nothing more', async () => {
    const f = await fixture();
    const ids = [await suggested(f), await suggested(f, { amount: -20 }), await suggested(f, { amount: -30 })];
    const out = dataOf<Confirmed>(await confirm(f, (await previewOf(f)).previewToken));
    await pool.query("UPDATE bank_transactions SET status = 'reconciled' WHERE id = $1", [ids[0]]);
    const first = dataOf<{ reversed: number; skipped: number; skippedBy: { reconciled: number }; undone: boolean }>(await post(f, { action: 'undo', runId: out.runId }));
    expect(first).toMatchObject({ reversed: 2, skipped: 1, undone: false });
    expect(first.skippedBy.reconciled).toBe(1);
    expect((await pool.query('SELECT undone_at FROM bank_auto_post_runs WHERE id = $1', [out.runId])).rows[0].undone_at).toBeNull();
    const again = dataOf<{ reversed: number; alreadyUndone: number; skipped: number; undone: boolean }>(await post(f, { action: 'undo', runId: out.runId }));
    expect(again).toMatchObject({ reversed: 0, skipped: 1, undone: false });
    expect(again.alreadyUndone).toBe(0); // the two restored lines left the run; only the reconciled one is still in it
  });

  it('a person\'s bulk accept is not counted as auto-coded', async () => {
    const f = await fixture();
    for (let i = 0; i < 3; i += 1) await suggested(f, { amount: -10 - i });
    expect(dataOf<Confirmed>(await confirm(f, (await previewOf(f)).previewToken)).posted).toHaveLength(3);
    const [counts] = await loadCodingCounts([f.c], { month: '2026-09', from: '2026-09-01', to: '2026-10-01' });
    expect({ coded: counts!.linesCoded, auto: counts!.linesAutoCoded }).toEqual({ coded: 3, auto: 0 });
  });
});

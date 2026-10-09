/**
 * #678 review item 5 and round 2 (Hein, 2026-10-09): the journal-posting vs
 * project-move race is closed by detection. `project_fno_mismatch` flags a
 * carrier whose stored CC1 contradicts the FNO its CC2 derives through the
 * CURRENT parent chain — company-scoped, against real Postgres — and nothing
 * the writers produce on purpose: a CC2-only bank allocation, a CC1 beside a
 * CC2 that derives no FNO, a draft, a reversal pair, an unissued document.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runIntegrityChecks } from '@/modules/accounting/services/gl/integrityChecks';
import { dataIntegrityChecksTool } from '@/lib/mcp/tools/integrity';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import type { McpToolContext } from '@/lib/mcp/types';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { bankLine, costCentre, dropBase, inRequest, seedBase, type Base } from './dims-678.helpers';
import { dropFixture, inTx, seedBankTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const user = crypto.randomUUID();
const AS_AT = '2026-09-30';
let b: Base;
let ob: Base;
let fx: Fixture;
const ids: Record<string, string> = {};
const q = (text: string, values: unknown[]) => pool.query(text, values);

/** A journal with one tagged debit line and an untagged credit, in `status` (posted by UPDATE, as the balance trigger wants). */
async function journal(base: Base, cc1: string | null, cc2: string, opts: { status?: string; reversalOf?: string; date?: string } = {}) {
  const je = String((await q(
    "INSERT INTO gl_journal_entries(company_id, entry_date, created_by, description, reversal_of_id) VALUES($1, $4, $2, 'D678 drift', $3) RETURNING id",
    [base.company, base.user, opts.reversalOf ?? null, opts.date ?? '2026-08-01'])).rows[0].id);
  const line = String((await q(
    'INSERT INTO gl_journal_lines(company_id, journal_entry_id, gl_account_id, debit, credit, cc1_id, cc2_id) VALUES($1, $2, $3, 10, 0, $4, $5) RETURNING id',
    [base.company, je, base.account, cc1, cc2])).rows[0].id);
  await q('INSERT INTO gl_journal_lines(company_id, journal_entry_id, gl_account_id, debit, credit) VALUES($1, $2, $3, 0, 10)', [base.company, je, base.bank]);
  if ((opts.status ?? 'posted') !== 'draft') await q("UPDATE gl_journal_entries SET status = 'posted' WHERE id = $1", [je]);
  return { je, line };
}

const reverse = async (je: string) => q("UPDATE gl_journal_entries SET status = 'reversed', reversed_at = now() WHERE id = $1", [je]);

async function bank(base: Base, cc1: string | null, cc2: string): Promise<string> {
  const id = await bankLine(pool, base, 'cc2_id', cc2);
  await q('UPDATE bank_transactions SET cc1_id = $2 WHERE id = $1', [id, cc1]);
  return id;
}

const flagged = async (companyId: string, base: Base, asAt = AS_AT) => inRequest(pool, base, async () => {
  const report = await runIntegrityChecks(companyId, { asAt, limit: 100, checks: ['project_fno_mismatch'] });
  const check = report.checks[0]!;
  return { count: check.count, amount: check.amount, ids: check.sample.map((s) => s.id).sort(), sample: check.sample, finding: check.finding };
});

beforeAll(async () => {
  b = await seedBase(pool, company, user);
  ob = await seedBase(pool, other, user);
  // F1 > PROG (programme CC2) > PROJ ; F2 a second FNO ; LOOSE a CC2 that derives no FNO.
  ids.f1 = await costCentre(pool, company, 'D-F1');
  ids.f2 = await costCentre(pool, company, 'D-F2');
  ids.prog = await costCentre(pool, company, 'D-PROG', 'cc2', ids.f1);
  ids.proj = await costCentre(pool, company, 'D-PROJ', 'cc2', ids.prog);
  ids.loose = await costCentre(pool, company, 'D-LOOSE', 'cc2');
  ids.of1 = await costCentre(pool, other, 'D-F1');
  ids.of2 = await costCentre(pool, other, 'D-F2');
  ids.oproj = await costCentre(pool, other, 'D-PROJ', 'cc2', ids.of1);
}, 60000);
afterAll(async () => {
  try {
    await q('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [[company, other]]);
    await q('DELETE FROM bank_feed_connections WHERE company_id = $1', [company]);
    if (fx) await dropFixture(fx);
    await dropBase(pool, [company, other], [user]);
  } finally { await pool.end(); }
}, 60000);

describe('project_fno_mismatch — journal lines', () => {
  it('flags a posted mismatched line and a posted CC1-less one; not a consistent line; not another company\'s', async () => {
    ids.consistent = (await journal(b, ids.f1, ids.proj)).line;
    ids.wrong = (await journal(b, ids.f2, ids.proj)).line;
    ids.noCc1 = (await journal(b, null, ids.proj)).line;
    ids.otherWrong = (await journal(ob, ids.of2, ids.oproj)).line;
    const r = await flagged(company, b);
    expect(r.ids).toEqual([ids.wrong, ids.noCc1].sort());
    expect(r.amount).toBe(20); // every failing row, not the sample
    expect(r.sample.find((s) => s.id === ids.wrong)!.detail).toBe('journal line: project D-PROJ stores FNO D-F2, derives D-F1');
    expect((await flagged(other, ob)).ids).toEqual([ids.otherWrong]);
  });

  it('skips a draft, and a CC1 beside a CC2 that derives no FNO (written on purpose)', async () => {
    const draft = (await journal(b, ids.f2, ids.proj, { status: 'draft' })).line;
    const loose = (await journal(b, ids.f1, ids.loose)).line;
    const r = await flagged(company, b);
    expect(r.ids).not.toContain(draft);
    expect(r.ids).not.toContain(loose);
  });

  it('skips a reversal pair whole, and flags the re-instatement that puts the line back in force', async () => {
    const orig = await journal(b, ids.f2, ids.proj);
    const rev = await journal(b, ids.f2, ids.proj, { reversalOf: orig.je });
    await reverse(orig.je);
    const r1 = await flagged(company, b);
    expect(r1.ids).not.toContain(orig.line);
    expect(r1.ids).not.toContain(rev.line);
    const again = await journal(b, ids.f2, ids.proj, { reversalOf: rev.je });
    await reverse(rev.je);
    const r2 = await flagged(company, b);
    expect(r2.ids).toContain(again.line);
    expect(r2.ids).not.toContain(rev.line);
  });

  it('keeps a line reversed AFTER as_at: it was in force on that date (#683 round 3)', async () => {
    const orig = await journal(b, ids.f2, ids.proj);
    const rev = await journal(b, ids.f2, ids.proj, { reversalOf: orig.je, date: '2026-10-05' });
    await reverse(orig.je); // reversed_at = now (2026-10-09), status 'reversed'
    const atSeptember = await flagged(company, b, '2026-09-30');
    expect(atSeptember.ids).toContain(orig.line);
    expect(atSeptember.ids).not.toContain(rev.line); // dated after as_at
    const atOctober = await flagged(company, b, '2026-10-31');
    expect(atOctober.ids).not.toContain(orig.line);
    expect(atOctober.ids).not.toContain(rev.line);
  });

  it('a reversed entry with no reversal row is judged by reversed_at against as_at', async () => {
    const early = await journal(b, ids.f2, ids.proj);
    const late = await journal(b, ids.f2, ids.proj);
    await q("UPDATE gl_journal_entries SET status = 'reversed', reversed_at = '2026-08-15' WHERE id = $1", [early.je]);
    await q("UPDATE gl_journal_entries SET status = 'reversed', reversed_at = '2026-10-05' WHERE id = $1", [late.je]);
    const r = await flagged(company, b, '2026-09-30');
    expect(r.ids).not.toContain(early.line);
    expect(r.ids).toContain(late.line);
  });

  it('says every carrier is counted, so the amount is tagging to repair, not money at stake (#683 round 3)', async () => {
    const r = await flagged(company, b);
    expect(r.finding).toMatch(/EVERY carrier is counted/);
    expect(r.finding).toMatch(/a document line and the journal line it posted are two rows here/);
    expect(r.finding).toMatch(/not money at stake/);
  });

  it('flags a line committed under the old FNO once its project has moved (the race it closes)', async () => {
    const proj = await costCentre(pool, company, 'D-MOVE', 'cc2', ids.f1);
    const { line } = await journal(b, ids.f1, proj);
    expect((await flagged(company, b)).ids).not.toContain(line);
    await q('UPDATE cost_centres SET parent_id = $2 WHERE id = $1', [proj, ids.f2]);
    expect((await flagged(company, b)).ids).toContain(line);
  });
});

describe('project_fno_mismatch — bank lines', () => {
  it('flags an un-allocated line with a contradicting CC1; skips a CC2-only selection, an allocated row, a removed feed row', async () => {
    const wrong = await bank(b, ids.f2, ids.proj);
    const cc2Only = await bank(b, null, ids.proj);
    const allocated = await bank(b, ids.f2, ids.proj);
    const matched = (await journal(b, ids.f1, ids.proj)).line;
    await q('UPDATE bank_transactions SET matched_journal_line_id = $2 WHERE id = $1', [allocated, matched]);
    const conn = String((await q(
      "INSERT INTO bank_feed_connections(company_id, bank_account_id, provider, status, is_active) VALUES($1, $2, 'test_provider', 'active', true) RETURNING id",
      [company, b.bank])).rows[0].id);
    const removed = String((await q(
      `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status,
         bank_feed_connection_id, provider_transaction_id, feed_state, cc1_id, cc2_id)
       VALUES($1, $2, '2026-08-01', 10, 'D678 removed', 'imported', $3, 'd678-removed', 'removed', $4, $5) RETURNING id`,
      [company, b.bank, conn, ids.f2, ids.proj])).rows[0].id);
    const r = await flagged(company, b);
    expect(r.ids).toContain(wrong);
    expect(r.sample.find((s) => s.id === wrong)!.detail).toBe('bank line: project D-PROJ stores FNO D-F2, derives D-F1');
    for (const id of [cc2Only, allocated, removed]) expect(r.ids).not.toContain(id);
  });

  it('a real CC2-only allocation through the allocation service is not flagged — bank row or journal line', async () => {
    fx = await seedFixture('D678FX', process.env.DATABASE_URL!);
    const f = await costCentre(pool, fx.companyId, 'FX-F1');
    const p = await costCentre(pool, fx.companyId, 'FX-P', 'cc2', f);
    const expense = String((await q("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_code = '6000'", [fx.companyId])).rows[0].id);
    const tx = await seedBankTx(fx, { date: '2026-08-05', amount: -115, description: 'D678 CC2-only' });
    await inTx(fx, () => allocateTransaction(fx.companyId, tx, expense, fx.userId, 'CC2 only', 'account',
      undefined, undefined, undefined, p));
    const row = (await q('SELECT cc1_id, cc2_id, matched_journal_line_id FROM bank_transactions WHERE id = $1', [tx])).rows[0];
    expect(row).toMatchObject({ cc1_id: null, cc2_id: p });
    expect(row.matched_journal_line_id).not.toBeNull();
    const tagged = (await q('SELECT cc1_id FROM gl_journal_lines WHERE company_id = $1 AND cc2_id = $2', [fx.companyId, p])).rows;
    expect(tagged).toEqual([{ cc1_id: f }]); // the journal line derived its FNO
    const r = await inTx(fx, () => runIntegrityChecks(fx.companyId, { asAt: AS_AT, limit: 100, checks: ['project_fno_mismatch'] }));
    expect(r.checks[0]).toMatchObject({ count: 0 });
  });
});

describe('project_fno_mismatch — document lines', () => {
  it('flags issued supplier / customer invoice lines and credit notes with a contradicting CC1; not drafts or cancelled ones', async () => {
    const si = async (status: string) => String((await q(
      `INSERT INTO supplier_invoices(company_id, invoice_number, supplier_id, invoice_date, created_by, total_amount, status)
       VALUES($1, $2, $3, '2026-08-01', $4, 100, $5) RETURNING id`,
      [company, `D678-SI-${status}`, b.supplier, user, status])).rows[0].id);
    const sii = async (invoice: string) => String((await q(
      "INSERT INTO supplier_invoice_items(supplier_invoice_id, description, line_total, cc1_id, cc2_id) VALUES($1, 'x', 40, $2, $3) RETURNING id",
      [invoice, ids.f2, ids.proj])).rows[0].id);
    const ci = async (status: string) => String((await q(
      `INSERT INTO customer_invoices(company_id, invoice_number, customer_id, created_by, invoice_date, due_date, total_amount, status)
       VALUES($1, $2, $3, $4, '2026-08-01', '2026-08-31', 100, $5) RETURNING id`,
      [company, `D678-CI-${status}`, b.customer, user, status])).rows[0].id);
    const cii = async (invoice: string, cc1: string | null) => String((await q(
      "INSERT INTO customer_invoice_items(invoice_id, description, unit_price, amount, cc1_id, cc2_id) VALUES($1, 'x', 50, 50, $2, $3) RETURNING id",
      [invoice, cc1, ids.proj])).rows[0].id);
    const cn = async (status: string) => String((await q(
      `INSERT INTO credit_notes(company_id, type, credit_date, created_by, status, total_amount, cc1_id, cc2_id)
       VALUES($1, 'customer', '2026-08-01', $2, $3, 30, $4, $5) RETURNING id`,
      [company, user, status, ids.f2, ids.proj])).rows[0].id);
    const flaggedDocs = [await sii(await si('approved')), await cii(await ci('sent'), ids.f2), await cn('approved')];
    const quiet = [await sii(await si('draft')), await cii(await ci('cancelled'), ids.f2), await cn('draft'),
      await cii(await ci('paid'), ids.f1), await cii(await ci('overdue'), null)];
    const r = await flagged(company, b);
    for (const id of flaggedDocs) expect(r.ids).toContain(id);
    for (const id of quiet) expect(r.ids).not.toContain(id);
    expect(r.sample.find((s) => s.id === flaggedDocs[2])!.detail).toBe('credit note: project D-PROJ stores FNO D-F2, derives D-F1');
  });

  it('reaches the MCP data_integrity_checks tool', async () => {
    const ctx = { companyId: company, userId: user, scopes: ['read:reports'], tokenJti: 'j', oauthAppId: null } as unknown as McpToolContext;
    const out = await inRequest(pool, b, () => dataIntegrityChecksTool.handler({ checks: ['project_fno_mismatch'], as_at: AS_AT }, ctx));
    expect(out.isError).toBeFalsy();
    const body = JSON.parse(out.content[0]!.text) as { rows: { id: string; count: number }[] };
    expect(body.rows[0]).toMatchObject({ id: 'project_fno_mismatch' });
    expect(body.rows[0]!.count).toBeGreaterThan(0);
  });
});

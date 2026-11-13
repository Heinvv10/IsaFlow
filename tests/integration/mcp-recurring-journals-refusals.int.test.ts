/**
 * run_recurring_journals refuses what the app's generator refuses, per template, with nothing left behind — and the
 * other templates still generate (MCP brief step 7):
 *
 *  - a CLOSED fiscal period: the run is skipped with the reason; no journal, the schedule unmoved, no key consumed;
 *  - a locked (filed) VAT period: a template that moves a VAT figure is skipped; one that moves none still posts;
 *  - not yet due, behind an earlier month, and a posting template without write:post: reported, nothing written;
 *  - manual-journal approval (R-035 Q6): an agent raises nothing — a posting template approval would hold is
 *    skipped; a draft-only one is generated, marked, with no request raised.
 *
 * ci-integration-skip: none — every case runs on the throwaway cluster.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runRecurringJournalsTool } from '@/lib/mcp/tools/writeRunRecurringJournals';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupPr6 } from './r035-pr6.helpers';
import {
  calendar, company, ctxFor, day, journals, parsed, plantTemplate, request, templateState, type Calendar, type Co,
  type Month,
} from './helpers/recurringJournalMcpFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const companies: string[] = [];
const user = crypto.randomUUID();
const POST = ['write:journals', 'write:post'];
let cal: Calendar;

type Skip = { recurring_journal_id: string; run_date: string | null; reason: string; message: string };

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  cal = await calendar(pool);
});
afterAll(() => cleanupPr6(pool, companies, [user])); // ends the pool too

const run = (co: Co, period: Month, scopes = POST) =>
  request(pool, co, user, () => runRecurringJournalsTool.handler(
    { period: period.period, idempotency_key: crypto.randomUUID() }, ctxFor(co, user, scopes)));

describe('run_recurring_journals refusals', () => {
  it('a closed fiscal period: skipped with the reason, nothing written, the key left free', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    await pool.query("UPDATE fiscal_periods SET status = 'closed' WHERE company_id = $1 AND start_date = $2::DATE", [co.c, cal.prev.start]);
    const t = await plantTemplate(pool, co, user, { name: 'Rent', frequency: 'monthly', next: day(cal.prev, 15) });

    const r = await run(co, cal.prev);
    expect(r.isError).toBeFalsy();
    expect(r.wroteNothing).toBe(true);
    const skipped = parsed(r).skipped as Skip[];
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ recurring_journal_id: t, run_date: day(cal.prev, 15), reason: 'refused' });
    expect(skipped[0]!.message).toMatch(/closed/i);
    expect(await journals(pool, co)).toEqual([]);
    expect(await templateState(pool, t)).toMatchObject({ next: day(cal.prev, 15), runs: 0, status: 'active' });
  });

  it('a locked VAT period: the VAT-moving template is skipped, the plain one still posts', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    await pool.query(
      `INSERT INTO vat_period_locks(company_id,period_start,period_end,output_tax,input_tax,net_vat,posted_through,locked_by)
       VALUES($1,$2::DATE,$3::DATE,0,0,0,$3::DATE,$4)`, [co.c, cal.prev.start, cal.prev.end, user]);
    const vat = await plantTemplate(pool, co, user, { name: 'VAT', frequency: 'monthly', next: day(cal.prev, 10), credit: co.vatOut });
    const plain = await plantTemplate(pool, co, user, { name: 'Plain', frequency: 'monthly', next: day(cal.prev, 10) });

    const out = parsed(await run(co, cal.prev));
    expect(out.generated).toMatchObject([{ recurring_journal_id: plain, status: 'posted' }]);
    expect(out.skipped).toMatchObject([{ recurring_journal_id: vat, reason: 'refused' }]);
    expect((out.skipped as Skip[])[0]!.message).toMatch(/locked because its VAT201 has been filed/);
    expect((await journals(pool, co)).map((j) => j.status)).toEqual(['posted']);
    expect((await templateState(pool, vat)).runs).toBe(0);
  });

  it('not yet due, behind an earlier month, or posting without write:post: reported, nothing written', async () => {
    const co = await company(pool, user, [cal.before, cal.prev, cal.cur, cal.next], companies);
    const future = await plantTemplate(pool, co, user, { name: 'Future', frequency: 'monthly', next: day(cal.next, 2) });
    const behind = await plantTemplate(pool, co, user, { name: 'Behind', frequency: 'monthly', next: day(cal.before, 10) });
    const posts = await plantTemplate(pool, co, user, { name: 'Posts', frequency: 'monthly', next: day(cal.prev, 20) });

    const nextRun = parsed(await run(co, cal.next, ['write:journals']));
    expect(nextRun.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ recurring_journal_id: future, reason: 'not_yet_due', run_date: day(cal.next, 2) }),
    ]));
    const prevRun = parsed(await run(co, cal.prev, ['write:journals']));
    const reasons = Object.fromEntries((prevRun.skipped as Skip[]).map((s) => [s.recurring_journal_id, s.reason]));
    expect(reasons).toEqual({ [behind]: 'behind_schedule', [posts]: 'needs_write_post' });
    expect(prevRun.generated).toEqual([]);
    expect(await journals(pool, co)).toEqual([]);
    for (const t of [future, behind, posts]) expect((await templateState(pool, t)).runs).toBe(0);
  });

  it('manual-journal approval: an agent raises nothing — a held posting template is skipped, a draft is marked', async () => {
    const co = await company(pool, user, [cal.prev, cal.cur], companies);
    await pool.query(
      `INSERT INTO approval_enforcement(company_id, document_type, enabled_by, enabled_at) VALUES($1,'manual_journal',$2,now())`,
      [co.c, user]);
    await pool.query(
      `INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
       VALUES($2,$1,'Journals sign','manual_journal','amount','greater_than',1000,'owner',true)`, [co.c, crypto.randomUUID()]);
    const held = await plantTemplate(pool, co, user, { name: 'Big', frequency: 'monthly', next: day(cal.prev, 5), amount: 1500 });
    const draft = await plantTemplate(pool, co, user, {
      name: 'BigDraft', frequency: 'monthly', next: day(cal.prev, 5), amount: 1500, autoPost: false,
    });
    const small = await plantTemplate(pool, co, user, { name: 'Small', frequency: 'monthly', next: day(cal.prev, 5), amount: 900 });

    const out = parsed(await run(co, cal.prev));
    const byId = Object.fromEntries((out.generated as { recurring_journal_id: string; status: string }[])
      .map((g) => [g.recurring_journal_id, g.status]));
    expect(byId).toEqual({ [draft]: 'draft', [small]: 'posted' });
    expect(out.skipped).toMatchObject([{ recurring_journal_id: held, reason: 'refused' }]);
    expect((out.skipped as Skip[])[0]!.message).toMatch(/cannot raise or decide approvals/);
    expect((await templateState(pool, held)).runs).toBe(0);

    const marked = (await pool.query(
      `SELECT status, approval_document_type FROM gl_journal_entries WHERE company_id = $1 ORDER BY status`, [co.c])).rows;
    expect(marked).toEqual([
      { status: 'draft', approval_document_type: 'manual_journal' },
      { status: 'posted', approval_document_type: 'manual_journal' },
    ]);
    const requests = (await pool.query('SELECT COUNT(*) AS n FROM approval_requests WHERE company_id = $1', [co.c])).rows[0];
    expect(Number(requests.n)).toBe(0);
  });
});

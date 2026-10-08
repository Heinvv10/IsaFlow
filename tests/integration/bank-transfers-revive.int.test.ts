/**
 * POST /api/accounting/bank-transfers, revived (NUMRACE register (b); Hein, 2026-10-08).
 *
 * The route INSERTed its own journal at status 'posted' with columns that do not exist (42703 total_debit, then
 * 23514 source 'bank_transfer'), so it 500ed on every call. It now goes through createJournalEntry + postJournalEntry:
 * source auto_bank_transfer, the JE-<year>-n number the journal trigger mints under 857's key, the covering fiscal
 * period, the VAT-lock and inactive-account guards, and the ledger-date window (422 before anything runs). Both
 * accounts must be the company's own bank accounts; any refusal after the draft exists rolls back to the savepoint.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import bankTransfers from '../../pages/api/accounting/bank-transfers';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture, inTx } from './helpers/l1FifoFixture';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { getUnusualJournals } from '@/modules/accounting/services/reports/unusualJournalsService';
import { callRoute, dataOf, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';
import { seedDateFixture, type DateFixture } from './helpers/numraceDateFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
let c: DateFixture;
let token = '';
let bank2 = '';
let vatInput = '';

type Row = Record<string, unknown>;
const transfers = async () => (await sql`
  SELECT id, entry_number, entry_date::text AS entry_date, status, source, reference, description, fiscal_period_id
  FROM gl_journal_entries WHERE company_id = ${c.fx.companyId}::UUID AND source = 'auto_bank_transfer'
  ORDER BY entry_number`) as Row[];
const journalCount = async () => Number(((await sql`SELECT COUNT(*)::int AS n FROM gl_journal_entries
  WHERE company_id = ${c.fx.companyId}::UUID`) as { n: number }[])[0]!.n);
const post = (body: Record<string, unknown>) => callRoute(c.fx, token, bankTransfers, body);
const seq = (entryNumber: unknown) => Number(String(entryNumber).split('-')[2]);

describeIfDb('bank transfers post through createJournalEntry', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    c = await seedDateFixture('BTXF', DATABASE_URL!);
    token = await seedRouteUser(c.fx, 'btxf');
    const acct = async (code: string, name: string, type: string, subtype: string, normal: string, active = true) =>
      String(((await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
        normal_balance, is_active) VALUES (${c.fx.companyId}::UUID, ${code}, ${name}, ${type}, ${subtype}, ${normal},
        ${active}) RETURNING id`) as Row[])[0]!.id);
    bank2 = await acct('1010', 'BTXF Savings', 'asset', 'bank', 'debit');
    vatInput = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${c.fx.companyId}::UUID
      AND account_code = '1140'`) as Row[])[0]!.id);
  }, 60000);

  afterAll(async () => {
    await sql`DELETE FROM vat_period_locks WHERE company_id = ${c.fx.companyId}::UUID`;
    await sql`DELETE FROM approval_rules WHERE company_id = ${c.fx.companyId}::UUID`;
    await sql`DELETE FROM approval_enforcement WHERE company_id = ${c.fx.companyId}::UUID`;
    await sql`DELETE FROM impersonation_sessions WHERE target_user_id = ${c.fx.userId}`;
    await dropRouteUser(c.fx);
    await dropFixture(c.fx);
  }, 60000);

  it('posts ONE balanced journal: DR destination, CR source, JE-2026-n, auto_bank_transfer, covering period', async () => {
    const out = await post({ fromAccountId: c.fx.bankAccountId, toAccountId: bank2, amount: 250, transferDate: '2026-03-10' });
    process.stdout.write(`BTXF post ${JSON.stringify(out)}\n`);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    const rows = await transfers();
    expect(rows).toHaveLength(1);
    const je = rows[0]!;
    expect(je.status).toBe('posted');
    expect(String(je.entry_number)).toMatch(/^JE-2026-\d+$/);
    expect(je.entry_date).toBe('2026-03-10');
    expect(je.reference).toMatch(/^Transfer: Bank .* -> BTXF Savings$/);
    const period = (await sql`SELECT id FROM fiscal_periods WHERE company_id = ${c.fx.companyId}::UUID
      AND '2026-03-10'::DATE BETWEEN start_date AND end_date`) as Row[];
    expect(je.fiscal_period_id).toBe(period[0]!.id);
    const lines = (await sql`SELECT gl_account_id, debit::float8 AS debit, credit::float8 AS credit
      FROM gl_journal_lines WHERE journal_entry_id = ${je.id}::UUID AND company_id = ${c.fx.companyId}::UUID
      ORDER BY debit DESC`) as Row[];
    expect(lines).toEqual([
      { gl_account_id: bank2, debit: 250, credit: 0 },
      { gl_account_id: c.fx.bankAccountId, debit: 0, credit: 250 },
    ]);
    expect((dataOf<{ journalEntry: { id: string } }>(out)).journalEntry.id).toBe(je.id);
  }, 60000);

  it('two concurrent transfers get consecutive journal numbers', async () => {
    const before = (await transfers()).length;
    const outs = await Promise.all([
      post({ fromAccountId: c.fx.bankAccountId, toAccountId: bank2, amount: 11, transferDate: '2026-03-11' }),
      post({ fromAccountId: bank2, toAccountId: c.fx.bankAccountId, amount: 12, transferDate: '2026-03-11' }),
    ]);
    for (const o of outs) expect(o.statusCode, JSON.stringify(o.body)).toBe(200);
    const rows = (await transfers()).slice(before);
    expect(rows).toHaveLength(2);
    const [a, b] = rows.map((r) => seq(r.entry_number)).sort((x, y) => x - y);
    expect(b).toBe(a! + 1);
  }, 60000);

  it('a date outside 1900..2199 is a 422 before anything is written', async () => {
    const n = await journalCount();
    const out = await post({ fromAccountId: c.fx.bankAccountId, toAccountId: bank2, amount: 5, transferDate: '0001-06-01' });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(422);
    expect(JSON.stringify(out.body)).toMatch(/outside 1900-01-01 to 2199-12-31/);
    expect(await journalCount()).toBe(n);
  }, 60000);

  it.each([
    // The schema's field check, as before the revival (422 VALIDATION_ERROR); the page refuses it first.
    ['the same account twice', 422, () => ({ toAccountId: c.fx.bankAccountId })],
    ['a missing account', 400, () => ({ toAccountId: '00000000-0000-4000-8000-0000000000f1' })],
    ['a non-bank account (VAT input)', 400, () => ({ toAccountId: vatInput })],
    ['an uncastable date', 422, () => ({ toAccountId: bank2, transferDate: 'garbage' })],
    ['an amount with fractions of a cent', 422, () => ({ toAccountId: bank2, amount: 1.005 })],
  ])('%s is refused (%i) with nothing written', async (_label, status, extra) => {
    const n = await journalCount();
    const out = await post({ fromAccountId: c.fx.bankAccountId, amount: 5, transferDate: '2026-03-12', ...extra() });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(status);
    expect(JSON.stringify(out.body)).not.toMatch(/invalid input syntax|SQLSTATE|relation/);
    expect(await journalCount()).toBe(n);
  }, 60000);

  it('a closed fiscal period is a 400, and the draft created before the refusal is rolled back', async () => {
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES (${c.fx.companyId}::UUID, ${`FY24 ${c.fx.tag}`}, 1, 2024, '2024-01-01', '2024-12-31', 'closed')`;
    const n = await journalCount();
    const out = await post({ fromAccountId: c.fx.bankAccountId, toAccountId: bank2, amount: 5, transferDate: '2024-06-01' });
    process.stdout.write(`BTXF closed ${JSON.stringify(out)}\n`);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(await journalCount()).toBe(n);
  }, 60000);

  it('an inactive bank account is a 400 with nothing written', async () => {
    const dormant = String(((await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
      account_subtype, normal_balance, is_active) VALUES (${c.fx.companyId}::UUID, '1020', 'BTXF Dormant', 'asset',
      'bank', 'debit', false) RETURNING id`) as Row[])[0]!.id);
    const n = await journalCount();
    const out = await post({ fromAccountId: c.fx.bankAccountId, toAccountId: dormant, amount: 5, transferDate: '2026-03-13' });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(await journalCount()).toBe(n);
  }, 60000);

  it('inside a filed (locked) VAT period: a bank-to-bank transfer moves no VAT figure, so it posts', async () => {
    await sql`INSERT INTO vat_period_locks (company_id, period_start, period_end, output_tax, input_tax, net_vat,
      posted_through, locked_by) VALUES (${c.fx.companyId}::UUID, '2025-01-01', '2025-02-28', 0, 0, 0, '2025-02-28',
      ${c.fx.userId}::UUID)`;
    const out = await post({ fromAccountId: c.fx.bankAccountId, toAccountId: bank2, amount: 7, transferDate: '2025-02-10' });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    expect((await transfers()).some((r) => r.entry_date === '2025-02-10' && String(r.entry_number).startsWith('JE-2025-')))
      .toBe(true);
  }, 60000);

  // R-035 PR6: a transfer is a journal a person composed with no bank line as evidence (as a hand-keyed bank line
  // transferred to another bank account is, bankLineJournalGate round 4), so under manual-journal enforcement a rule
  // matching the amount refuses it 409 before any write; one that does not match lets it post.
  it('under manual-journal enforcement: a matching rule refuses it 409 with nothing written; below the rule it posts', async () => {
    await sql`INSERT INTO approval_enforcement (company_id, document_type, enabled_by)
      VALUES (${c.fx.companyId}::UUID, 'manual_journal', ${c.fx.userId}::UUID)`;
    await sql`INSERT INTO approval_rules (company_id, name, document_type, condition_field, condition_operator,
      condition_value, approver_role, is_active)
      VALUES (${c.fx.companyId}::UUID, 'BTXF over 100', 'manual_journal', 'amount', 'greater_than', 100, 'admin', true)`;
    const n = await journalCount();
    const held = await post({ fromAccountId: c.fx.bankAccountId, toAccountId: bank2, amount: 150, transferDate: '2026-03-14' });
    process.stdout.write(`BTXF gated ${JSON.stringify(held)}\n`);
    expect(held.statusCode, JSON.stringify(held.body)).toBe(409);
    expect(JSON.stringify(held.body)).toMatch(/needs admin approval/);
    expect(await journalCount()).toBe(n);
    const ok = await post({ fromAccountId: c.fx.bankAccountId, toAccountId: bank2, amount: 9, transferDate: '2026-03-14' });
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    expect(await journalCount()).toBe(n + 1);
    // The rule stays out of the later tests' way.
    await sql`DELETE FROM approval_rules WHERE company_id = ${c.fx.companyId}::UUID`;
    await sql`DELETE FROM approval_enforcement WHERE company_id = ${c.fx.companyId}::UUID`;
  }, 60000);

  // R-032 L5 (sec-nrfa M1): a Login-as session is refused 403 before anything is read or written.
  it('a Login-as (impersonation) session is refused 403 with nothing written', async () => {
    const sessionId = crypto.randomUUID();
    await sql`INSERT INTO impersonation_sessions (session_id, actor_user_id, target_user_id)
      VALUES (${sessionId}, ${crypto.randomUUID()}, ${c.fx.userId})`;
    const impersonated = await new SignJWT({ sub: c.fx.userId, aal: 'aal2', session_id: sessionId })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
    const n = await journalCount();
    const out = await callRoute(c.fx, impersonated, bankTransfers,
      { fromAccountId: c.fx.bankAccountId, toAccountId: bank2, amount: 9, transferDate: '2026-03-15' });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(403);
    expect(JSON.stringify(out.body)).toMatch(/impersonating/);
    expect(await journalCount()).toBe(n);
  }, 60000);

  // brk-nrfa M1: the statement line of a movement already posted on the Transfers page must be matched to that
  // journal, not allocated as a second transfer (which doubled the movement in the GL).
  it("a bank line allocated as the transfer a Transfers-page journal already posted is refused, nothing written", async () => {
    const posted = await post({ fromAccountId: c.fx.bankAccountId, toAccountId: bank2, amount: 1000, transferDate: '2026-04-20' });
    expect(posted.statusCode, JSON.stringify(posted.body)).toBe(200);
    const line = String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
      description, import_batch_id, status) VALUES (${c.fx.companyId}::UUID, ${bank2}::UUID, '2026-04-21', 1000, 'BTXF stmt in', gen_random_uuid(), 'imported')
      RETURNING id`) as Row[])[0]!.id);
    const n = await journalCount();
    const err = await inTx(c.fx, () => allocateTransaction(c.fx.companyId, line, c.fx.bankAccountId, c.fx.userId,
      'BTXF from Transfers', 'transfer')).then(() => null, (e: unknown) => e);
    expect(String(err)).toMatch(/A matching transfer already exists/);
    expect(await journalCount()).toBe(n);
    const after = ((await sql`SELECT status FROM bank_transactions WHERE id = ${line}::UUID`) as Row[])[0]!;
    expect(after.status).toBe('imported');
  }, 60000);

  // sec-nrfa M2 / brk-nrfa M2: a typed transfer is tested for a round number; a pointer alone is not evidence.
  it('the board pack flags a typed R50 000 transfer as a round number, even with a stale pointer to it', async () => {
    const out = await post({ fromAccountId: c.fx.bankAccountId, toAccountId: bank2, amount: 50000, transferDate: '2026-05-05' });
    const id = (dataOf<{ journalEntry: { id: string } }>(out)).journalEntry.id;
    // An unrelated, unmatched line left pointing at it (a match then an unmatch leaves the pointer set).
    await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, import_batch_id, status,
      transfer_journal_entry_id) VALUES (${c.fx.companyId}::UUID, ${bank2}::UUID, '2026-05-05', -12.34, 'BTXF stale', gen_random_uuid(), 'imported',
      ${id}::UUID)`;
    const r = await getUnusualJournals(c.fx.companyId, { start: '2026-05-01', end: '2026-05-31' });
    expect(r.flags.find((f) => f.entryId === id)?.reason).toBe('round_number');
  }, 60000);

  // brk-nrfa L3: a bank-line transfer and its reversal carry the line's amount; neither is a typed round number.
  it('a bank-line transfer of R60 000 and its reversal are not flagged as round numbers', async () => {
    const line = String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
      description, import_batch_id, status) VALUES (${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, '2026-06-10', -60000,
      'BTXF line out', gen_random_uuid(), 'imported') RETURNING id`) as Row[])[0]!.id);
    await inTx(c.fx, () => allocateTransaction(c.fx.companyId, line, bank2, c.fx.userId, 'BTXF line transfer', 'transfer'));
    const je = String(((await sql`SELECT transfer_journal_entry_id AS id FROM bank_transactions WHERE id = ${line}::UUID`) as Row[])[0]!.id);
    const reversal = await inTx(c.fx, () => reverseJournalEntry(c.fx.companyId, je, c.fx.userId, { reversalDate: '2026-06-11' }));
    const r = await getUnusualJournals(c.fx.companyId, { start: '2026-06-01', end: '2026-06-30' });
    const flagged = r.flags.filter((f) => f.reason === 'round_number').map((f) => f.entryId);
    expect(flagged).not.toContain(je);
    expect(flagged).not.toContain((reversal as { id: string }).id);
  }, 60000);

  // rev-nrfa LOW-1: the other order — the statement recorded the transfer first; typing it on the page is refused.
  it('a movement the statement already recorded needs a confirmation on the Transfers page (428), then posts', async () => {
    const line = String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
      description, import_batch_id, status) VALUES (${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, '2026-07-01', -777,
      'BTXF stmt out', gen_random_uuid(), 'imported') RETURNING id`) as Row[])[0]!.id);
    await inTx(c.fx, () => allocateTransaction(c.fx.companyId, line, bank2, c.fx.userId, 'BTXF stmt transfer', 'transfer'));
    const n = await journalCount();
    const out = await post({ fromAccountId: c.fx.bankAccountId, toAccountId: bank2, amount: 777, transferDate: '2026-07-02' });
    // A possible duplicate needs the person's confirmation (brk-nrfa round 3 M2): 428, nothing written.
    expect(out.statusCode, JSON.stringify(out.body)).toBe(428);
    expect(JSON.stringify(out.body)).toMatch(/already in the ledger as JE-2026-/);
    expect(await journalCount()).toBe(n);
    const confirmed = await post({ fromAccountId: c.fx.bankAccountId, toAccountId: bank2, amount: 777,
      transferDate: '2026-07-02', confirmDuplicate: true });
    expect(confirmed.statusCode, JSON.stringify(confirmed.body)).toBe(200);
    expect(await journalCount()).toBe(n + 1);
    // The opposite direction is a different movement: posted.
    const back = await post({ fromAccountId: bank2, toAccountId: c.fx.bankAccountId, amount: 777, transferDate: '2026-07-02' });
    expect(back.statusCode, JSON.stringify(back.body)).toBe(200);
  }, 60000);

  // rev-nrfa LOW-2: a typed B -> A transfer does not block a statement line moving A -> B.
  it('a typed transfer in the other direction does not refuse a bank-line transfer', async () => {
    const typed = await post({ fromAccountId: bank2, toAccountId: c.fx.bankAccountId, amount: 555, transferDate: '2026-07-10' });
    expect(typed.statusCode, JSON.stringify(typed.body)).toBe(200);
    const line = String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
      description, import_batch_id, status) VALUES (${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, '2026-07-10', -555,
      'BTXF stmt out 2', gen_random_uuid(), 'imported') RETURNING id`) as Row[])[0]!.id);
    await inTx(c.fx, () => allocateTransaction(c.fx.companyId, line, bank2, c.fx.userId, 'BTXF out A to B', 'transfer'));
    const after = ((await sql`SELECT status FROM bank_transactions WHERE id = ${line}::UUID`) as Row[])[0]!;
    expect(after.status).toBe('allocated');
  }, 60000);

  // rev-nrfa round 3 LOW-1: a typed transfer matched to its statement line does not refuse a second real one.
  it('a second typed transfer of the same amount is posted even after the first was matched to its statement line', async () => {
    const first = await post({ fromAccountId: c.fx.bankAccountId, toAccountId: bank2, amount: 10000, transferDate: '2026-08-03' });
    const id = (dataOf<{ journalEntry: { id: string } }>(first)).journalEntry.id;
    // The statement line matched to it (what bank-match-confirm's bank_transfer arm writes).
    await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, import_batch_id, status,
      transfer_journal_entry_id, counterparty_account_id) VALUES (${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID,
      '2026-08-03', -10000, 'BTXF matched out', gen_random_uuid(), 'matched', ${id}::UUID, ${bank2}::UUID)`;
    const second = await post({ fromAccountId: c.fx.bankAccountId, toAccountId: bank2, amount: 10000, transferDate: '2026-08-04' });
    expect(second.statusCode, JSON.stringify(second.body)).toBe(200);
  }, 60000);

  // sec-nrfa round 3 L1: a line is evidence only on one of the journal's bank legs, on the side its sign says.
  it('an unrelated line matched to a typed transfer does not hide its round number; its real line does', async () => {
    const third = String(((await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
      account_subtype, normal_balance, is_active) VALUES (${c.fx.companyId}::UUID, '1030', 'BTXF Third', 'asset', 'bank',
      'debit', true) RETURNING id`) as Row[])[0]!.id);
    const out = await post({ fromAccountId: c.fx.bankAccountId, toAccountId: bank2, amount: 50000, transferDate: '2026-09-07' });
    const id = (dataOf<{ journalEntry: { id: string } }>(out)).journalEntry.id;
    // Each line is matched to the journal's leg on its own bank, as a real match leaves it (brk-nrfa round 5 F3).
    const line = (bank: string, amount: number) => sql`INSERT INTO bank_transactions (company_id, bank_account_id,
      transaction_date, amount, description, import_batch_id, status, transfer_journal_entry_id, matched_journal_line_id)
      VALUES (${c.fx.companyId}::UUID, ${bank}::UUID, '2026-09-07', ${amount}, 'BTXF ev', gen_random_uuid(), 'matched',
      ${id}::UUID, (SELECT jl.id FROM gl_journal_lines jl WHERE jl.journal_entry_id = ${id}::UUID
        AND jl.gl_account_id = ${bank}::UUID AND jl.company_id = ${c.fx.companyId}::UUID))`;
    const flagged = async () => (await getUnusualJournals(c.fx.companyId, { start: '2026-09-01', end: '2026-09-30' }))
      .flags.some((f) => f.entryId === id && f.reason === 'round_number');
    await line(third, 50000); // a bank the transfer never touched
    expect(await flagged()).toBe(true);
    await line(bank2, -50000); // the destination bank, but money OUT of it
    expect(await flagged()).toBe(true);
    // One statement line per leg: the wrong-sign line goes before the right one arrives.
    await sql`DELETE FROM bank_transactions WHERE company_id = ${c.fx.companyId}::UUID AND bank_account_id = ${bank2}::UUID
      AND amount = -50000 AND description = 'BTXF ev'`;
    await line(bank2, 50000); // the destination bank, money in: the statement line of this very movement
    expect(await flagged()).toBe(false);
  }, 60000);

  // brk-nrfa round 3 M2(a): a typed transfer tied to its statement line by an ORDINARY match does not block the
  // statement line of a second real transfer.
  it('a typed transfer reconciled through an ordinary match does not refuse a second transfer from the statement', async () => {
    const typed = await post({ fromAccountId: c.fx.bankAccountId, toAccountId: bank2, amount: 2222, transferDate: '2026-10-01' });
    const id = (dataOf<{ journalEntry: { id: string } }>(typed)).journalEntry.id;
    const leg = String(((await sql`SELECT id FROM gl_journal_lines WHERE journal_entry_id = ${id}::UUID
      AND gl_account_id = ${c.fx.bankAccountId}::UUID`) as Row[])[0]!.id);
    await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, import_batch_id, status,
      matched_journal_line_id) VALUES (${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, '2026-10-01', -2222,
      'BTXF matched first', gen_random_uuid(), 'matched', ${leg}::UUID)`;
    const second = String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date,
      amount, description, import_batch_id, status) VALUES (${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, '2026-10-02', -2222,
      'BTXF second', gen_random_uuid(), 'imported') RETURNING id`) as Row[])[0]!.id);
    await inTx(c.fx, () => allocateTransaction(c.fx.companyId, second, bank2, c.fx.userId, 'BTXF second transfer', 'transfer'));
    expect(((await sql`SELECT status FROM bank_transactions WHERE id = ${second}::UUID`) as Row[])[0]!.status).toBe('allocated');
  }, 60000);

  // brk-nrfa round 3 M2(b): identical transfers swept from the statement on consecutive days are not duplicates.
  it('a daily sweep of identical statement transfers is not refused', async () => {
    for (const day of ['2026-10-12', '2026-10-13']) {
      const id = String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
        description, import_batch_id, status) VALUES (${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, ${day}::DATE, -333,
        'BTXF sweep', gen_random_uuid(), 'imported') RETURNING id`) as Row[])[0]!.id);
      await inTx(c.fx, () => allocateTransaction(c.fx.companyId, id, bank2, c.fx.userId, 'BTXF sweep', 'transfer'));
    }
    const n = Number(((await sql`SELECT COUNT(*)::int AS n FROM bank_transactions WHERE company_id = ${c.fx.companyId}::UUID
      AND description LIKE 'BTXF sweep%' AND status = 'allocated'`) as Row[])[0]!.n);
    expect(n).toBe(2);
  }, 60000);

  // brk-nrfa round 3 L4: a Friday transfer that clears on Monday (D+3) is the same movement.
  it('the statement line of a typed transfer three days later is refused (match it instead)', async () => {
    await post({ fromAccountId: c.fx.bankAccountId, toAccountId: bank2, amount: 909, transferDate: '2026-10-16' });
    const id = String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
      description, import_batch_id, status) VALUES (${c.fx.companyId}::UUID, ${bank2}::UUID, '2026-10-19', 909, 'BTXF monday', gen_random_uuid(), 'imported')
      RETURNING id`) as Row[])[0]!.id);
    const err = await inTx(c.fx, () => allocateTransaction(c.fx.companyId, id, c.fx.bankAccountId, c.fx.userId,
      'BTXF monday in', 'transfer')).then(() => null, (e: unknown) => e);
    expect(String(err)).toMatch(/A matching transfer already exists/);
  }, 60000);

  // brk-nrfa round 3 L3: a statement transfer reversed from the bank keeps its evidence; a typed one never gains it.
  it('round numbers after reversals: a statement transfer and its reversal are not flagged; a typed one is', async () => {
    const line = String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
      description, import_batch_id, status) VALUES (${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, '2026-11-03', -80000,
      'BTXF to reverse', gen_random_uuid(), 'imported') RETURNING id`) as Row[])[0]!.id);
    await inTx(c.fx, () => allocateTransaction(c.fx.companyId, line, bank2, c.fx.userId, 'BTXF stmt 80k', 'transfer'));
    const stmtJe = String(((await sql`SELECT transfer_journal_entry_id AS id FROM bank_transactions WHERE id = ${line}::UUID`) as Row[])[0]!.id);
    const stmtRev = await inTx(c.fx, () => reverseJournalEntry(c.fx.companyId, stmtJe, c.fx.userId, { reversalDate: '2026-11-04' }));
    await sql`UPDATE bank_transactions SET status = 'imported', matched_journal_line_id = NULL WHERE id = ${line}::UUID`;
    const typed = await post({ fromAccountId: c.fx.bankAccountId, toAccountId: bank2, amount: 70000, transferDate: '2026-11-05' });
    const typedJe = (dataOf<{ journalEntry: { id: string } }>(typed)).journalEntry.id;
    // A stale pointer at the typed journal (matched, then unmatched: status back to imported, pointer left set).
    await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, import_batch_id, status,
      transfer_journal_entry_id) VALUES (${c.fx.companyId}::UUID, ${bank2}::UUID, '2026-11-05', 70000, 'BTXF stale', gen_random_uuid(),
      'imported', ${typedJe}::UUID)`;
    const typedRev = await inTx(c.fx, () => reverseJournalEntry(c.fx.companyId, typedJe, c.fx.userId, { reversalDate: '2026-11-06' }));
    const flagged = (await getUnusualJournals(c.fx.companyId, { start: '2026-11-01', end: '2026-11-30' }))
      .flags.filter((f) => f.reason === 'round_number').map((f) => f.entryId);
    expect(flagged).not.toContain(stmtJe);
    expect(flagged).not.toContain((stmtRev as { id: string }).id);
    expect(flagged).toContain(typedJe);
    expect(flagged).toContain((typedRev as { id: string }).id);
  }, 60000);

  // brk-nrfa round 3 M2(b): only a TYPED journal counts in the journal arm — a statement-created transfer four days
  // earlier (outside the line arm's two days) does not refuse another statement line.
  it('a statement-created transfer does not refuse a later statement transfer of the same amount', async () => {
    const inB = String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
      description, import_batch_id, status) VALUES (${c.fx.companyId}::UUID, ${bank2}::UUID, '2026-12-01', 444, 'BTXF B in', gen_random_uuid(), 'imported')
      RETURNING id`) as Row[])[0]!.id);
    await inTx(c.fx, () => allocateTransaction(c.fx.companyId, inB, c.fx.bankAccountId, c.fx.userId, 'BTXF B from A', 'transfer'));
    const outA = String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
      description, import_batch_id, status) VALUES (${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, '2026-12-05', -444, 'BTXF A out', gen_random_uuid(),
      'imported') RETURNING id`) as Row[])[0]!.id);
    await inTx(c.fx, () => allocateTransaction(c.fx.companyId, outA, bank2, c.fx.userId, 'BTXF A to B', 'transfer'));
    expect(((await sql`SELECT status FROM bank_transactions WHERE id = ${outA}::UUID`) as Row[])[0]!.status).toBe('allocated');
  }, 60000);

  // brk-nrfa round 4 LOW-1: a statement transfer reversed from the bank and its line re-allocated elsewhere stays a
  // document's amount (it was flagged once the pointer moved); a typed transfer's reversal chain stays flagged.
  it('round numbers: a reversed statement transfer whose line was re-allocated, and a typed reversal chain', async () => {
    const line = String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
      description, import_batch_id, status) VALUES (${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, '2027-01-11', -60000,
      'BTXF realloc', gen_random_uuid(), 'imported') RETURNING id`) as Row[])[0]!.id);
    await inTx(c.fx, () => allocateTransaction(c.fx.companyId, line, bank2, c.fx.userId, 'BTXF realloc 60k', 'transfer'));
    const stmtJe = String(((await sql`SELECT transfer_journal_entry_id AS id FROM bank_transactions WHERE id = ${line}::UUID`) as Row[])[0]!.id);
    const stmtRev = await inTx(c.fx, () => reverseJournalEntry(c.fx.companyId, stmtJe, c.fx.userId, { reversalDate: '2027-01-12' }));
    // The bank reversal frees the line; re-allocated, its pointer no longer names the original.
    await sql`UPDATE bank_transactions SET status = 'imported', matched_journal_line_id = NULL, transfer_journal_entry_id = NULL
      WHERE id = ${line}::UUID`;
    const typed = await post({ fromAccountId: c.fx.bankAccountId, toAccountId: bank2, amount: 90000, transferDate: '2027-01-13' });
    const typedJe = (dataOf<{ journalEntry: { id: string } }>(typed)).journalEntry.id;
    const r1 = await inTx(c.fx, () => reverseJournalEntry(c.fx.companyId, typedJe, c.fx.userId, { reversalDate: '2027-01-14' }));
    const flagged = (await getUnusualJournals(c.fx.companyId, { start: '2027-01-01', end: '2027-01-31' }))
      .flags.filter((f) => f.reason === 'round_number').map((f) => f.entryId);
    expect(flagged).not.toContain(stmtJe);
    expect(flagged).not.toContain((stmtRev as { id: string }).id);
    expect(flagged).toContain(typedJe);
    expect(flagged).toContain((r1 as { id: string }).id);
  }, 60000);

  // brk-nrfa rounds 3-4 / rev-nrfa round 4 LOW-2: arm 1 skips a counterparty transfer already paired with a line on
  // this bank — the next day's identical transfer from the statement is another movement.
  it("the other bank's line of an already paired transfer does not refuse the next day's identical transfer", async () => {
    const monA = String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
      description, import_batch_id, status) VALUES (${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, '2027-02-01', -555,
      'BTXF mon A', gen_random_uuid(), 'imported') RETURNING id`) as Row[])[0]!.id);
    await inTx(c.fx, () => allocateTransaction(c.fx.companyId, monA, bank2, c.fx.userId, 'BTXF mon', 'transfer'));
    const j1 = String(((await sql`SELECT transfer_journal_entry_id AS id FROM bank_transactions WHERE id = ${monA}::UUID`) as Row[])[0]!.id);
    // Monday's B line matched to the same journal (what the transfer match writes).
    await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, import_batch_id, status,
      transfer_journal_entry_id, counterparty_account_id) VALUES (${c.fx.companyId}::UUID, ${bank2}::UUID, '2027-02-01',
      555, 'BTXF mon B', gen_random_uuid(), 'matched', ${j1}::UUID, ${c.fx.bankAccountId}::UUID)`;
    const tueA = String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
      description, import_batch_id, status) VALUES (${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, '2027-02-02', -555,
      'BTXF tue A', gen_random_uuid(), 'imported') RETURNING id`) as Row[])[0]!.id);
    await inTx(c.fx, () => allocateTransaction(c.fx.companyId, tueA, bank2, c.fx.userId, 'BTXF tue', 'transfer'));
    expect(((await sql`SELECT status FROM bank_transactions WHERE id = ${tueA}::UUID`) as Row[])[0]!.status).toBe('allocated');
  }, 60000);

  // sec-nrfa round 4 M1: a transfer allocated from a HAND-KEYED line (no import, no feed) is a typed amount — its
  // journal carries a reference, its round number is flagged, and it never reads as "recorded from the statement".
  it('a hand-keyed transfer: referenced, flagged as a round number, and no 428 on the next typed one', async () => {
    const hand = String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
      description, status) VALUES (${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, '2027-03-02', -60000,
      'BTXF hand', 'imported') RETURNING id`) as Row[])[0]!.id);
    await inTx(c.fx, () => allocateTransaction(c.fx.companyId, hand, bank2, c.fx.userId, 'BTXF hand transfer', 'transfer'));
    const je = ((await sql`SELECT je.id, je.reference FROM bank_transactions bt JOIN gl_journal_entries je
      ON je.id = bt.transfer_journal_entry_id WHERE bt.id = ${hand}::UUID`) as Row[])[0]!;
    expect(je.reference).toBe('No statement or feed line');
    const flagged = (await getUnusualJournals(c.fx.companyId, { start: '2027-03-01', end: '2027-03-31' }))
      .flags.filter((f) => f.reason === 'round_number').map((f) => f.entryId);
    expect(flagged).toContain(je.id);
    const next = await post({ fromAccountId: c.fx.bankAccountId, toAccountId: bank2, amount: 60000, transferDate: '2027-03-03' });
    expect(next.statusCode, JSON.stringify(next.body)).toBe(200);
  }, 60000);
});

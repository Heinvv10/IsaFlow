/**
 * Audit row 4 — a match may tie a statement line only to a journal line that IS that line's bank movement: on the
 * line's own GL bank account, in its direction, for its exact amount, on a POSTED journal of the same company.
 *
 * `assertMatchTargets` checked only that the line existed in the company, was not reversed and was not claimed, so a
 * R500 payment could be "matched" to a R500.01 line, to the other bank's leg of a transfer, to the expense leg of a
 * journal, to a deposit, or to a DRAFT journal — the line then read as reconciled against money the bank account
 * never moved. Every writer that binds `matched_journal_line_id` to an EXISTING line goes through the same predicate:
 * the match routes (`journal_line`, `bank_transfer`, `match`), auto-match, and the transfer link passes.
 *
 * Each refusal is proven by outcome: the status the route answers, and the statement line left exactly as imported.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import { relinkTransferCounterparts } from '../../src/modules/accounting/services/bank/bankTransferLinkService';
import { fetchJournalLineCandidates } from '../../src/modules/accounting/services/bank/bankMatchDbQueries';
import { actionRoute, asToken, bankCompany, cleanupBankControlsA, refusalOf, type BankCompany } from './bank-controls-a.helpers';
import { confirmRoute, linkOf, plantBankLine, plantJe, UNTOUCHED } from './bank-match-targets.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let f: BankCompany;
let foreign: BankCompany;
let act: ReturnType<typeof actionRoute>;
let confirm: ReturnType<typeof confirmRoute>;

beforeAll(async () => {
  a = await createUser(pool, tokens);
  f = await bankCompany(pool, [[a, 'admin']], companies);
  foreign = await bankCompany(pool, [[a, 'admin']], companies);
  act = actionRoute(tokens);
  confirm = confirmRoute(tokens);
});
afterAll(async () => {
  await pool.query('DELETE FROM bank_transfer_link_log WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a]); // ends the pool
});

/** The three entry points a person reaches a hand match through. */
const viaJournalLine = (line: string, target: string) =>
  confirm(a, f.c, { bankTransactionId: line, candidateType: 'journal_line', candidateId: target });
const viaAction = (line: string, target: string) =>
  act(a, f.c, { action: 'match', bankTransactionId: line, journalLineId: target });

/** A payment of R500 (money out) and the journal line each case offers it. */
const cases: [string, () => Promise<string>, RegExp][] = [
  ['another account (the expense leg)', async () => (await plantJe(pool, f.c, a, [[f.expA, 500, 0], [f.bank, 0, 500]])).lines[0]!,
    /bank account/i],
  ['the other bank account', async () => (await plantJe(pool, f.c, a, [[f.expA, 500, 0], [f.bank2, 0, 500]])).lines[1]!,
    /bank account/i],
  ['the wrong direction (a deposit)', async () => (await plantJe(pool, f.c, a, [[f.bank, 500, 0], [f.expA, 0, 500]])).lines[0]!,
    /direction|money (in|out)/i],
  ['a different amount by one cent', async () => (await plantJe(pool, f.c, a, [[f.expA, 500.01, 0], [f.bank, 0, 500.01]])).lines[1]!,
    /amount/i],
  ['a draft journal', async () => (await plantJe(pool, f.c, a, [[f.expA, 500, 0], [f.bank, 0, 500]], { status: 'draft' })).lines[1]!,
    /posted/i],
  ['another company\'s line', async () => (await plantJe(pool, foreign.c, a, [[foreign.expA, 500, 0], [foreign.bank, 0, 500]])).lines[1]!,
    /not found/i],
];

describe('a hand match refuses a journal line that is not this statement line\'s bank movement', () => {
  it.each(cases)('journal_line confirm and the match action refuse %s with 400, the line untouched', async (_name, target, why) => {
    const line = await plantBankLine(pool, f.c, f.bank, -500);
    const jl = await target();
    const viaConfirm = refusalOf(await viaJournalLine(line, jl));
    expect({ status: viaConfirm.status, line: await linkOf(pool, line) }).toEqual({ status: 400, line: UNTOUCHED });
    expect(viaConfirm.message).toMatch(why);
    const viaMatch = refusalOf(await viaAction(line, jl));
    expect({ status: viaMatch.status, line: await linkOf(pool, line) }).toEqual({ status: 400, line: UNTOUCHED });
  });

  it('the line\'s own bank leg, same direction, exact amount, posted, still matches — and only once', async () => {
    const line = await plantBankLine(pool, f.c, f.bank, -500);
    const twin = await plantBankLine(pool, f.c, f.bank, -500);
    const jl = (await plantJe(pool, f.c, a, [[f.expA, 500, 0], [f.bank, 0, 500]])).lines[1]!;
    const ok = await viaJournalLine(line, jl);
    expect(ok.state.statusCode, JSON.stringify(ok.state.body)).toBe(200);
    expect(await linkOf(pool, line)).toMatchObject({ status: 'matched', line: jl });
    // The same journal line for a second statement line: claimed, 409, the twin untouched.
    expect({ status: refusalOf(await viaJournalLine(twin, jl)).status, twin: await linkOf(pool, twin) })
      .toEqual({ status: 409, twin: UNTOUCHED });
  });
});

describe('the bank_transfer arm applies the same predicate', () => {
  it('refuses the OTHER bank\'s leg and an amount the leg does not carry; matches this bank\'s exact leg', async () => {
    // A R500 transfer bank2 -> bank, posted by the source line's allocation.
    const t = await plantJe(pool, f.c, a, [[f.bank, 500, 0], [f.bank2, 0, 500]], { source: 'auto_bank_transfer' });
    const viaTransfer = (line: string, target: string) =>
      confirm(a, f.c, { bankTransactionId: line, candidateType: 'bank_transfer', candidateId: target });
    const deposit = await plantBankLine(pool, f.c, f.bank, 500);
    // bank2's leg is bank2's movement, not this deposit's.
    expect({ status: refusalOf(await viaTransfer(deposit, t.lines[1]!)).status, line: await linkOf(pool, deposit) })
      .toEqual({ status: 400, line: UNTOUCHED });
    const bigger = await plantBankLine(pool, f.c, f.bank, 600);
    expect({ status: refusalOf(await viaTransfer(bigger, t.lines[0]!)).status, line: await linkOf(pool, bigger) })
      .toEqual({ status: 400, line: UNTOUCHED });
    const ok = await viaTransfer(deposit, t.lines[0]!);
    expect(ok.state.statusCode, JSON.stringify(ok.state.body)).toBe(200);
    expect(await linkOf(pool, deposit)).toMatchObject({ status: 'matched', line: t.lines[0], type: 'transfer' });
  });
});

describe('the unattended writers skip a line that does not fit', () => {
  it('auto-match counts a one-cent-off pair as refused and leaves the line imported', async () => {
    const g = await bankCompany(pool, [[a, 'admin']], companies);
    const line = await plantBankLine(pool, g.c, g.bank, -500);
    await plantJe(pool, g.c, a, [[g.expA, 500.01, 0], [g.bank, 0, 500.01]]);
    const res = await act(a, g.c, { action: 'auto_match', bankAccountId: g.bank });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect((res.state.body as { data: Record<string, unknown> }).data).toMatchObject({ matched: 0, skippedRefused: 1 });
    expect(await linkOf(pool, line)).toEqual(UNTOUCHED);
  });

  it('the transfer relink does not tie a R500 deposit to a R100 leg of a split journal', async () => {
    const g = await bankCompany(pool, [[a, 'admin']], companies);
    // bank2 paid R500, split R400 to expense and R100 to this bank: the R100 leg is the only line here on `bank`.
    const split = await plantJe(pool, g.c, a, [[g.expA, 400, 0], [g.bank, 100, 0], [g.bank2, 0, 500]]);
    await pool.query(
      `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status,
         allocation_type, matched_journal_line_id)
       VALUES($1,$2,DATE '2026-09-01',-500,'MT source','allocated','account',$3)`, [g.c, g.bank2, split.lines[2]]);
    const deposit = await plantBankLine(pool, g.c, g.bank, 500);
    const r = await asToken(pool, a, g.c, () => relinkTransferCounterparts(g.c, g.bank,
      { source: 'page_load', linkBatchId: crypto.randomUUID() }));
    expect({ linked: r.linked, failed: r.failed, line: await linkOf(pool, deposit) })
      .toEqual({ linked: 0, failed: false, line: UNTOUCHED });
  });
});

describe('the match picker offers exactly what the confirm accepts', () => {
  it('lists the exact posted bank leg, never a near amount, the other direction, another account, a draft or a reversed journal', async () => {
    const g = await bankCompany(pool, [[a, 'admin']], companies);
    const line = await plantBankLine(pool, g.c, g.bank, -500);
    const exact = (await plantJe(pool, g.c, a, [[g.expA, 500, 0], [g.bank, 0, 500]])).lines[1]!;
    const near = (await plantJe(pool, g.c, a, [[g.expA, 500.01, 0], [g.bank, 0, 500.01]])).lines[1]!;
    const deposit = (await plantJe(pool, g.c, a, [[g.bank, 500, 0], [g.expA, 0, 500]])).lines[0]!;
    const otherBank = (await plantJe(pool, g.c, a, [[g.expA, 500, 0], [g.bank2, 0, 500]])).lines[1]!;
    const draft = (await plantJe(pool, g.c, a, [[g.expA, 500, 0], [g.bank, 0, 500]], { status: 'draft' })).lines[1]!;
    // Reversed in the GL: the original carries reversed_at, its posted contra moves the money back.
    const undone = await plantJe(pool, g.c, a, [[g.expA, 500, 0], [g.bank, 0, 500]]);
    const contra = await plantJe(pool, g.c, a, [[g.bank, 500, 0], [g.expA, 0, 500]]);
    await pool.query('UPDATE gl_journal_entries SET reversal_of_id = $1 WHERE id = $2', [undone.je, contra.je]);
    await pool.query('UPDATE gl_journal_entries SET reversed_at = now() WHERE id = $1', [undone.je]);
    const offered = (await asToken(pool, a, g.c, () => fetchJournalLineCandidates(g.c, -500, '2026-09-01', 'MT line', g.bank)))
      .map((x) => x.id);
    expect(offered).toEqual([exact]);
    for (const refused of [near, deposit, otherBank, draft, undone.lines[1]!]) expect(offered).not.toContain(refused);
    // And what it offers, the confirm takes.
    const ok = await confirm(a, g.c, { bankTransactionId: line, candidateType: 'journal_line', candidateId: exact });
    expect(ok.state.statusCode, JSON.stringify(ok.state.body)).toBe(200);
  });
});

describe('a reversing journal\'s bank leg: picker and confirm agree (PR #1458 round 2)', () => {
  it('a returned payment\'s statement line is offered the reversal\'s bank leg, and the confirm takes it', async () => {
    const g = await bankCompany(pool, [[a, 'admin']], companies);
    // A R500 payment out, reversed in the GL: the reversal debits the bank — the money coming back.
    const paid = await plantJe(pool, g.c, a, [[g.expA, 500, 0], [g.bank, 0, 500]]);
    const back = await plantJe(pool, g.c, a, [[g.bank, 500, 0], [g.expA, 0, 500]]);
    await pool.query('UPDATE gl_journal_entries SET reversal_of_id = $1 WHERE id = $2', [paid.je, back.je]);
    await pool.query('UPDATE gl_journal_entries SET reversed_at = now() WHERE id = $1', [paid.je]);
    const returned = await plantBankLine(pool, g.c, g.bank, 500);
    const offered = (await asToken(pool, a, g.c, () => fetchJournalLineCandidates(g.c, 500, '2026-09-01', 'MT returned', g.bank)))
      .map((x) => x.id);
    expect(offered).toEqual([back.lines[0]]);
    const ok = await confirm(a, g.c, { bankTransactionId: returned, candidateType: 'journal_line', candidateId: back.lines[0]! });
    expect(ok.state.statusCode, JSON.stringify(ok.state.body)).toBe(200);
    expect(await linkOf(pool, returned)).toMatchObject({ status: 'matched', line: back.lines[0] });
  });
});

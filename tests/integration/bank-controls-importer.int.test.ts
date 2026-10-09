/**
 * Bank controls step 2 (Hein, decision 2): importer ≠ allocator, through the
 * real bank-transactions-action route.
 *
 * Under enforcement of the arm's TYPE (no matching approval rule needed) the
 * person recorded as a statement batch's importer may not allocate its lines:
 * account, split and transfer under manual_journal; a supplier outflow under
 * supplier_payment. Refused 403 IMPORTER_MAY_NOT_ALLOCATE with nothing
 * written; another member allocates the same line. The sole approver on the
 * admin floor passes; feed lines, money in and enforcement off are untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantRule } from './r035-approval.helpers';
import { journalRule } from './r035-pr6.helpers';
import {
  actionRoute, bankCompany, cleanupBankControlsA, enforce, lineStatus, PAY_TYPES, plantBatch, plantLine, refusalOf,
  type BankCompany,
} from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let b = '';
let act: ReturnType<typeof actionRoute>;

beforeAll(async () => {
  a = await createUser(pool, tokens);
  b = await createUser(pool, tokens);
  act = actionRoute(tokens);
});
afterAll(() => cleanupBankControlsA(pool, companies, [a, b]));

/** a and b both admins (neither sole); a imported the batch. */
async function fixture(types: string[], members: [string, string][] = []): Promise<BankCompany & { batch: string }> {
  const f = await bankCompany(pool, members.length ? members : [[a, 'admin'], [b, 'admin']], companies);
  await journalRule(plantRule, pool, f.c); // an owner rule over R1 000 on manual journals
  await enforce(pool, f.c, a, types);
  return { ...f, batch: await plantBatch(pool, f, a) };
}
const journals = async (c: string) =>
  (await pool.query('SELECT count(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1', [c])).rows[0].n as number;
const allocate = (user: string, f: BankCompany, line: string, extra: Record<string, unknown> = { contraAccountId: f.expA }) =>
  act(user, f.c, { action: 'allocate', bankTransactionId: line, allocationType: 'account', ...extra });
const split = (user: string, f: BankCompany, line: string) => act(user, f.c, { action: 'split_allocate', bankTransactionId: line,
  lines: [{ contraAccountId: f.expA, amount: 750 }, { contraAccountId: f.expB, amount: 750 }] });
const transfer = (user: string, f: BankCompany, line: string) =>
  allocate(user, f, line, { allocationType: 'transfer', contraAccountId: f.bank2 });
const supplier = (user: string, f: BankCompany, line: string) =>
  allocate(user, f, line, { allocationType: 'supplier', entityId: f.supplier });
const expectImporterRefused = (res: Parameters<typeof refusalOf>[0], arm: string) => {
  const r = refusalOf(res);
  expect(r, JSON.stringify(res.state.body)).toMatchObject({ status: 403, reason: 'IMPORTER_MAY_NOT_ALLOCATE' });
  expect(r.message).toBe(`You imported this bank statement, so while ${arm} approval is on you cannot allocate its lines `
    + 'yourself. Ask another member to allocate this line.');
};

describe('manual_journal enforced: account, split and transfer', () => {
  it('the importer is refused 403 on every journal arm — with or without a matching rule — and nothing is written', async () => {
    const f = await fixture(['manual_journal']);
    const big = await plantLine(pool, f, f.batch, -1500); // the owner rule matches
    const small = await plantLine(pool, f, f.batch, -500); // no rule matches: the TYPE is enforced, that is enough
    for (const line of [big, small]) {
      expectImporterRefused(await allocate(a, f, line), 'manual-journal');
      expectImporterRefused(await transfer(a, f, line), 'manual-journal');
    }
    expectImporterRefused(await split(a, f, big), 'manual-journal');
    expect(await journals(f.c)).toBe(0);
    expect([await lineStatus(pool, big), await lineStatus(pool, small)]).toEqual(['imported', 'imported']);
  });

  it('another member allocates, splits and transfers the same lines', async () => {
    const f = await fixture(['manual_journal']);
    const [one, two, three] = [await plantLine(pool, f, f.batch), await plantLine(pool, f, f.batch), await plantLine(pool, f, f.batch)];
    expect((await allocate(b, f, one)).state.statusCode).toBe(200);
    expect((await split(b, f, two)).state.statusCode).toBe(200);
    expect((await transfer(b, f, three)).state.statusCode).toBe(200);
    expect(await journals(f.c)).toBe(3);
  });

  it('a supplier outflow is not a journal arm: the importer pays the supplier while only manual_journal is enforced', async () => {
    const f = await fixture(['manual_journal']);
    expect((await supplier(a, f, await plantLine(pool, f, f.batch))).state.statusCode).toBe(200);
  });
});

describe('supplier_payment enforced: a supplier outflow', () => {
  it('the importer is refused 403 and nothing is written; another member pays it', async () => {
    const f = await fixture(PAY_TYPES);
    const line = await plantLine(pool, f, f.batch);
    expectImporterRefused(await supplier(a, f, line), 'supplier-payment');
    expect(await journals(f.c)).toBe(0);
    expect((await pool.query('SELECT count(*)::INT AS n FROM supplier_payments WHERE company_id = $1', [f.c])).rows[0].n).toBe(0);
    expect((await supplier(b, f, line)).state.statusCode).toBe(200);
  });

  it('the account arm is not a payment: the importer allocates to an account while only supplier_payment is enforced', async () => {
    const f = await fixture(PAY_TYPES);
    expect((await allocate(a, f, await plantLine(pool, f, f.batch))).state.statusCode).toBe(200);
  });

  it('money in is ungated: the importer records a customer receipt from their own statement', async () => {
    const f = await fixture([...PAY_TYPES, 'manual_journal']);
    expect((await allocate(a, f, await plantLine(pool, f, f.batch, 900), { allocationType: 'customer', entityId: f.customer }))
      .state.statusCode).toBe(200);
  });
});

describe('what the importer check leaves alone', () => {
  it('the sole approver on the admin floor allocates their own import (no other member reaches admin)', async () => {
    const f = await fixture(['manual_journal', ...PAY_TYPES], [[a, 'admin'], [b, 'viewer']]);
    expect((await allocate(a, f, await plantLine(pool, f, f.batch))).state.statusCode).toBe(200);
    expect((await supplier(a, f, await plantLine(pool, f, f.batch))).state.statusCode).toBe(200);
  });

  it('a feed line, another person\'s batch, a legacy mcp:* importer and enforcement off all allocate', async () => {
    const f = await fixture(['manual_journal']);
    expect((await allocate(a, f, await plantLine(pool, f, 'feed'))).state.statusCode).toBe(200);
    expect((await allocate(a, f, await plantLine(pool, f, await plantBatch(pool, f, b)))).state.statusCode).toBe(200);
    expect((await allocate(a, f, await plantLine(pool, f, await plantBatch(pool, f, 'mcp:import_bank_statement:v1', 'mcp'))))
      .state.statusCode).toBe(200);
    const off = await fixture([]);
    expect((await allocate(a, off, await plantLine(pool, off, off.batch))).state.statusCode).toBe(200);
    expect((await split(a, off, await plantLine(pool, off, off.batch))).state.statusCode).toBe(200);
  });

  it('a hand-keyed line below the rule is no import: its keyer allocates it as before', async () => {
    const f = await fixture(['manual_journal']);
    expect((await allocate(a, f, await plantLine(pool, f, null, -500))).state.statusCode).toBe(200);
  });
});

/**
 * Audit WP2 row 9 — bank-transactions-action and bank-transactions-import-classified answered every unrecognised
 * throw 400 with its raw message. A 4xx COMMITs the request (withAuth), so a crash after the first write committed
 * the half-done request. Now only the typed refusals keep their 4xx; anything else is a 500 and rolls back.
 *
 * Each crash is injected AFTER the write (bank-catchall.helpers), through the real route and the real withAuth.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

vi.mock('@/lib/logger', async (orig) => (await import('./bank-catchall.helpers')).loggerWithFault(await orig()));
vi.mock('@/lib/neon', async (orig) => (await import('./bank-catchall.helpers')).neonWithFault(await orig()));

import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { actionRoute, bankCompany, cleanupBankControlsA, plantLine, refusalOf, type BankCompany } from './bank-controls-a.helpers';
import { faults, resetFaults } from './bank-catchall.helpers';
import importClassified from '../../pages/api/accounting/bank-transactions-import-classified';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let f: BankCompany;
let other: BankCompany;
let act: ReturnType<typeof actionRoute>;

beforeAll(async () => {
  a = await createUser(pool, tokens);
  f = await bankCompany(pool, [[a, 'admin']], companies);
  other = await bankCompany(pool, [[a, 'admin']], companies);
  act = actionRoute(tokens);
});
beforeEach(() => resetFaults());
afterAll(async () => {
  await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM cost_centres WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM business_units WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a]); // ends the pool
});

const exists = async (id: string) => (await pool.query('SELECT 1 FROM bank_transactions WHERE id = $1', [id])).rowCount === 1;

describe('bank-transactions-action: a crash after the write is a 500 and rolls back', () => {
  it('delete: the DELETE ran, then a TypeError — 500, and the line is still there', async () => {
    const line = await plantLine(pool, f, null, -120);
    faults.afterSql = /DELETE FROM bank_transactions/;
    const res = await act(a, f.c, { action: 'delete', bankTransactionId: line });
    expect(faults.fired).toHaveLength(1);
    expect({ status: res.state.statusCode, kept: await exists(line) }).toEqual({ status: 500, kept: true });
  });

  it('the typed refusals keep their 4xx: a missing line is 404, reversing a line with nothing to reverse is 400', async () => {
    const missing = crypto.randomUUID();
    expect(refusalOf(await act(a, f.c, { action: 'exclude', bankTransactionId: missing })).status).toBe(404);
    const line = await plantLine(pool, f, null, -100);
    const reverse = refusalOf(await act(a, f.c, { action: 'reverse', bankTransactionId: line }));
    expect(reverse).toMatchObject({ status: 400, message: expect.stringMatching(/Can only reverse allocated, matched, or reconciled/) });
    expect((await pool.query('SELECT status FROM bank_transactions WHERE id = $1', [line])).rows[0].status).toBe('imported');
  });
});

describe('bank-transactions-import-classified: it imports, and a crash after the insert is a 500 that rolls back', () => {
  const importAs = (company: string, bankAccountId: string, transactions: Record<string, unknown>[]) => callRoute(
    importClassified as never, tokens[a]!, company, 'POST', { bankAccountId, transactions },
    '/api/accounting/bank-transactions-import-classified');
  const linesNamed = async (prefix: string) => (await pool.query(
    `SELECT description, amount::FLOAT8 AS amount, cc1_id::TEXT AS cc1, cc2_id::TEXT AS cc2, bu_id::TEXT AS bu
     FROM bank_transactions WHERE company_id = $1 AND description LIKE $2 ORDER BY description`, [f.c, `${prefix}%`])).rows;
  const batches = async () => (await pool.query(
    "SELECT COUNT(*)::INT AS n FROM bank_import_batches WHERE company_id = $1 AND import_channel = 'classified'", [f.c])).rows[0].n as number;

  // It inserted nothing on any schema: it named bank_transactions.suggested_cost_centre, which no migration creates.
  // The worksheet's cost centres now land in the line's own dimension columns, resolved by code or name.
  it('a worksheet of two lines inserts two lines, their cost centres resolved to the line\'s dimensions', async () => {
    const cc1 = (await pool.query(
      "INSERT INTO cost_centres(company_id, code, name, cc_type) VALUES($1,'FNO-CA','Fibre Cape','cc1') RETURNING id", [f.c])).rows[0].id;
    const bu = (await pool.query(
      "INSERT INTO business_units(company_id, code, name) VALUES($1,'BU-CA','Cape Ops') RETURNING id", [f.c])).rows[0].id;
    const before = await batches();
    const res = await importAs(f.c, f.bank, [
      { transactionDate: '2026-09-04', description: 'WS LINE A', debit: 40, costCentreT1: 'fno-ca', businessUnit: 'Cape Ops' },
      { transactionDate: '2026-09-05', description: 'WS LINE B', credit: 15, costCentreT2: 'Nowhere' },
    ]);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(201);
    expect((res.state.body as { data: Record<string, unknown> }).data)
      .toMatchObject({ inserted: 2, skippedDuplicates: 0, unresolvedDimensions: ['T2: Nowhere'] });
    expect(await linesNamed('WS LINE')).toEqual([
      { description: 'WS LINE A', amount: -40, cc1, cc2: null, bu },
      { description: 'WS LINE B', amount: 15, cc1: null, cc2: null, bu: null },
    ]);
    expect(await batches()).toBe(before + 1);
  });

  // The system validator (journalCostCentreValidation) assigns only cc_type exactly 'cc1'/'cc2' and is_active exactly true.
  it('a NULL-type centre, an inactive centre, a NULL-active unit: unresolved and not stored', async () => {
    await pool.query("INSERT INTO cost_centres(company_id, code, name, cc_type) VALUES($1,'NULLTYPE','Null Type',NULL)", [f.c]);
    await pool.query("INSERT INTO cost_centres(company_id, code, name, cc_type, is_active) VALUES($1,'GONE','Gone','cc1',false)", [f.c]);
    await pool.query("INSERT INTO business_units(company_id, code, name, is_active) VALUES($1,'BU-NULL','Null Unit',NULL)", [f.c]);
    const res = await importAs(f.c, f.bank, [
      { transactionDate: '2026-09-07', description: 'STRICT A', debit: 5, costCentreT1: 'NULLTYPE', businessUnit: 'BU-NULL' },
      { transactionDate: '2026-09-08', description: 'STRICT B', debit: 6, costCentreT1: 'GONE' },
    ]);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(201);
    const data = (res.state.body as { data: { unresolvedDimensions: string[] } }).data;
    expect([...data.unresolvedDimensions].sort()).toEqual(['BU: BU-NULL', 'T1: GONE', 'T1: NULLTYPE']);
    expect(await linesNamed('STRICT')).toEqual([
      { description: 'STRICT A', amount: -5, cc1: null, cc2: null, bu: null },
      { description: 'STRICT B', amount: -6, cc1: null, cc2: null, bu: null },
    ]);
  });

  it('a label two masters answer to is ambiguous: stored NULL and listed, never guessed', async () => {
    await pool.query("INSERT INTO cost_centres(company_id, code, name, cc_type) VALUES($1,'TW-1','Twin','cc1'),($1,'TW-2','Twin','cc1')", [f.c]);
    const res = await importAs(f.c, f.bank, [{ transactionDate: '2026-09-09', description: 'TWIN A', debit: 7, costCentreT1: 'twin' }]);
    expect((res.state.body as { data: { unresolvedDimensions: string[] } }).data.unresolvedDimensions).toEqual(['T1: twin']);
    expect(await linesNamed('TWIN')).toEqual([{ description: 'TWIN A', amount: -7, cc1: null, cc2: null, bu: null }]);
  });

  // pg read '31/12/2026' as an error (500) and '01/02/2026' as 2 January: the worksheet takes ISO days only.
  it('a date that is not an ISO day (or not a real day) is a 400 naming the row; nothing is written', async () => {
    const before = await batches();
    for (const bad of ['31/12/2026', '01/02/2026', '2026-02-30', '2026-13-01', 'September 4', '2026-09-04Tgarbage']) {
      const res = refusalOf(await importAs(f.c, f.bank, [
        { transactionDate: '2026-09-10', description: 'DATE OK', debit: 1 },
        { transactionDate: bad, description: 'DATE BAD', debit: 2 }]));
      expect(res, bad).toMatchObject({ status: 400, message: expect.stringContaining('Row 2') });
    }
    expect({ lines: await linesNamed('DATE '), batches: await batches() }).toEqual({ lines: [], batches: before });
  });

  // The import locks only the masters its file names (FOR SHARE): an UNRELATED cost centre stays editable while it runs.
  it('an import holding its transaction does not block an UPDATE of an unrelated cost centre, but does block a named one', async () => {
    const named = (await pool.query(
      "INSERT INTO cost_centres(company_id, code, name, cc_type) VALUES($1,'LK-NAMED','Lock Named','cc1') RETURNING id", [f.c])).rows[0].id;
    const other = (await pool.query(
      "INSERT INTO cost_centres(company_id, code, name, cc_type) VALUES($1,'LK-OTHER','Lock Other','cc1') RETURNING id", [f.c])).rows[0].id;
    let release: () => void = () => {};
    faults.gate = new Promise<void>((resolve) => { release = resolve; });
    faults.holdAfterSql = /cost_centres[\s\S]*FOR SHARE/;
    const running = importAs(f.c, f.bank, [{ transactionDate: '2026-09-11', description: 'LOCK A', debit: 2, costCentreT1: 'LK-NAMED' }]);
    const until = Date.now() + 15_000;
    while (!faults.held && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    expect(faults.held, 'the import reached its lock').toBe(true);
    const update = async (id: string) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query("SET LOCAL lock_timeout = '1200ms'");
        await c.query("UPDATE cost_centres SET description = 'edited' WHERE id = $1", [id]);
        await c.query('COMMIT');
        return 'updated';
      } catch (err) {
        await c.query('ROLLBACK');
        return (err as { code?: string }).code === '55P03' ? 'blocked' : `error ${String(err)}`;
      } finally { c.release(); }
    };
    const outcome = { unrelated: await update(other), named: await update(named) };
    release();
    const res = await running;
    expect({ ...outcome, import: res.state.statusCode }).toEqual({ unrelated: 'updated', named: 'blocked', import: 201 });
  });

  // A twin activated between the unlocked read and the lock makes the label ambiguous: decided again under the lock.
  it('a twin activated while the import holds its lock makes the label ambiguous: unresolved and listed, not stored', async () => {
    await pool.query("INSERT INTO cost_centres(company_id, code, name, cc_type) VALUES($1,'TL-LIVE','Twin Lock','cc1')", [f.c]);
    const sleeper = (await pool.query(
      "INSERT INTO cost_centres(company_id, code, name, cc_type, is_active) VALUES($1,'TL-SLEEP','Twin Lock','cc1',false) RETURNING id", [f.c])).rows[0].id;
    let release: () => void = () => {};
    faults.gate = new Promise<void>((resolve) => { release = resolve; });
    faults.holdAfterSql = /cost_centres[\s\S]*FOR SHARE/;
    const running = importAs(f.c, f.bank, [{ transactionDate: '2026-09-14', description: 'TWINLOCK A', debit: 4, costCentreT1: 'twin lock' }]);
    const until = Date.now() + 15_000;
    while (!faults.held && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    expect(faults.held, 'the import reached its lock').toBe(true);
    await pool.query('UPDATE cost_centres SET is_active = true WHERE id = $1', [sleeper]); // the unlocked twin: not blocked
    release();
    const res = await running;
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(201);
    expect((res.state.body as { data: { unresolvedDimensions: string[] } }).data.unresolvedDimensions).toEqual(['T1: twin lock']);
    expect(await linesNamed('TWINLOCK')).toEqual([{ description: 'TWINLOCK A', amount: -4, cc1: null, cc2: null, bu: null }]);
  });

  // An unmatched master renamed to the matched label while the import waits: two active masters now share it.
  it('an unmatched master renamed to a matched label while the import holds its lock: ambiguous, unresolved, not stored', async () => {
    await pool.query("INSERT INTO cost_centres(company_id, code, name, cc_type) VALUES($1,'RN-LIVE','Rename Lock','cc1')", [f.c]);
    const other = (await pool.query(
      "INSERT INTO cost_centres(company_id, code, name, cc_type) VALUES($1,'RN-OTHER','Something Else','cc1') RETURNING id", [f.c])).rows[0].id;
    let release: () => void = () => {};
    faults.gate = new Promise<void>((resolve) => { release = resolve; });
    faults.holdAfterSql = /cost_centres[\s\S]*FOR SHARE/;
    const running = importAs(f.c, f.bank, [{ transactionDate: '2026-09-15', description: 'RENAME A', debit: 6, costCentreT1: 'rename lock' }]);
    const until = Date.now() + 15_000;
    while (!faults.held && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    expect(faults.held, 'the import reached its lock').toBe(true);
    await pool.query("UPDATE cost_centres SET name = 'Rename Lock' WHERE id = $1", [other]); // unmatched, so not locked
    release();
    const res = await running;
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(201);
    expect((res.state.body as { data: { unresolvedDimensions: string[] } }).data.unresolvedDimensions).toEqual(['T1: rename lock']);
    expect(await linesNamed('RENAME')).toEqual([{ description: 'RENAME A', amount: -6, cc1: null, cc2: null, bu: null }]);
  });

  it('an inactive master sharing a label is not a candidate: the active one resolves (W3)', async () => {
    const live = (await pool.query(
      "INSERT INTO cost_centres(company_id, code, name, cc_type) VALUES($1,'SH-LIVE','Shared','cc1') RETURNING id", [f.c])).rows[0].id;
    await pool.query("INSERT INTO cost_centres(company_id, code, name, cc_type, is_active) VALUES($1,'SH-OLD','Shared','cc1',false)", [f.c]);
    const res = await importAs(f.c, f.bank, [{ transactionDate: '2026-09-12', description: 'SHARED A', debit: 3, costCentreT1: 'shared' }]);
    expect(res.state.statusCode).toBe(201);
    expect(await linesNamed('SHARED')).toEqual([{ description: 'SHARED A', amount: -3, cc1: live, cc2: null, bu: null }]);
  });

  // A NUL byte in a text column (22021) and an amount past numeric(15,2) (22003) were 500s mid-INSERT.
  it('a NUL byte or an amount past the column is a 400 naming the row; nothing is written', async () => {
    const before = await batches();
    const cases: Record<string, unknown>[] = [
      { description: 'NUL\u0000BYTE', debit: 1 }, { description: 'NULCAT', debit: 1, category: 'a\u0000b' },
      { description: 'NULREF', debit: 1, statementRef: 'r\u0000' }, { description: 'HUGE DEBIT', debit: 1e20 },
      { description: 'HUGE CREDIT', credit: 10_000_000_000_000 },
    ];
    for (const c of cases) {
      const res = refusalOf(await importAs(f.c, f.bank, [
        { transactionDate: '2026-09-13', description: 'RANGE OK', debit: 1 }, { transactionDate: '2026-09-13', ...c }]));
      expect(res, JSON.stringify(c)).toMatchObject({ status: 400, message: expect.stringContaining('Row 2') });
    }
    expect({ lines: await linesNamed('RANGE OK'), batches: await batches() }).toEqual({ lines: [], batches: before });
  });

  it('the lines were inserted, then a TypeError — 500, and no line or batch is left', async () => {
    const before = await batches();
    faults.afterLog = 'Imported classified bank transactions';
    const res = await importAs(f.c, f.bank, [{ transactionDate: '2026-09-06', description: 'WS CRASH', debit: 77 }]);
    expect(faults.fired).toHaveLength(1);
    expect({ status: res.state.statusCode, lines: await linesNamed('WS CRASH'), batches: await batches() })
      .toEqual({ status: 500, lines: [], batches: before });
  });

  it('another company\'s bank account is still refused 400', async () => {
    expect(refusalOf(await importAs(f.c, other.bank,
      [{ transactionDate: '2026-09-03', description: 'WS FOREIGN', debit: 1 }])).status).toBe(400);
  });
});

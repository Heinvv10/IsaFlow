/**
 * A posted level 1-2 parent that ALREADY has a child is already a header: the balance sheet dropped its own
 * balance the day it got its first child, so giving it another hides nothing new (2026-10-26, VF's paycard
 * umbrella 1544420: 40 children, posted lines netting to zero, and every further paycard was refused).
 *  (a) a posted parent with NO child is still refused, on both the chart path and the bank grouping PUT;
 *  (b) a posted parent with one child takes a second, on both paths, and through createAccount;
 *  (c) the exemption is read under the role-write lock, which every writer that can take a child away from a
 *      parent (reclassifyAccount, the bank PUT) takes first. So "the last child moves away" and "a new child
 *      arrives" serialise: the add waits, re-reads, and is refused when the move left the parent childless.
 * Disposable databases only — the suite skips elsewhere.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { reclassifyAccount } from '@/modules/accounting/services/gl/accountReclassifyService';
import { createAccount } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx, runOn } from './helpers/l1FifoFixture';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { addAccount, dropHeaderFixture, seedHeaderFixture, type HeaderFixture } from './helpers/headerGuardFixture';
import bankAccounts from '../../pages/api/accounting/bank-accounts';

const describeIfDb = isDisposableDb() && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
const DATE = '2026-07-10';
const WAIT_MS = 1500;
let h: HeaderFixture;

const post = (account: string, amount = 100) => async () => {
  const [dr, cr] = amount >= 0 ? [account, h.fx.bankAccountId] : [h.fx.bankAccountId, account];
  const e = await createJournalEntry(h.fx.companyId, {
    entryDate: DATE, description: 'HAH', source: 'manual',
    lines: [{ glAccountId: dr, debit: Math.abs(amount), credit: 0 }, { glAccountId: cr, debit: 0, credit: Math.abs(amount) }],
  }, h.fx.userId);
  await postJournalEntry(h.fx.companyId, e.id, h.fx.userId);
};

/**
 * A level-1 parent posted while it was a leaf. `children` > 0 then gives it children by direct insert — the
 * state VF's chart is in, and one no guarded path can produce, since a post to a header is refused.
 */
async function postedParent(tag: string, children: number, subtype: string | null = null, netZero = false) {
  const parent = await addAccount(h.fx, { code: `HAH-${tag}`, type: 'asset', level: 1, subtype });
  await inTx(h.fx, post(parent));
  if (netZero) await inTx(h.fx, post(parent, -100));
  const kids: string[] = [];
  for (let i = 1; i <= children; i += 1) {
    kids.push(await addAccount(h.fx, { code: `HAH-${tag}.${i}`, type: 'asset', level: 2, parentId: parent, subtype }));
  }
  return { parent, kids };
}

const parentOf = async (id: string) => String(((await sql`
  SELECT COALESCE(parent_account_id::TEXT, '') AS p FROM gl_accounts WHERE id = ${id}::UUID`) as Row[])[0]!.p);
const childCount = async (id: string) => Number(((await sql`
  SELECT COUNT(*)::INT AS n FROM gl_accounts WHERE parent_account_id = ${id}::UUID`) as Row[])[0]!.n);
const move = (id: string, parentAccountId: string | null) => () =>
  reclassifyAccount(h.fx.companyId, id, { parentAccountId });
const settle = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as Error);

async function putBankAccount(body: Record<string, unknown>) {
  const token = await new SignJWT({ sub: h.fx.userId, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const req = request({ 'sb-access-token': token, active_company_id: h.fx.companyId }, 'PUT') as never as
    { body: unknown; query: unknown; url: string };
  req.body = body;
  req.query = {};
  req.url = '/api/accounting/bank-accounts';
  const out = response();
  await (bankAccounts as never as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
  return out.state;
}

/** Starts `fn` on `client` without awaiting it, and reports whether it has settled. */
function start<T>(client: PoolClient, fn: () => Promise<T>) {
  const state = { settled: false };
  const outcome = settle(runOn(h.fx, client, fn)).finally(() => { state.settled = true; });
  return { state, outcome };
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function twoClients(run: (a: PoolClient, b: PoolClient) => Promise<void>): Promise<void> {
  const a = await h.fx.pool.connect();
  const b = await h.fx.pool.connect();
  try {
    await a.query('BEGIN');
    await b.query('BEGIN');
    await run(a, b);
  } finally {
    await a.query('ROLLBACK').catch(() => undefined);
    await b.query('ROLLBACK').catch(() => undefined);
    a.release();
    b.release();
  }
}

describeIfDb('a posted parent that is already a header may take another child', () => {
  beforeAll(async () => { h = await seedHeaderFixture('HAH', process.env.DATABASE_URL!); }, 120000);
  afterAll(async () => { await dropHeaderFixture(h); }, 120000);
  afterEach(() => { vi.restoreAllMocks(); });
  const headerWarnings = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter((c) => String(c[0]).startsWith('Child added to a header'));

  describe('chart path (reclassifyAccount / createAccount, the update_gl_account MCP tool)', () => {
    it('(a) a posted level-1 parent with NO child is still refused; nothing changes', async () => {
      const { parent } = await postedParent('A0', 0);
      const loose = await addAccount(h.fx, { code: 'HAH-A0X', type: 'asset', level: 1 });
      const err = await settle(inTx(h.fx, move(loose, parent)));
      expect(err?.message, 'the move was not refused').toContain('HAH-A0 is a level-1 asset account with journal lines');
      expect(await parentOf(loose)).toBe('');
    });

    it('(b) a posted level-1 parent with one child takes a second, at level 2', async () => {
      const { parent } = await postedParent('B1', 1);
      const loose = await addAccount(h.fx, { code: 'HAH-B1X', type: 'asset', level: 1 });
      expect(await settle(inTx(h.fx, move(loose, parent)))).toBeNull();
      expect(await parentOf(loose)).toBe(parent);
      expect(await childCount(parent)).toBe(2);
      const level = ((await sql`SELECT level FROM gl_accounts WHERE id = ${loose}::UUID`) as Row[])[0]!.level;
      expect(Number(level)).toBe(2);
    });

    it('(b) a header whose own lines do not net to zero is admitted, with a warning naming it', async () => {
      const warn = vi.spyOn(log, 'warn');
      const { parent } = await postedParent('W1', 1);
      const loose = await addAccount(h.fx, { code: 'HAH-W1X', type: 'asset', level: 1 });
      expect(await settle(inTx(h.fx, move(loose, parent)))).toBeNull();
      const hits = headerWarnings(warn);
      expect(hits).toHaveLength(1);
      expect(hits[0]![1]).toMatchObject({ parentId: parent, accountCode: 'HAH-W1', net: '100.00' });
    });

    it('(b) control: lines netting to zero (VF 1544420) raise no warning', async () => {
      const warn = vi.spyOn(log, 'warn');
      const { parent } = await postedParent('W0', 1, null, true);
      const net = ((await sql`SELECT SUM(debit - credit)::TEXT AS n, COUNT(*)::INT AS c FROM gl_journal_lines
        WHERE gl_account_id = ${parent}::UUID`) as Row[])[0]!;
      expect([Number(net.n), Number(net.c)]).toEqual([0, 2]);
      const loose = await addAccount(h.fx, { code: 'HAH-W0X', type: 'asset', level: 1 });
      expect(await settle(inTx(h.fx, move(loose, parent)))).toBeNull();
      expect(headerWarnings(warn)).toHaveLength(0);
    });

    it('(b) a DRAFT line on the header is not money the balance sheet misses: no warning', async () => {
      const warn = vi.spyOn(log, 'warn');
      const { parent } = await postedParent('W2', 1, null, true);
      const je = String(((await sql`INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, source, status, created_by)
        VALUES (${h.fx.companyId}::UUID, ${`HAH-W2-${h.fx.tag}`.slice(0, 40)}, ${DATE}::DATE, 'draft on header', 'manual', 'draft', ${h.fx.userId})
        RETURNING id`) as Row[])[0]!.id);
      await sql`INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id) VALUES
        (${je}::UUID, ${parent}::UUID, 75, 0, ${h.fx.companyId}::UUID), (${je}::UUID, ${h.fx.bankAccountId}::UUID, 0, 75, ${h.fx.companyId}::UUID)`;
      const loose = await addAccount(h.fx, { code: 'HAH-W2X', type: 'asset', level: 1 });
      expect(await settle(inTx(h.fx, move(loose, parent)))).toBeNull();
      expect(headerWarnings(warn)).toHaveLength(0);
    });

    it('(b) createAccount under the same kind of header is accepted', async () => {
      const { parent } = await postedParent('B2', 1);
      const made = await inTx(h.fx, () => createAccount(h.fx.companyId, {
        accountCode: 'HAH-B2N', accountName: 'HAH new child', accountType: 'asset', accountSubtype: 'other_current_asset',
        normalBalance: 'debit', parentAccountId: parent,
      }));
      expect(await parentOf(String(made.id))).toBe(parent);
    });
  });

  describe('bank grouping PUT /api/accounting/bank-accounts', () => {
    const bank = (code: string) => addAccount(h.fx, { code, type: 'asset', level: 1, subtype: 'bank' });

    it('(a) a posted bank group with NO member is still a 400', async () => {
      const { parent } = await postedParent('G0', 0, 'bank');
      const member = await bank('HAH-G0M');
      const out = await putBankAccount({ id: member, parentAccountId: parent });
      expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
      expect(JSON.stringify(out.body)).toContain('HAH-G0 has journal lines posted to it');
      expect(await parentOf(member)).toBe('');
    });

    it('(b) a posted bank group that already has a member takes another', async () => {
      const { parent } = await postedParent('G1', 1, 'bank');
      const member = await bank('HAH-G1M');
      const out = await putBankAccount({ id: member, parentAccountId: parent });
      expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
      expect(await parentOf(member)).toBe(parent);
    });
  });

  describe('(c) the last child leaving and a new one arriving serialise', () => {
    it('MOVE AWAY first (uncommitted): the add waits, then is refused — the parent is a leaf again', async () => {
      const { parent, kids } = await postedParent('C1', 1);
      const loose = await addAccount(h.fx, { code: 'HAH-C1X', type: 'asset', level: 1 });
      await twoClients(async (a, b) => {
        expect(await settle(runOn(h.fx, a, move(kids[0]!, null)))).toBeNull();
        const add = start(b, move(loose, parent));
        await pause(WAIT_MS);
        expect(add.state.settled, 'the add did not wait for the move').toBe(false);
        await a.query('COMMIT');
        const err = await add.outcome;
        expect(err?.message, 'the add was not refused').toContain('HAH-C1 is a level-1 asset account with journal lines');
        await b.query('ROLLBACK');
      });
      expect(await childCount(parent)).toBe(0);
      expect(await parentOf(loose)).toBe('');
    }, 120000);

    it('bank PUT: MOVE AWAY first (uncommitted): the grouping PUT waits, then is a 400', async () => {
      const { parent, kids } = await postedParent('C3', 1, 'bank');
      const member = await addAccount(h.fx, { code: 'HAH-C3M', type: 'asset', level: 1, subtype: 'bank' });
      await twoClients(async (a) => {
        expect(await settle(runOn(h.fx, a, move(kids[0]!, null)))).toBeNull();
        const state = { settled: false };
        const put = putBankAccount({ id: member, parentAccountId: parent }).finally(() => { state.settled = true; });
        await pause(WAIT_MS);
        expect(state.settled, 'the PUT did not wait for the move').toBe(false);
        await a.query('COMMIT');
        const out = await put;
        expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
        expect(JSON.stringify(out.body)).toContain('HAH-C3 has journal lines posted to it');
      });
      expect(await parentOf(member)).toBe('');
    }, 120000);

    it('ADD first (uncommitted): the move away waits; both commit and the parent never stopped being a header', async () => {
      const { parent, kids } = await postedParent('C2', 1);
      const loose = await addAccount(h.fx, { code: 'HAH-C2X', type: 'asset', level: 1 });
      await twoClients(async (a, b) => {
        expect(await settle(runOn(h.fx, a, move(loose, parent)))).toBeNull();
        const away = start(b, move(kids[0]!, null));
        await pause(WAIT_MS);
        expect(away.state.settled, 'the move did not wait for the add').toBe(false);
        await a.query('COMMIT');
        expect(await away.outcome).toBeNull();
        await b.query('COMMIT');
      });
      expect(await parentOf(loose)).toBe(parent);
      expect(await parentOf(kids[0]!)).toBe('');
      expect(await childCount(parent)).toBe(1);
    }, 120000);
  });
});

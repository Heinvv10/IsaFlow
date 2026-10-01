// W2-28 round 9: residual lock cycles in one transaction, bounded waits, the
// seed's parent tree, and input checked before any lock. Disposable fixture only.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { drainAfterCommit } from '@/lib/afterCommit';
import { brkFixture, sleep, within } from './w2-28-brk593.helpers';
import { McpRegistry } from '../../src/lib/mcp/registry';
import { updateGlAccountTool } from '../../src/lib/mcp/tools/writeGlAccounts';
import coa from '../../pages/api/accounting/chart-of-accounts';
import defaultAccounts from '../../pages/api/accounting/default-accounts';
import coaSeed from '../../pages/api/accounting/coa-seed';
import coaImport from '../../pages/api/accounting/migration/chart-of-accounts';
import migrationExecute from '../../pages/api/accounting/migration-execute';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { renameAccountCode, updateAccount } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { setBankOpeningBalanceMeta } from '@/modules/accounting/services/bank/bankOpeningBalanceService';
import { lockSystemRoleWrites, withBoundedLockWait } from '@/modules/accounting/services/gl/systemRoleWriteLock';
import { takeVatLockExclusive } from '@/modules/accounting/services/gl/journalVatLockGuard';
import { getTemplateLines, type CoaTemplate } from '@/modules/accounting/services/gl/chartOfAccountsImportService';
import { createSession } from '@/modules/accounting/services/core/migrationService';
import { MAX_MIGRATION_ACCOUNTS, MAX_MIGRATION_CONTACTS } from '@/modules/accounting/services/core/migrationRowCaps';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET
  && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

const fx = brkFixture('W228R9');
const { CO, USER, ins, holders } = fx;
const BANK = '11111111-1111-4111-8111-' + randomUUID().slice(-12);
const X = 'ffffffff-ffff-4fff-bfff-' + randomUUID().slice(-12);
const ctx = () => ({ userId: USER, companyId: CO, scopes: ['write:accounts', 'read:accounts'], tokenJti: 'w228r9', oauthAppId: null }) as never;
const registry = new McpRegistry();
registry.register(updateGlAccountTool);
const save = () => fx.call(defaultAccounts, 'POST', '/api/accounting/default-accounts', { mappings: { primary_bank: X }, loaded: { primary_bank: BANK } });
const untilWaiting = async (like: string) => {
  for (let i = 0; i < 100; i++) {
    if ((await fx.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE $1", [like])).rows[0].n > 0) return true;
    await sleep(50);
  }
  return false;
};
const tree = async () => Object.fromEntries((await fx.query(
  `SELECT a.account_code AS code, p.account_code AS parent FROM gl_accounts a
     LEFT JOIN gl_accounts p ON p.id = a.parent_account_id WHERE a.company_id = $1`, [CO])).rows.map((r) => [r.code, r.parent ?? null]));

describeIfDb('W2-28 round 9', () => {
  beforeAll(fx.setup);
  beforeEach(async () => {
    await fx.wipe(); clearSystemAccountCache(CO);
    await ins(BANK, '1110', 'asset', 'bank', true);
    await ins(X, '1115', 'asset', null, false);
  });
  afterAll(fx.teardown);

  it('an MCP batch that row-locked the bank holder WITHOUT the role lock (a FOR SHARE guard) and then writes an account: no 40P01 reaches anyone', async () => {
    const tx = await fx.openTx(drainAfterCommit);
    try {
      await tx.run(async () => { await sql`SELECT 1 FROM gl_accounts WHERE id = ${BANK}::UUID FOR SHARE`; });   // e.g. a bill line's account guard
      const saving = save();
      const waiting = await untilWaiting('%FOR NO KEY UPDATE%');
      if (!waiting) process.stdout.write(`\nW228R9 activity: ${JSON.stringify((await fx.query("SELECT state, wait_event_type, wait_event, left(query, 120) AS q FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()")).rows)}\n`);
      expect(waiting).toBe(true);                                                               // the save holds the role lock
      const second = await tx.run(() => registry.call('update_gl_account',
        { account_id: X, is_active: false, idempotency_key: randomUUID() }, ctx()).then((r) => JSON.stringify(r), (e: Error) => `thrown: ${e.message}`));
      await tx.commit().catch(() => undefined);
      const s = await saving;
      // The cycle cannot be avoided by order here (the FOR SHARE came first); its victim is told to retry.
      expect(second + JSON.stringify(s.body)).not.toMatch(/deadlock|GENERIC_FAILURE|operation failed/i);
      expect([200, 400, 409, 503]).toContain(s.statusCode);
    } finally { await tx.rollback().catch(() => undefined); }
  }, 30_000);

  it.each([
    ['a name edit', () => updateAccount(CO, BANK, { accountName: 'Main bank' })],
    ['a code change', () => renameAccountCode(CO, BANK, '1109')],
    ['a bank opening balance', () => setBankOpeningBalanceMeta.write(CO, BANK, 100, '2026-01-01')],
  ])('%s of the bank holder takes the role lock first: a save started after it waits for the ROLE lock, not for the row', async (_what, write) => {
    const tx = await fx.openTx(drainAfterCommit);
    try {
      await tx.run(write);
      const saving = save();
      let waitingOn = '';
      for (let i = 0; i < 60 && !waitingOn; i++) {
        waitingOn = (await fx.query(`SELECT wait_event FROM pg_stat_activity WHERE wait_event_type = 'Lock'
          AND (query ILIKE '%pg_advisory_xact_lock%' OR query ILIKE '%FOR NO KEY UPDATE%')`)).rows[0]?.wait_event ?? '';
        if (!waitingOn) await sleep(50);
      }
      await tx.commit();
      await saving;
      expect(waitingOn).toBe('advisory');
    } finally { await tx.rollback(); }
  }, 20_000);

  it('a save waiting on the shared VAT key (a VAT lock/unlock in flight) answers 503 within 5s, not after it', async () => {
    const c = await fx.connect();
    try {
      await c.query('BEGIN');
      await takeVatLockExclusive(CO, ((s: TemplateStringsArray, ...v: unknown[]) =>
        c.query(s.reduce((a, p, i) => a + p + (i < v.length ? `$${i + 1}` : ''), ''), v).then((r) => r.rows)) as never);
      const answered = await within(9000, save().then((s) => s.statusCode));
      expect({ answered, bank: await holders('bank') }).toEqual({ answered: 503, bank: ['1110'] });
    } finally { await c.query('ROLLBACK'); c.release(); }
  }, 30_000);

  it('the bounded wait restores the caller\'s lock_timeout even when what it ran threw a non-database error', async () => {
    const tx = await fx.openTx(drainAfterCommit);
    try {
      const after = await tx.run(async () => {
        await withBoundedLockWait(sql, async () => { throw new Error('not a lock error'); }).catch(() => undefined);
        return ((await sql`SELECT current_setting('lock_timeout') AS v`) as { v: string }[])[0]!.v;
      });
      expect(after).toBe('0');
    } finally { await tx.rollback(); }
  });

  it('a malformed id is refused 400 before the role lock is waited for (POST parent, PUT id)', async () => {
    const tx = await fx.openTx(drainAfterCommit);
    try {
      await tx.run(() => lockSystemRoleWrites(CO));
      const answers = await within(2000, Promise.all([
        fx.call(coa, 'POST', '/api/accounting/chart-of-accounts', { accountCode: '1190', accountName: 'x', accountType: 'asset', normalBalance: 'debit', parentAccountId: 'not-a-uuid' }),
        fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: 'not-a-uuid', parentAccountId: BANK }),
      ]).then((a) => a.map((s) => s.statusCode)));
      expect(answers).toEqual([400, 400]);
    } finally { await tx.rollback(); }
  }, 20_000);

  it('a migration request larger than the caps is refused 400 before any write', async () => {
    const session = await createSession(CO, 'sage', USER);
    const accounts = Array.from({ length: MAX_MIGRATION_ACCOUNTS + 1 }, (_, i) => ({ accountCode: `M${i}`, accountName: 'm', accountType: 'asset', normalBalance: 'debit' }));
    const imp = await fx.call(coaImport, 'POST', '/api/accounting/migration/chart-of-accounts', { sessionId: session.id, accounts, systemAccountMap: {} });
    const customers = Array.from({ length: MAX_MIGRATION_CONTACTS + 1 }, (_, i) => ({ name: `C${i}` }));
    const exe = await fx.call(migrationExecute, 'POST', '/api/accounting/migration-execute', { source: 'xero', accounts: [], customers, suppliers: [] });
    const n = (await fx.query('SELECT count(*)::int AS n FROM gl_accounts WHERE company_id = $1', [CO])).rows[0].n;
    expect({ imp: imp.statusCode, exe: exe.statusCode, accounts: n }).toEqual({ imp: 400, exe: 400, accounts: 2 });
  }, 60_000);

  it('a CoA import at the account cap finishes inside the 5s other role writers will wait for it', async () => {
    const session = await createSession(CO, 'sage', USER);
    const accounts = Array.from({ length: MAX_MIGRATION_ACCOUNTS }, (_, i) => ({ accountCode: `M${String(i).padStart(4, '0')}`, accountName: 'm', accountType: 'asset', normalBalance: 'debit' }));
    const t0 = Date.now();
    const imp = await fx.call(coaImport, 'POST', '/api/accounting/migration/chart-of-accounts', { sessionId: session.id, accounts, systemAccountMap: {} });
    const ms = Date.now() - t0;
    process.stdout.write(`\nW228R9 import of ${MAX_MIGRATION_ACCOUNTS} accounts: ${ms} ms\n`);
    expect({ status: imp.statusCode, underFiveSeconds: ms < 5000 }).toEqual({ status: 200, underFiveSeconds: true });
  }, 60_000);

  const HELD_PARENTS: Record<string, string[]> = { isaflow_standard: [], xero_compatible: [], sage_compatible: ['4101 under 4100'] };
  describe.each(['isaflow_standard', 'xero_compatible', 'sage_compatible'] as CoaTemplate[])('seeding %s', (template) => {
    const lines = getTemplateLines(template);

    it('on an empty chart wires every template parent', async () => {
      await fx.wipe();
      expect((await fx.call(coaSeed, 'POST', '/api/accounting/coa-seed', { template })).statusCode).toBe(200);
      const want = Object.fromEntries(lines.map((l) => [l.code, l.parentCode ?? null]));
      expect(await tree()).toEqual(want);
    });

    it('after the company-create seed gives exactly the tree master gives (template parents win; others kept)', async () => {
      await fx.wipe();
      await fx.query('SELECT seed_company_chart_of_accounts($1)', [CO]);
      const before = await tree();
      const holders = new Set((await fx.query(`SELECT account_code FROM gl_accounts WHERE company_id = $1 AND is_system_account
        AND account_subtype IS NOT NULL AND account_subtype IN (SELECT unnest($2::text[]))`, [CO, ['bank', 'receivable', 'payable', 'vat_input',
        'vat_output', 'vat_input_late_claim', 'retained_earnings', 'opening_balance_equity', 'default_revenue', 'other_income', 'default_expense',
        'admin_expense', 'accumulated_depreciation', 'depreciation_expense', 'disposal_profit_loss']])).rows.map((r) => r.account_code));
      expect((await fx.call(coaSeed, 'POST', '/api/accounting/coa-seed', { template })).statusCode).toBe(200);
      const after = await tree();
      // Master's pass 2: every template row gets the account at its template parent code (NULL when there is none).
      // This branch differs in two deliberate places, both counted so they are visible: a template ROLE row
      // whose role the company already holds is not inserted (round 5: no second holder), and a row is not
      // wired under a parent that holds a role (round 8).
      const skippedRoleRows = lines.filter((l) => !(l.code in after)).map((l) => `${l.code}:${l.subtype}:${l.isSystem === true}`);
      const expected: Record<string, string | null> = { ...before };
      for (const code of Object.keys(after)) if (!(code in expected)) expected[code] = null;
      const heldParents: string[] = [];
      for (const l of lines.filter((x) => x.parentCode && x.code in after)) {
        const parent = l.parentCode! in after ? l.parentCode! : null;
        if (parent && holders.has(parent)) { heldParents.push(`${l.code} under ${parent}`); expected[l.code] = before[l.code] ?? null; continue; }
        expected[l.code] = parent;
      }
      expect(after).toEqual(expected);
      // Ruled by Hein 2026-10-01: a role holder has no sub-accounts. Where the company-create chart puts a
      // role on the template's parent code, that template row is left without a parent (master would
      // have made the holder a header). Pinned per template so a change to either seed is noticed.
      expect(heldParents).toEqual(HELD_PARENTS[template]);
      expect(skippedRoleRows.every((r) => r.endsWith(':true'))).toBe(true);
      process.stdout.write(`\nW228R9 ${template} after the company-create seed: ${skippedRoleRows.length} role rows not seeded again (${skippedRoleRows.join(', ')})\n`);
    });
  });
});

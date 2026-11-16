/**
 * WP2 row 5 and reallocate_bank_transaction. A reconciled line re-pointed to a BANK account would be a transfer, and a
 * transfer reaches past this one line: it pairs (auto-links) the OTHER bank's statement line, which may sit in its own
 * reconciliation — outside what a reallocation may change (one line, its completed reconciliation untouched). So the
 * reallocation keeps refusing a bank target, another bank's or the line's own, BEFORE any write (bankReallocationGuards);
 * allocateTransaction's own-bank refusal (bankContraTransfer) stands behind it. Nothing is reversed, nothing posted.
 *
 * A PIN of pre-existing behaviour (bankReallocationGuards' bank-target refusal predates row 5), not new code. The own-bank
 * case does not isolate the reallocation guard: with it removed, allocateTransaction's own-bank refusal still answers —
 * defence in depth, stated (brk-1494 LOW 5).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@/lib/neon';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras } from './d10-helpers';
import { cleanup } from './d12-helpers';
import {
  TOOL, bankGl, lineRow, mcp, newBank, reconciledLine, setupCompany, snapshot, trialBalanceGap,
} from './bank-reallocate-reconciled.helpers';

assertDisposable();
type Row = Record<string, unknown>;
let c: Ctx;

beforeAll(async () => { c = await setupCompany('REBANK'); }, 120000);
afterAll(async () => { await cleanup(c); await clearExtras(c); await teardown(c); }, 120000);

const glOf = async (account: string) => Number(((await sql`
  SELECT COALESCE(SUM(l.debit - l.credit), 0)::float8 AS n FROM gl_journal_lines l
  JOIN gl_journal_entries e ON e.id = l.journal_entry_id AND e.company_id = l.company_id
  WHERE l.company_id = ${c.fx.companyId}::UUID AND l.gl_account_id = ${account}::UUID AND e.status = 'posted'`) as Row[])[0]!.n);

describe('reallocate_bank_transaction onto a bank account is refused before any write', () => {
  it.each([
    ['another bank account', async () => newBank(c)],
    ['the line\'s own bank account', null],
  ] as const)('target: %s — refused, the line, its reconciliation and the ledger untouched', async (_what, target) => {
    const s = await reconciledLine(c, { amount: -400, date: '2026-06-10', statementDate: '2026-06-30', alloc: 'account', contra: c.acct.expense });
    const account = target ? await target() : s.bank;
    const before = await snapshot(c, s.bt, s.rec);
    const gl = { bank: await bankGl(c, s.bank, '2026-06-30'), target: await glOf(account), expense: await glOf(c.acct.expense) };
    const r = await mcp(c, TOOL, { transaction_id: s.bt, expected_journal_entry_id: s.je, target: { gl_account_id: account },
      dry_run: false, idempotency_key: randomUUID() });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toMatch(/bank account/);
    expect(await snapshot(c, s.bt, s.rec)).toEqual(before); // line, reconciliation row, journal count, documents
    expect({ bank: await bankGl(c, s.bank, '2026-06-30'), target: await glOf(account), expense: await glOf(c.acct.expense) })
      .toEqual(gl);
    expect(await lineRow(s.bt)).toMatchObject({ status: 'reconciled', allocation_type: 'account' });
    expect(Math.abs(await trialBalanceGap(c))).toBeLessThan(0.005);
  }, 120000);
});

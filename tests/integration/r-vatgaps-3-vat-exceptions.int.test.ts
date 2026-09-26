/**
 * VAT-gaps batch item 3: the vat_exceptions MCP tool against a real ledger —
 * every exception type marked blocking/non-blocking with counts and items,
 * plus the override history for the period, scoped to the caller's company.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { vatExceptionsTool } from '@/lib/mcp/tools/vatExceptions';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;

let fxA: Fixture;
let fxB: Fixture;
let vatInputAccA: string;
let expenseAccA: string;

const PERIOD_START = '2026-07-01';
const PERIOD_END = '2026-08-31';

function ctxFor(fx: Fixture): McpToolContext {
  return { userId: fx.userId, companyId: fx.companyId, scopes: ['read:vat'], tokenJti: 'jti', oauthAppId: null };
}

function body(result: McpToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text);
}

async function account(fx: Fixture, code: string, name: string, subtype: string): Promise<string> {
  return String(((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
    VALUES (${fx.companyId}::UUID, ${code}, ${`${name} ${fx.tag}`}, 'asset', ${subtype}, 'debit', true)
    RETURNING id`) as Row[])[0]!.id);
}

describeIfDb('VAT-gaps item 3: vat_exceptions tool', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts a journal and reads VAT exceptions for two companies.');
    fxA = await seedFixture('VATEXC-A', DATABASE_URL!);
    fxB = await seedFixture('VATEXC-B', DATABASE_URL!);
    vatInputAccA = await account(fxA, '1500', 'VAT Input', 'vat_input');
    expenseAccA = await account(fxA, '7900', 'Expense', 'operating_expense');

    // Company A has one bare unsupported input-VAT journal; company B has none.
    await inTx(fxA, async () => {
      const je = await createJournalEntry(fxA.companyId, {
        entryDate: '2026-07-10', description: 'manual VAT claim', source: 'manual',
        // vatType: 'standard' so this is ONLY an unsupported input-VAT claim,
        // not also an uncoded GL VAT line.
        lines: [
          { glAccountId: vatInputAccA, debit: 30, credit: 0, vatType: 'standard' },
          { glAccountId: expenseAccA, debit: 0, credit: 30 },
        ],
      }, fxA.userId);
      await postJournalEntry(fxA.companyId, je.id, fxA.userId);
    });
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${fxA.companyId}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${fxA.companyId}::UUID`;
    await dropFixture(fxA);
    await dropFixture(fxB);
  }, 120000);

  it('reports the NON-blocking unsupportedInputVat category for company A, with items and counts (Hein, 2026-09-26)', async () => {
    const result = await inTx(fxA, () => vatExceptionsTool.handler(
      { period_start: PERIOD_START, period_end: PERIOD_END }, ctxFor(fxA),
    ));
    const b = body(result);
    // Unsupported input VAT is the ONLY exception here, and no longer blocks:
    // the vendor's legal responsibility to hold a tax invoice, which may live
    // outside IsaFlow.
    expect(b.totalExceptions).toBe(0);
    const categories = b.categories as { type: string; blocking: boolean; count: number; items: unknown[] }[];
    const unsupported = categories.find((c) => c.type === 'unsupportedInputVat')!;
    expect(unsupported.blocking).toBe(false);
    expect(unsupported.count).toBeGreaterThanOrEqual(1);
    expect(unsupported.items.length).toBeGreaterThanOrEqual(1);
    const declaredElsewhere = categories.find((c) => c.type === 'declaredElsewhereVat')!;
    expect(declaredElsewhere.blocking).toBe(false);
  });

  it('does not leak company A\'s exception into company B\'s report (tenant scoping)', async () => {
    const result = await inTx(fxB, () => vatExceptionsTool.handler(
      { period_start: PERIOD_START, period_end: PERIOD_END }, ctxFor(fxB),
    ));
    const b = body(result);
    expect(b.totalExceptions).toBe(0);
    const categories = b.categories as { type: string; count: number }[];
    const unsupported = categories.find((c) => c.type === 'unsupportedInputVat')!;
    expect(unsupported.count).toBe(0);
  });

  it('carries an empty override history for a period with none recorded', async () => {
    const result = await inTx(fxA, () => vatExceptionsTool.handler(
      { period_start: PERIOD_START, period_end: PERIOD_END }, ctxFor(fxA),
    ));
    const b = body(result);
    expect(b.overrideHistory).toEqual([]);
  });
});

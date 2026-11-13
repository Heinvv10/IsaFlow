/**
 * The calls the void_payment undo_share suites share: void_payment through the real MCP registry, a contra through
 * settle_by_contra, and a bill + contra + share journal in one step. Bound to the suite's fixture by getters, since
 * the fixture is created in its beforeAll.
 */
import { expect } from 'vitest';
import { sql } from '@/lib/neon';
import { McpRegistry } from '@/lib/mcp/registry';
import { voidPaymentTool } from '@/lib/mcp/tools/writeVoidPayments';
import { settleByContraTool } from '@/lib/mcp/tools/writeSettleByContra';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';
import { inTx, type Fixture } from './l1FifoFixture';
import { billWithJournal, postedJournal, type Leg, type StepAccounts } from './shareUndoFixture';

type Row = Record<string, unknown>;
export const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

export function undoShareKit(fx: () => Fixture, a: () => StepAccounts) {
  const registry = new McpRegistry();
  registry.register(voidPaymentTool);
  const ctx = (scopes = ['write:invoices', 'write:post', 'write:journals']): McpToolContext => ({
    userId: fx().userId, companyId: fx().companyId, scopes, companyRole: 'owner', tokenJti: 'step6', oauthAppId: null,
  } as McpToolContext);
  const call = (args: Row, scopes?: string[]): Promise<McpToolResult> =>
    inTx(fx(), () => registry.call('void_payment', args, ctx(scopes)));
  /** The same call on whatever connection the caller has bound (runOn) — it opens no transaction of its own. */
  const callHere = (args: Row): Promise<McpToolResult> => registry.call('void_payment', args, ctx());
  const contra = async (billId: string, amount: number): Promise<string> => {
    const r = await inTx(fx(), () => settleByContraTool.handler({
      subledger: 'ap', document_id: billId, contra_account_id: a().clearing, amount, reason: 'petty cash via paycards',
      settlement_date: '2026-09-17', idempotency_key: crypto.randomUUID(),
    }, ctx()));
    expect(r.isError, text(r)).toBeFalsy();
    return String(JSON.parse(text(r)).payment_id);
  };
  const payStatus = async (id: string) =>
    String(((await sql`SELECT status FROM supplier_payments WHERE id = ${id}::UUID`) as Row[])[0]!.status);
  /** A bill of 1,150 (1,000 expense + 150 VAT), settled by a contra, and a share journal dated `shareDate` that carried it. */
  const scenario = async (tag: string, shareDate: string, billDate = '2026-05-10', legs?: Leg[]) => {
    const A = a();
    const bill = await billWithJournal(fx(), A, tag, billDate, legs
      ?? [{ account: A.expense, debit: 1000 }, { account: A.vatInput, debit: 150, vatType: 'standard' }]);
    const pay = await contra(bill.id, bill.total);
    const share = await postedJournal(fx(), shareDate, [
      { account: A.clearing, debit: bill.total },
      ...(legs ?? [{ account: A.expense, debit: 1000 }, { account: A.vatInput, debit: 150, vatType: 'standard' }])
        .map((l) => ({ account: l.account, credit: l.debit, vatType: l.vatType })),
    ]);
    return { bill, pay, share };
  };
  return { call, callHere, contra, payStatus, scenario };
}

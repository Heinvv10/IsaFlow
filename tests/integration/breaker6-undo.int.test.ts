import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { McpRegistry } from '@/lib/mcp/registry';
import { voidPaymentTool } from '@/lib/mcp/tools/writeVoidPayments';
import { settleByContraTool } from '@/lib/mcp/tools/writeSettleByContra';
import { getVATReturn } from '@/modules/accounting/services/reports/vatReturnService';
import type { McpToolContext } from '@/lib/mcp/types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import { apSubledger, billWithJournal, dropStepExtras, ledger, postedJournal, seedStepAccounts, type StepAccounts } from './helpers/shareUndoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
type Row = Record<string, unknown>;
let fx: Fixture;
let a: StepAccounts;
const registry = new McpRegistry();
registry.register(voidPaymentTool);
const ctx = (): McpToolContext => ({ userId: fx.userId, companyId: fx.companyId, scopes: ['write:invoices', 'write:post', 'write:journals'],
  companyRole: 'owner', tokenJti: 'brk6', oauthAppId: null } as McpToolContext);
const call = (args: Row) => inTx(fx, () => registry.call('void_payment', args, ctx()));
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;
const contra = async (billId: string, amount: number) => {
  const r = await inTx(fx, () => settleByContraTool.handler({ subledger: 'ap', document_id: billId, contra_account_id: a.clearing, amount,
    reason: 'petty cash', settlement_date: '2026-09-17', idempotency_key: crypto.randomUUID() }, ctx()));
  expect(r.isError, text(r)).toBeFalsy();
  return String(JSON.parse(text(r)).payment_id);
};
const vatMay = async () => (await getVATReturn(fx.companyId, '2026-05-01', '2026-05-31')).totalInputTax;
const vat07 = async () => (await getVATReturn(fx.companyId, '2026-07-01', '2026-07-31')).totalInputTax;
const legs = () => [{ account: a.expense, debit: 1000 }, { account: a.vatInput, debit: 150, vatType: 'standard' }];
const r2 = (n: number) => Math.round(n * 100) / 100;

describe.skipIf(!DATABASE_URL)('breaker6 undo_share', () => {
  beforeAll(async () => {
    assertNotProductionDb('breaker6 posts journals and voids payments.');
    fx = await seedFixture('BRK6', DATABASE_URL!); a = await seedStepAccounts(fx);
  }, 120000);
  afterAll(async () => { await dropStepExtras(fx); await dropFixture(fx); }, 120000);

  it('REPRO 1: one share journal (covering ONE bill) is consumed by two different contras', async () => {
    const before = await ledger(fx); const vat0 = await vatMay();
    const A = await billWithJournal(fx, a, 'R1A', '2026-05-10', legs());
    const B = await billWithJournal(fx, a, 'R1B', '2026-05-11', legs());
    const pA = await contra(A.id, 1150); const pB = await contra(B.id, 1150);
    // The share took ONLY bill A out of the clearing account.
    const share = await postedJournal(fx, '2026-05-31', [{ account: a.clearing, debit: 1150 }, { account: a.expense, credit: 1000 },
      { account: a.vatInput, credit: 150, vatType: 'standard' }], 'SHARE-A-ONLY');
    const first = await call({ payment_id: pA, undo_share: true, share_journal_id: share, idempotency_key: crypto.randomUUID() });
    expect(first.isError, text(first)).toBeFalsy();
    const second = await call({ payment_id: pB, undo_share: true, share_journal_id: share, idempotency_key: crypto.randomUUID() });
    // Adjusted (step-6 round 2): the refusal leaves B's contra standing by design; the remedy it names is a plain void
    // of B (its share was never taken), after which both contras are gone as the original expectation assumed.
    expect(text(second)).toMatch(/does not hold/);
    const plainB = await call({ payment_id: pB, idempotency_key: crypto.randomUUID() });
    expect(plainB.isError, text(plainB)).toBeFalsy();
    const after = await ledger(fx);
    const clearingDelta = r2((after.by[a.clearing] ?? 0) - (before.by[a.clearing] ?? 0));
    const vatDelta = r2(await vatMay() - vat0);
    // Correct: both contras gone, only A was shared and undone -> clearing back to where it was; May input VAT = both bills (300).
    expect({ secondRefused: second.isError === true, clearingDelta, vatDelta, balanced: after.balanced,
      apMatches: -(after.by[a.ap] ?? 0) === await apSubledger(fx) })
      .toEqual({ secondRefused: true, clearingDelta: 0, vatDelta: 300, balanced: true, apMatches: true });
  }, 120000);

  it('REPRO 2: multi-bill share that reversed only HALF of bill H — undo restores all of H', async () => {
    const before = await ledger(fx); const vat0 = await vatMay();
    const G = await billWithJournal(fx, a, 'R2G', '2026-05-10', legs());
    const H = await billWithJournal(fx, a, 'R2H', '2026-05-11', legs());
    await contra(G.id, 1150); const pH = await contra(H.id, 1150);
    // Share: all of G + half of H (1725). Then only H's contra is voided.
    const share = await postedJournal(fx, '2026-05-31', [{ account: a.clearing, debit: 1725 }, { account: a.expense, credit: 1500 },
      { account: a.vatInput, credit: 225, vatType: 'standard' }], 'SHARE-G-HALFH');
    const r = await call({ payment_id: pH, undo_share: true, share_journal_id: share, idempotency_key: crypto.randomUUID() });
    // Adjusted (step-6 round 2, documented refusal): the share debits the clearing account by more than H's payment
    // applied, so it carries other bills and the undo is refused until undo_amounts says how much of H it reversed.
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Pass undo_amounts/);
    expect(r2(await vatMay() - vat0)).toBe(75);
    const capped = await call({ payment_id: pH, undo_share: true, share_journal_id: share,
      undo_amounts: [{ bill_id: H.id, amount: 575 }], idempotency_key: crypto.randomUUID() });
    expect(capped.isError, text(capped)).toBeFalsy();
    const undo = JSON.parse(text(capped)).undo_share.total;
    const after = await ledger(fx);
    const vatDelta = r2(await vatMay() - vat0);
    // Correct: H's share was 575 (VAT 75) -> undo must restore at most 575 / 75. Bills 300 - share 225 + 75 = 150.
    expect({ refusedOrCapped: undo <= 575, vatDelta, balanced: after.balanced }).toEqual({ refusedOrCapped: true, vatDelta: 150, balanced: true });
    void before;
  }, 120000);

  it('REPRO 3: share already partly undone by hand (no undo-share reference) — undo_share restores it again', async () => {
    const vat0 = await vatMay();
    const C = await billWithJournal(fx, a, 'R3C', '2026-05-10', legs());
    const pC = await contra(C.id, 1150);
    const share = await postedJournal(fx, '2026-05-31', [{ account: a.clearing, debit: 1150 }, { account: a.expense, credit: 1000 },
      { account: a.vatInput, credit: 150, vatType: 'standard' }], 'SHARE-C');
    // A person already undid the share by hand (JE-2026-29195 style), reference free text.
    await postedJournal(fx, '2026-05-31', [{ account: a.expense, debit: 1000 }, { account: a.vatInput, debit: 150, vatType: 'standard' },
      { account: a.clearing, credit: 1150 }], 'undo share SIV R3C by hand');
    const r = await call({ payment_id: pC, undo_share: true, share_journal_id: share, idempotency_key: crypto.randomUUID() });
    const vatDelta = r2(await vatMay() - vat0);
    expect({ refused: r.isError === true, vatDelta }).toEqual({ refused: true, vatDelta: 150 });
  }, 120000);

  // Round 4: moved to 2026-07 — every same-month hand undo on these accounts now counts against a share
  // (refusing-side limit), and an earlier repro in this file leaves one in May.
  it('REPRO 4: void -> new contra on the same bill -> undo again with the SAME share', async () => {
    const vat0 = await vat07();
    const D = await billWithJournal(fx, a, 'R4D', '2026-07-10', legs());
    const p1 = await contra(D.id, 1150);
    const share = await postedJournal(fx, '2026-07-31', [{ account: a.clearing, debit: 1150 }, { account: a.expense, credit: 1000 },
      { account: a.vatInput, credit: 150, vatType: 'standard' }], 'SHARE-D');
    const r1 = await call({ payment_id: p1, undo_share: true, share_journal_id: share, idempotency_key: crypto.randomUUID() });
    expect(r1.isError, text(r1)).toBeFalsy();
    const p2 = await contra(D.id, 1150);
    const r2c = await call({ payment_id: p2, undo_share: true, share_journal_id: share, idempotency_key: crypto.randomUUID() });
    const vatDelta = r2(await vat07() - vat0);
    expect({ refused: r2c.isError === true, vatDelta }).toEqual({ refused: true, vatDelta: 150 });
  }, 120000);

  // Round 4: moved to 2026-07 — every same-month hand undo on these accounts now counts against a share
  // (refusing-side limit), and an earlier repro in this file leaves one in May.
  it('REPRO 5: dry run leaves no trace (numbers, status, undo count)', async () => {
    const E = await billWithJournal(fx, a, 'R5E', '2026-07-10', legs());
    const pE = await contra(E.id, 1150);
    const share = await postedJournal(fx, '2026-07-31', [{ account: a.clearing, debit: 1150 }, { account: a.expense, credit: 1000 },
      { account: a.vatInput, credit: 150, vatType: 'standard' }], 'SHARE-E');
    const snap = async () => (await sql`SELECT
      (SELECT COUNT(*)::INT FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID) AS je,
      (SELECT MAX(entry_number) FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID) AS maxno,
      (SELECT status FROM supplier_payments WHERE id = ${pE}::UUID) AS st,
      (SELECT amount_paid::float8 FROM supplier_invoices WHERE id = ${E.id}::UUID) AS paid,
      (SELECT COUNT(*)::INT FROM payment_allocations WHERE payment_id = ${pE}::UUID) AS allocs`) as Row[];
    const s0 = await snap();
    const key = crypto.randomUUID();
    const d = await call({ payment_id: pE, undo_share: true, share_journal_id: share, dry_run: true, idempotency_key: key });
    expect(d.isError, text(d)).toBeFalsy();
    const s1 = await snap();
    const live = await call({ payment_id: pE, undo_share: true, share_journal_id: share, idempotency_key: key });
    expect(live.isError, text(live)).toBeFalsy();
    expect(s1).toEqual(s0);
  }, 120000);
  // Round 4: moved to 2026-07 — every same-month hand undo on these accounts now counts against a share
  // (refusing-side limit), and an earlier repro in this file leaves one in May.
  it('REPRO 7: share VAT line without a vat_type — the undo restores VAT the share never took out of the VAT201', async () => {
    const F = await billWithJournal(fx, a, 'R7F', '2026-07-10', legs());
    const pF = await contra(F.id, 1150);
    const v0 = await vat07();
    const share = await postedJournal(fx, '2026-07-31', [{ account: a.clearing, debit: 1150 }, { account: a.expense, credit: 1000 },
      { account: a.vatInput, credit: 150 }], 'SHARE-F-NOVATTYPE');
    const vShare = r2(await vat07() - v0);
    const r = await call({ payment_id: pF, undo_share: true, share_journal_id: share, idempotency_key: crypto.randomUUID() });
    expect(r.isError, text(r)).toBeFalsy();
    const vUndo = r2(await vat07() - v0);
    // The undo must restore exactly what the share took out of the VAT201: net zero.
    expect({ vShare, vUndo }).toEqual({ vShare, vUndo: 0 });
  }, 120000);
});

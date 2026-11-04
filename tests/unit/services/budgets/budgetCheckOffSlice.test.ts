/**
 * Budgets P5-2b (Hein, 2026-11-04): a document line whose ACCOUNT has a budget in the primary version, at some
 * slice of its grain, but which lands outside every budgeted slice is "off-slice": refused in block, warned in warn
 * (the UI channel needs the reason, like an over line), nothing in off. Two cases: the line lacks the grain's
 * dimension (the unassigned slice), or its member at the grain has no row in the version while others do. An
 * account with NO row in the version stays "No budget", never flagged. Pure core only (`computeRemaining`,
 * `sliceLines`, `decideBudgetOutcome`); the real-PG proof is `tests/integration/budgets-p5-off-slice*.int.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { formatMoney as R } from '@/lib/money/formatMoney';
import {
  decideBudgetOutcome, distinctKeys, sliceLines, type DocumentLine,
} from '@/modules/accounting/services/budgets/budgetCheckCore';
import type { BudgetChannel, BudgetCheckLine } from '@/modules/accounting/services/budgets/budgetCheckTypes';
import {
  budgetedSliceKey, computeRemaining, type RemainingInputs, type RemainingKey, type RemainingResult,
} from '@/modules/accounting/services/budgets/remainingBudgetCore';

const V = 'v-27';
const key = (over: Partial<RemainingKey> = {}): RemainingKey => ({ glAccountId: 'opex', cc1Id: null, cc2Id: null, buId: null, month: '2026-06', ...over });
const row = (cc1Id: string | null, month = '2026-06') => ({ versionId: V, glAccountId: 'opex', month, cc1Id, cc2Id: null, buId: null, amount: 100 });
const inputs = (over: Partial<RemainingInputs> = {}): RemainingInputs => ({
  versionOf: () => V,
  grains: new Map([[`${V}|opex`, 'cc1' as const]]),
  budgets: [row('ft')],
  budgetedSlices: new Set([budgetedSliceKey(V, 'opex', 'ft')]),
  actuals: [],
  commitments: [],
  ...over,
});

describe('computeRemaining: offSlice', () => {
  it('the unassigned slice of a budgeted account is off-slice (budget null)', () => {
    const [r] = computeRemaining([key({ cc2Id: 'p1' })], inputs());
    expect(r).toMatchObject({ grain: 'cc1', unassigned: true, budget: null, remaining: null, offSlice: true });
  });
  it('a member with no row in the version while another member has one is off-slice, its slice named', () => {
    const [r] = computeRemaining([key({ cc1Id: 'xx' })], inputs());
    expect(r).toMatchObject({ grain: 'cc1', unassigned: false, slice: { cc1Id: 'xx', cc2Id: null, buId: null }, budget: null, offSlice: true });
  });
  it('a budgeted slice is not off-slice, even in a month it has no row for (that month is "No budget")', () => {
    const [within, blankMonth] = computeRemaining([key({ cc1Id: 'ft' }), key({ cc1Id: 'ft', month: '2026-07' })], inputs());
    expect(within).toMatchObject({ budget: 100, offSlice: false });
    expect(blankMonth).toMatchObject({ budget: null, offSlice: false });
  });
  it('an account with no budget in the version, no version at all, or a company-grain account is never off-slice', () => {
    expect(computeRemaining([key({ glAccountId: 'nob' })], inputs())[0]).toMatchObject({ grain: null, offSlice: false });
    expect(computeRemaining([key()], inputs({ versionOf: () => null }))[0]).toMatchObject({ grain: null, offSlice: false });
    const company = inputs({ grains: new Map([[`${V}|opex`, 'company' as const]]), budgets: [row(null)], budgetedSlices: new Set([budgetedSliceKey(V, 'opex', null)]) });
    expect(computeRemaining([key({ cc1Id: 'xx', month: '2026-08' })], company)[0]).toMatchObject({ grain: 'company', budget: null, offSlice: false });
  });
});

describe('sliceLines: off-slice lines', () => {
  const run = (lines: DocumentLine[]) => {
    const keys = distinctKeys(lines, '2026-06');
    return sliceLines(lines, keys, computeRemaining(keys, inputs()));
  };
  it('sums the lines landing on one off-slice member at the grain (the dims below it dropped)', () => {
    const out = run([
      { glAccountId: 'opex', cc1Id: 'xx', cc2Id: 'p1', buId: null, amount: 40 },
      { glAccountId: 'opex', cc1Id: 'xx', cc2Id: 'p2', buId: null, amount: 60 },
    ]);
    expect(out).toEqual([expect.objectContaining({ cc1Id: 'xx', cc2Id: null, amount: 100, offSlice: true, over: false, budget: null })]);
  });
  it('a credit netting an off-slice slice to zero or below flags nothing', () => {
    const out = run([
      { glAccountId: 'opex', cc1Id: null, cc2Id: null, buId: null, amount: 50 },
      { glAccountId: 'opex', cc1Id: null, cc2Id: null, buId: null, amount: -50 },
    ]);
    expect(out.every((l) => !l.offSlice)).toBe(true);
  });
  it('a line on an account with no budget is "No budget", not off-slice', () => {
    expect(run([{ glAccountId: 'nob', cc1Id: null, cc2Id: null, buId: null, amount: 5 }])[0]).toMatchObject({ offSlice: false, budget: null });
  });
});

const line = (o: Partial<BudgetCheckLine> = {}): BudgetCheckLine => ({
  glAccountId: 'opex', month: '2026-06', grain: 'cc1', cc1Id: null, cc2Id: null, buId: null, unassigned: true,
  budget: null, actual: 0, committed: 0, remaining: null, amount: 150, over: false, offSlice: true,
  accountLabel: '6100 Opex', sliceLabel: '', ...o,
});
const OFF = [line()];
const NO_BUDGET = [line({ grain: null, unassigned: false, offSlice: false })];
const ALL: BudgetChannel[] = ['ui', 'bulk', 'mcp', 'system'];

describe('decideBudgetOutcome: off-slice lines', () => {
  it('off: passes, no event', () => {
    for (const channel of ALL) expect(decideBudgetOutcome({ policy: 'off', lines: OFF, channel })).toEqual({ kind: 'proceed', event: null, warnings: [], reason: null });
  });
  it('block, every channel: refused, naming the account, the slice it landed in and the remedy', () => {
    for (const channel of ALL) {
      const d = decideBudgetOutcome({ policy: 'block', lines: OFF, channel });
      expect(d.kind).toBe('refuse');
      if (d.kind !== 'refuse') continue;
      expect(d.message).toContain('6100 Opex · no cost centre 1 · 2026-06: not in a budgeted slice');
      // Only what is possible (round 4 LOW 2): a bill's lines cannot be edited in the app; MCP can set them.
      const reenter = 'cancel it and enter it again with a budgeted cost centre 1 on its line';
      if (channel === 'system') {
        expect(d.message).toContain(`The bill was left as a draft: an owner or admin can approve it with an override and a reason, or ${reenter}.`);
      } else if (channel === 'ui') {
        expect(d.message).toContain(`An owner or admin can override it with a reason, or ${reenter}.`);
      } else if (channel === 'bulk') {
        expect(d.message).toContain(`Approve it on its own in the app, where an owner or admin can override it, or ${reenter}.`);
      } else {
        expect(d.message).toContain('set a budgeted cost centre 1 on the line with update_supplier_invoice (if it refuses the edit');
        expect(d.message).toContain('cancel the bill and enter it again, or have an owner or admin override)');
      }
      if (channel !== 'mcp') expect(d.message).not.toMatch(/assign|set a budgeted|update_supplier_invoice/);
    }
    const member = decideBudgetOutcome({ policy: 'block', lines: [line({ unassigned: false, grain: 'cc2', cc2Id: 'pb', sliceLabel: 'PB Project B' })], channel: 'ui' });
    expect(member).toMatchObject({ kind: 'refuse', message: expect.stringContaining('6100 Opex · PB Project B · 2026-06: not in a budgeted slice') });
    expect(member.kind === 'refuse' && member.message).toContain('with a budgeted cost centre 2 on its line');
    // A purchase order's lines are edited in the app: the line says so.
    const order = decideBudgetOutcome({ policy: 'block', lines: OFF, channel: 'ui', documentNoun: 'this order' });
    expect(order.kind === 'refuse' && order.message).toContain('not in a budgeted slice, this order R');
    expect(order.kind === 'refuse' && order.message).toContain('; assign a budgeted cost centre 1');
    expect(order.kind === 'refuse' && order.message).not.toMatch(/cancel it/);
  });
  it('block: figures name this document\'s amount; without figures none', () => {
    const d = decideBudgetOutcome({ policy: 'block', lines: OFF, channel: 'mcp', documentNoun: 'this order' });
    expect(d.kind === 'refuse' && d.message).toContain(`this order ${R(150)}`);
    const plain = decideBudgetOutcome({ policy: 'block', lines: OFF, channel: 'mcp', figures: false });
    expect(plain.kind === 'refuse' && plain.message).not.toMatch(/R\s?\d|this bill/u);
  });
  it('block, UI: an owner/admin override with a reason proceeds (event override); a manager is refused; no reason → reason required', () => {
    expect(decideBudgetOutcome({ policy: 'block', lines: OFF, channel: 'ui', override: true, actorRole: 'owner', reason: 'Board' }))
      .toMatchObject({ kind: 'proceed', event: 'override', reason: 'Board' });
    expect(decideBudgetOutcome({ policy: 'block', lines: OFF, channel: 'ui', override: true, actorRole: 'manager', reason: 'x' }))
      .toMatchObject({ kind: 'refuse', overrideRefused: true });
    expect(decideBudgetOutcome({ policy: 'block', lines: OFF, channel: 'ui', override: true, actorRole: 'admin' })).toMatchObject({ kind: 'reason_required' });
  });
  it('warn, UI: needs a reason; with one proceeds, event warn, warned as not in a budgeted slice', () => {
    expect(decideBudgetOutcome({ policy: 'warn', lines: OFF, channel: 'ui' }))
      .toMatchObject({ kind: 'reason_required', message: expect.stringContaining('not in a budgeted slice') });
    expect(decideBudgetOutcome({ policy: 'warn', lines: OFF, channel: 'ui', reason: 'Shared cost' })).toMatchObject({
      kind: 'proceed', event: 'warn', reason: 'Shared cost', warnings: [expect.stringMatching(/^Not in a budgeted slice: 6100 Opex · no cost centre 1 · 2026-06/)],
    });
  });
  it('a warning says "not in a budgeted slice" and names the account once (blind review LOW)', () => {
    const d = decideBudgetOutcome({ policy: 'warn', lines: OFF, channel: 'bulk' });
    const w = d.kind === 'proceed' ? d.warnings[0]! : '';
    expect(w).toBe(`Not in a budgeted slice: 6100 Opex · no cost centre 1 · 2026-06, this bill ${R(150)}`);
  });
  it('warn, bulk / MCP / system: proceed with the warning, never refused', () => {
    for (const channel of ['bulk', 'mcp', 'system'] as const) {
      expect(decideBudgetOutcome({ policy: 'warn', lines: OFF, channel })).toMatchObject({ kind: 'proceed', event: 'warn', warnings: [expect.stringMatching(/^Not in a budgeted slice/)] });
    }
  });
  it('an account with no budget anywhere stays "No budget": proceeds in block, no event', () => {
    for (const channel of ALL) expect(decideBudgetOutcome({ policy: 'block', lines: NO_BUDGET, channel })).toEqual({ kind: 'proceed', event: null, warnings: [], reason: null });
  });
  it('an over line and an off-slice line are both named in one refusal', () => {
    const over = line({ grain: 'company', unassigned: false, offSlice: false, budget: 100, remaining: 100, amount: 150, over: true });
    const d = decideBudgetOutcome({ policy: 'block', lines: [over, ...OFF], channel: 'bulk' });
    expect(d.kind === 'refuse' && d.message).toMatch(/remaining .*this bill.*; 6100 Opex · no cost centre 1 · 2026-06: not in a budgeted slice/);
  });
});

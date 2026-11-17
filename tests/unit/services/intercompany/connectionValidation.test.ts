/**
 * Intercompany P1: the pure rules for a connection and for editing one's own side. Types first (400, never a
 * 500 from a ::UUID or ::DATE cast), then the settlement, auto-accept, cut-over and interest rules, then the
 * per-side setup checklist.
 */
import { describe, expect, it } from 'vitest';
import {
  autoAcceptRefusal,
  computeChecklist,
  orderedPair,
  parseCreateInput,
  parsePairInput,
  parseSideInput,
  type SideState,
} from '@/modules/accounting/services/intercompany/connectionValidation';

const U1 = 'a0000000-0000-4000-8000-00000000000b';
const U2 = 'c0000000-0000-4000-8000-00000000000d';

describe('parseCreateInput', () => {
  it('takes a UUID partnerCompanyId and lowercases it', () => {
    expect(parseCreateInput({ partnerCompanyId: U1.toUpperCase() })).toEqual({ ok: true, partnerCompanyId: U1 });
  });
  it.each([
    ['not an object', null], ['array', []], ['missing', {}], ['number', { partnerCompanyId: 5 }],
    ['not a uuid', { partnerCompanyId: 'abc' }], ['array value', { partnerCompanyId: [U1] }],
    ['unknown key', { partnerCompanyId: U1, kind: 'external' }],
  ])('refuses %s', (_n, body) => {
    expect(parseCreateInput(body)).toMatchObject({ ok: false });
  });
});

describe('parseSideInput', () => {
  it('accepts a full valid body and normalises ids', () => {
    const r = parseSideInput({ customerId: U1.toUpperCase(), supplierId: null, loanAccountId: U2, defaultExpenseAccountId: null, autoAccept: true });
    expect(r).toEqual({ ok: true, value: { customerId: U1, supplierId: null, loanAccountId: U2, defaultExpenseAccountId: null, autoAccept: true } });
  });

  it('leaves absent keys out (unchanged) and keeps explicit null (clear)', () => {
    expect(parseSideInput({ loanAccountId: null })).toEqual({ ok: true, value: { loanAccountId: null } });
  });

  it.each([
    ['empty body', {}], ['not an object', 'x'], ['array', []], ['null', null],
    ['unknown key', { companyId: U1 }],
    ['unknown key beside a valid one', { autoAccept: true, companyId: U1 }],
    ['a pair setting (it moved to the connection)', { settlementMode: 'loan' }],
    ['a pair setting: cutoverDate', { cutoverDate: '2026-12-01' }],
    ['customerId number', { customerId: 5 }],
    ['customerId not uuid', { customerId: 'nope' }],
    ['supplierId array', { supplierId: [U1] }],
    ['loanAccountId not uuid', { loanAccountId: '1; DROP' }],
    ['defaultExpenseAccountId empty string', { defaultExpenseAccountId: '' }],
    ['autoAccept string', { autoAccept: 'true' }],
    ['autoAccept null', { autoAccept: null }],
  ])('refuses %s', (_n, body) => {
    expect(parseSideInput(body)).toMatchObject({ ok: false });
  });
});

describe('parsePairInput', () => {
  it('accepts a full valid body', () => {
    expect(parsePairInput({ settlementMode: 'loan', cutoverDate: '2026-12-01', interestRatePct: 10.5 }))
      .toEqual({ ok: true, value: { settlementMode: 'loan', cutoverDate: '2026-12-01', interestRatePct: 10.5 } });
  });
  it('leaves absent keys out and keeps explicit null', () => {
    expect(parsePairInput({ cutoverDate: null })).toEqual({ ok: true, value: { cutoverDate: null } });
  });
  it.each([
    ['empty body', {}], ['not an object', 'x'], ['array', []],
    ['unknown key', { companyId: U1 }], ['unknown key beside a valid one', { cutoverDate: '2026-12-01', companyId: U1 }],
    ['a side field', { customerId: null }],
    ['settlementMode unknown', { settlementMode: 'barter' }], ['settlementMode not string', { settlementMode: 1 }],
    ['cutoverDate not a string', { cutoverDate: 20261201 }], ['cutoverDate wrong shape', { cutoverDate: '01/12/2026' }],
    ['cutoverDate impossible day', { cutoverDate: '2026-02-31' }],
    ['interest string', { interestRatePct: '5' }], ['interest negative', { interestRatePct: -0.01 }],
    ['interest over 100', { interestRatePct: 100.01 }], ['interest NaN', { interestRatePct: Number.NaN }],
    ['interest Infinity', { interestRatePct: Number.POSITIVE_INFINITY }],
  ])('refuses %s', (_n, body) => {
    expect(parsePairInput(body)).toMatchObject({ ok: false });
  });
  it.each([0, 100, 7.5])('accepts interest %s and null', (v) => {
    expect(parsePairInput({ interestRatePct: v })).toEqual({ ok: true, value: { interestRatePct: v } });
    expect(parsePairInput({ interestRatePct: null })).toEqual({ ok: true, value: { interestRatePct: null } });
  });
});

describe('autoAcceptRefusal', () => {
  it('refuses auto-accept on anything but a group connection', () => {
    expect(autoAcceptRefusal('external', true)).toMatch(/group/i);
    expect(autoAcceptRefusal('group', true)).toBeNull();
  });
  it('never refuses turning it off or leaving it alone', () => {
    expect(autoAcceptRefusal('external', false)).toBeNull();
    expect(autoAcceptRefusal('external', undefined)).toBeNull();
  });
});

describe('orderedPair', () => {
  it('puts the smaller uuid low whichever way round, comparing lowercase', () => {
    expect(orderedPair(U2, U1)).toEqual({ low: U1, high: U2 });
    expect(orderedPair(U1, U2.toUpperCase())).toEqual({ low: U1, high: U2 });
  });
});

const side = (over: Partial<SideState> = {}): SideState => ({ customerId: null, supplierId: null, loanAccountId: null, ...over });
const CASH = { settlementMode: 'cash', cutoverDate: '2026-12-01' } as const;
const LOAN = { settlementMode: 'loan', cutoverDate: '2026-12-01' } as const;
const NO_CUTOVER = { settlementMode: 'cash', cutoverDate: null } as const;

describe('computeChecklist', () => {
  it('a missing side is all undone, and not complete', () => {
    const c = computeChecklist(null, NO_CUTOVER);
    expect(c.complete).toBe(false);
    expect(c.items.filter((i) => i.required && !i.done).map((i) => i.key)).toEqual(['customer', 'supplier', 'cutover']);
  });

  it('cash mode: the loan item is not required', () => {
    const c = computeChecklist(side({ customerId: U1, supplierId: U1 }), CASH);
    expect(c.complete).toBe(true);
    expect(c.items.find((i) => i.key === 'loanAccount')).toMatchObject({ required: false });
  });

  it('loan mode (the PAIR\'s): a loan account is required', () => {
    const base = side({ customerId: U1, supplierId: U1 });
    expect(computeChecklist(base, LOAN).complete).toBe(false);
    expect(computeChecklist(base, LOAN).items.find((i) => i.key === 'loanAccount')).toMatchObject({ required: true, done: false });
    expect(computeChecklist({ ...base, loanAccountId: U2 }, LOAN).complete).toBe(true);
  });

  it('the cut-over date is the pair\'s: set on the pair, done for a side that was never saved', () => {
    expect(computeChecklist(null, CASH).items.find((i) => i.key === 'cutover')).toMatchObject({ done: true });
    expect(computeChecklist(side({ customerId: U1, supplierId: U1 }), NO_CUTOVER).complete).toBe(false);
  });

  it.each(['customer', 'supplier'] as const)('missing %s keeps it incomplete', (key) => {
    const full = { customerId: U1, supplierId: U1 };
    const broken = { customer: { customerId: null }, supplier: { supplierId: null } }[key];
    const c = computeChecklist(side({ ...full, ...broken }), CASH);
    expect(c.complete).toBe(false);
    expect(c.items.find((i) => i.key === key)?.done).toBe(false);
  });
});

/**
 * Dimensions Phase 1 — which CC1/CC2/BU a bank allocation stamps, and where.
 *
 * Brief §5.3: settlements and control-account lines carry none (explicit input
 * refused, card defaults ignored); the cost line takes the caller's dimensions,
 * else the card's defaults; dimensions never land on the bank or VAT line.
 */
import { describe, expect, it } from 'vitest';
import {
  planAllocationDimensions, stampContraDimensions,
} from '@/modules/accounting/services/bank/bankAllocationDimensions';
import { isBankAllocationRefusal } from '@/modules/accounting/services/bank/bankAllocationRefusal';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';

const CARD = { cc1Id: 'cc1-card', cc2Id: 'cc2-card', buId: 'bu-card' };

describe('planAllocationDimensions', () => {
  it('REFUSES explicit dimensions on a supplier payment / receipt / transfer', () => {
    let caught: unknown;
    try {
      planAllocationDimensions({ settlement: true, contraIsControl: false, explicit: { cc2Id: 'p' }, bankDefaults: {} });
    } catch (err) { caught = err; }
    expect(isBankAllocationRefusal(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/carries no CC1\/CC2\/BU/);
  });

  it('IGNORES the card defaults on a settlement (no refusal, nothing stamped)', () => {
    expect(planAllocationDimensions({ settlement: true, contraIsControl: false, explicit: {}, bankDefaults: CARD }))
      .toEqual({});
  });

  it('refuses explicit dimensions on a control-account contra (e.g. a VAT payment), ignores defaults there', () => {
    expect(() => planAllocationDimensions({
      settlement: false, contraIsControl: true, explicit: { buId: 'b' }, bankDefaults: {},
    })).toThrow(/control account/);
    expect(planAllocationDimensions({ settlement: false, contraIsControl: true, explicit: {}, bankDefaults: CARD }))
      .toEqual({});
  });

  it('paycard spend with no dimensions takes the card defaults', () => {
    expect(planAllocationDimensions({ settlement: false, contraIsControl: false, explicit: {}, bankDefaults: CARD }))
      .toEqual(CARD);
  });

  it('transaction beats default, default beats blank — per dimension', () => {
    expect(planAllocationDimensions({
      settlement: false, contraIsControl: false, explicit: { buId: 'bu-tx' }, bankDefaults: CARD,
    })).toEqual({ cc1Id: 'cc1-card', cc2Id: 'cc2-card', buId: 'bu-tx' });
  });

  it('an explicit project is never paired with the card default FNO (the FNO derives from the project)', () => {
    expect(planAllocationDimensions({
      settlement: false, contraIsControl: false, explicit: { cc2Id: 'cc2-tx' }, bankDefaults: CARD,
    })).toEqual({ cc2Id: 'cc2-tx', buId: 'bu-card' });
  });
});

describe('stampContraDimensions', () => {
  const lines: JournalLineInput[] = [
    { glAccountId: 'expense', debit: 100, credit: 0 },
    { glAccountId: 'vat-input', debit: 15, credit: 0, vatType: 'standard' },
    { glAccountId: 'bank', debit: 0, credit: 115 },
  ];

  it('stamps the cost line only — never the bank or VAT line', () => {
    const out = stampContraDimensions(lines, 'expense', { cc1Id: 'c1', cc2Id: 'c2', buId: 'b' });
    expect(out[0]).toMatchObject({ cc1Id: 'c1', cc2Id: 'c2', buId: 'b', costCenterId: 'c1' });
    expect(out[1]).toEqual(lines[1]);
    expect(out[2]).toEqual(lines[2]);
  });

  it('returns the lines untouched when there is nothing to stamp', () => {
    expect(stampContraDimensions(lines, 'expense', {})).toBe(lines);
    expect(stampContraDimensions(lines, null, { buId: 'b' })).toBe(lines);
  });
});

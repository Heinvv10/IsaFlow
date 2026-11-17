/** PE card payloads (review #1542 A1/S2): answers checked at run time, and a batch loop folded into one outcome. */
import { describe, expect, it } from 'vitest';
import { deliveriesOf, mergeOutcomes, outcomeOf, shouldContinue, stateOf } from '@/components/payroll/payslipEmailPayloads';

const w = (n: number) => ({ employeeId: `e${n}`, employeeNumber: `E-${n}`, employeeName: `Name ${n}` });

describe('payslip email payloads', () => {
  it('reads an outcome, dropping malformed rows', () => {
    const o = outcomeOf({ sent: [{ ...w(1), sha256: 'x', addressChanged: true }, { employeeId: 3 }], failed: [{ ...w(2), error: 'no' }],
      uncertain: [w(4)], skipped: [{ ...w(5), reason: 'NO_EMAIL' }], remaining: 2 });
    expect(o).toEqual({ sent: [{ ...w(1), addressChanged: true }], failed: [{ ...w(2), error: 'no' }], uncertain: [w(4)],
      skipped: [{ ...w(5), reason: 'NO_EMAIL' }], remaining: 2 });
    expect(outcomeOf(null).remaining).toBe(0);
    expect(() => stateOf({ platformEnabled: 'yes', enabled: true })).toThrow();
  });

  it('folds batches: lists add up, a later ALREADY_SENT for someone this loop handled is not a skip, remaining is the last', () => {
    const first = outcomeOf({ sent: [w(1)], uncertain: [w(2)], skipped: [{ ...w(9), reason: 'NO_EMAIL' }], remaining: 1 });
    const second = outcomeOf({ sent: [w(3)], skipped: [{ ...w(1), reason: 'ALREADY_SENT' }, { ...w(2), reason: 'ALREADY_SENT' },
      { ...w(9), reason: 'NO_EMAIL' }], remaining: 0 });
    const m = mergeOutcomes(first, second);
    expect(m.sent.map((x) => x.employeeId)).toEqual(['e1', 'e3']);
    expect(m.uncertain.map((x) => x.employeeId)).toEqual(['e2']);
    expect(m.skipped.map((x) => x.employeeId)).toEqual(['e9']);
    expect(m.remaining).toBe(0);
  });

  it('reads deliveries, refusing an unknown status', () => {
    expect(deliveriesOf([{ ...w(1), status: 'unknown', recipient: 'a@example.invalid', at: '2026-11-17T08:00:00Z', attempts: 2 },
      { ...w(2), status: 'bogus' }])).toEqual([{ ...w(1), status: 'unknown', recipient: 'a@example.invalid', at: '2026-11-17T08:00:00Z', attempts: 2 }]);
  });

  it('D-I1: the loop goes on only while something is left and the round made progress', () => {
    const o = (sent: number, remaining: number) => outcomeOf({ sent: Array.from({ length: sent }, (_, i) => w(i)), remaining });
    expect(shouldContinue(o(2, 1), Number.POSITIVE_INFINITY)).toBe(true);
    expect(shouldContinue(o(0, 0), 3)).toBe(false);
    expect(shouldContinue(o(0, 1), 3)).toBe(true); // nothing sent, but fewer left (failures moved on)
    expect(shouldContinue(o(0, 1), 1)).toBe(false); // nothing sent, nothing fell: stop
  });
});

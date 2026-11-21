/**
 * Rule A (#1701 round 6, the M1 fix): a customer note's DETACHED gross D (the share of its total that reversed no
 * invoice leg) is what its applications to invoices whose legs it did NOT reverse count there, in application order,
 * until D is used up. Applications to an invoice whose legs it reversed never count (the invoice sees the note by its
 * link / allocation rows). Exact cents: one rounding for D, and the counts sum to exactly min(applications, D).
 */
import { describe, expect, it } from 'vitest';
import {
  detachedCountChange, detachedCountDelta, detachedCounts, detachedGross, withPlannedApplications, type DetachedProfile,
} from '@/modules/accounting/services/ar/creditNoteDetached';

const profile = (detached: number, reversedOn: string[], apps: [string, number][]): DetachedProfile =>
  ({ detached, reversedOn, applications: apps.map(([invoiceId, cents]) => ({ invoiceId, cents })) });
const counts = (p: DetachedProfile) => Object.fromEntries(detachedCounts(p));

describe('detachedGross: D = total x (subtotal - reversed net) / subtotal, exact cents', () => {
  it.each([
    ['unlinked / late-linked (nothing reversed): the whole total', 23000, 20000, 0, 23000],
    ['typed-linked, fully on legs: 0', 11500, 10000, 10000, 0],
    ['legacy-linked 200 + 30 with 100 on X\'s leg, 100 excess: 115', 23000, 20000, 10000, 11500],
    ['legacy-linked 150 + 22.50 with 100 on legs: 57.50', 17250, 15000, 10000, 5750],
    // 100.01 x 53.70 / 87.03 = 61.709...: one rounding, half away from zero.
    ['odd subtotal 87.03, total 100.01, 33.33 reversed: 61.71', 10001, 8703, 3333, 6171],
    // 1.15 x 0.01 / 0.03 = 0.38333 -> 0.38; 1.15 x 0.02 / 0.03 = 0.7666 -> 0.77.
    ['0.03 subtotal, 0.02 reversed: 0.38', 115, 3, 2, 38],
    ['0.03 subtotal, 0.01 reversed: 0.77', 115, 3, 1, 77],
    // 0.05 x 1 / 2 = 0.025 -> 0.03 (half away from zero, BigInt, no float drift).
    ['the half cent rounds away from zero', 5, 2, 1, 3],
    ['a VAT-only note (subtotal 0): nothing reversed, the whole total', 1500, 0, 0, 1500],
    ['reversed past the subtotal (hand-made): 0, never negative', 11500, 10000, 12000, 0],
    ['above 2^53 when multiplied, still exact', 999999999999, 999999999998, 999999999997, 1],
    // 999999999999 x 777777777777 / 999999999998 = 777777777777.78 (a float product loses the last digits).
    ['and the large share: 9999999999.99 x 7777777777.77 / 9999999999.98', 999999999999, 999999999998, 222222222221, 777777777778],
  ] as const)('%s', (_l, total, subtotal, reversed, expected) => expect(detachedGross(total, subtotal, reversed)).toBe(expected));
});

describe('detachedCounts: in application order, until D is used up; reversed invoices never count', () => {
  it('the counter-example: N linked to X (100 excess, D 115) applied 115 to X then 115 to Y: Y counts 115', () => {
    expect(counts(profile(11500, ['x'], [['x', 11500], ['y', 11500]]))).toEqual({ y: 11500 });
  });
  it('the 180-vs-115 case: L linked to typed Y (D 0) spilling 65 onto W: W counts nothing', () => {
    expect(counts(profile(0, ['y'], [['y', 5000], ['w', 6500]]))).toEqual({ w: 0 });
  });
  it('an unlinked note late-linked to legacy Z (D = total), either order: Y counts its whole application', () => {
    expect(counts(profile(23000, [], [['y', 11500], ['z', 11500]]))).toEqual({ y: 11500, z: 11500 });
    expect(counts(profile(23000, [], [['z', 11500], ['y', 6000]]))).toEqual({ z: 11500, y: 6000 });
  });
  it('D used up in order: the first unreversed application takes it, the later one gets the rest, then nothing', () => {
    expect(counts(profile(5750, ['x'], [['x', 2000], ['y', 5750], ['w', 9500]]))).toEqual({ y: 5750, w: 0 });
    expect(counts(profile(5750, ['x'], [['x', 2000], ['y', 2000], ['w', 9500]]))).toEqual({ y: 2000, w: 3750 });
  });
  it('a reversed invoice\'s application uses none of D, wherever it sits in the order', () => {
    expect(counts(profile(5750, ['x'], [['y', 2000], ['x', 9999], ['w', 9500]]))).toEqual({ y: 2000, w: 3750 });
  });
  it('compares invoice ids case-insensitively (uuids)', () => {
    expect(counts(profile(100, ['ABC'], [['abc', 50], ['Y', 80]]))).toEqual({ y: 80 });
  });
  it('exact cents: with odd figures the counts sum to exactly D across many applications', () => {
    const d = detachedGross(10001, 8703, 3333);                          // 61.71
    const apps: [string, number][] = Array.from({ length: 17 }, (_, i) => [`i${i}`, 7 + (i % 5)]);
    apps.push(['last', 9999]);
    const sum = [...detachedCounts(profile(d, [], apps)).values()].reduce((a, b) => a + b, 0);
    expect(sum).toBe(d);
    // And never more than the applications when they are short of D.
    const short = [...detachedCounts(profile(d, [], apps.slice(0, 17))).values()].reduce((a, b) => a + b, 0);
    expect(short).toBe(apps.slice(0, 17).reduce((a, [, c]) => a + c, 0));
  });
  it('seeded: the counts never exceed D, never exceed each application, and equal min(sum of unreversed, D)', () => {
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let run = 0; run < 500; run++) {
      const ids = ['a', 'b', 'c', 'd'];
      const reversedOn = ids.filter(() => rnd(4) === 0);
      const apps = Array.from({ length: 1 + rnd(6) }, () => [ids[rnd(4)]!, 1 + rnd(20000)] as [string, number]);
      const d = rnd(30000);
      const out = detachedCounts(profile(d, reversedOn, apps));
      const unreversed = apps.filter(([id]) => !reversedOn.includes(id)).reduce((a, [, c]) => a + c, 0);
      expect([...out.values()].reduce((a, b) => a + b, 0)).toBe(Math.min(unreversed, d));
      for (const id of reversedOn) expect(out.get(id) ?? 0).toBe(0);
    }
  });
});

describe('withPlannedApplications / detachedCountDelta (the dry run\'s view of a back-fill landing)', () => {
  it('an existing row keeps its place (add-to-existing); new rows follow it, by invoice id', () => {
    const p = profile(5000, [], [['w', 1000]]);
    expect(withPlannedApplications(p, [{ invoiceId: 'z', cents: 100 }, { invoiceId: 'b', cents: 200 }, { invoiceId: 'w', cents: 300 }]).applications)
      .toEqual([{ invoiceId: 'w', cents: 1300 }, { invoiceId: 'b', cents: 200 }, { invoiceId: 'z', cents: 100 }]);
  });
  it('the delta: D 0 counts nothing; D left counts up to it; adding to an earlier row takes D from a later one', () => {
    expect(Object.fromEntries(detachedCountDelta(profile(0, ['y'], [['y', 5000]]), [{ invoiceId: 'w', cents: 6500 }]))).toEqual({ w: 0 });
    expect(Object.fromEntries(detachedCountDelta(profile(5000, [], [['y', 3000]]), [{ invoiceId: 'w', cents: 6500 }]))).toEqual({ y: 0, w: 2000 });
    expect(Object.fromEntries(detachedCountDelta(profile(5000, [], [['y', 3000], ['w', 4000]]), [{ invoiceId: 'y', cents: 1000 }])))
      .toEqual({ y: 1000, w: -1000 });
  });
  it('does not change the profile it is given', () => {
    const p = profile(5000, [], [['y', 3000]]);
    withPlannedApplications(p, [{ invoiceId: 'y', cents: 1000 }]);
    expect(p.applications).toEqual([{ invoiceId: 'y', cents: 3000 }]);
  });
});

describe('detachedCountChange (what an unapply or adjustment of existing applications moves)', () => {
  const p = profile(5750, ['x'], [['x', 2000], ['y', 5750], ['w', 9500]]);
  it('unapplying an earlier application moves D onto the later one', () => {
    expect(Object.fromEntries(detachedCountChange(p, new Map([['y', 0]])))).toEqual({ y: -5750, w: 5750 });
  });
  it('an adjustment down keeps its place and moves only what it frees', () => {
    expect(Object.fromEntries(detachedCountChange(p, new Map([['y', 3450]])))).toEqual({ y: -2300, w: 2300 });
  });
  it('the reversed invoice\'s application moves nothing; taking back everything only lowers', () => {
    expect(Object.fromEntries(detachedCountChange(p, new Map([['x', 0]])))).toEqual({ y: 0, w: 0 });
    expect([...detachedCountChange(p, new Map([['x', 0], ['y', 0], ['w', 0]])).values()].every((d) => d <= 0)).toBe(true);
  });
});
